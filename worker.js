// worker.js — serves the static site, plus the story-wall API

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function getApproved(env) {
  const raw = await env.STORIES.get("approved-list");
  return raw ? JSON.parse(raw) : [];
}

async function getPending(env) {
  const raw = await env.STORIES.get("pending-list");
  return raw ? JSON.parse(raw) : [];
}


// ---- lightweight, cookieless page-view logging -------------------------
// One KV key per view with an 8-day TTL. No IPs, no cookies, no identifiers,
// nothing that could tie a visit back to a person. Aggregate counts only.
const TRACK_PATHS = new Set(["/", "/index.html", "/newly-diagnosed-aml",
  "/newly-diagnosed-aml.html", "/aml-caregiver-guide", "/aml-caregiver-guide.html",
  "/llms.txt", "/sitemap.xml"]);

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function tidyRef(ref) {
  if (!ref) return "direct";
  try {
    const h = new URL(ref).hostname.replace(/^www\./, "");
    if (h.endsWith("nellyslegacyproject.com")) return "internal";
    return h;
  } catch { return "other"; }
}

// Known crawlers, grouped so the digest can say something useful.
const BOTS = [
  ["GPTBot", /GPTBot/i, "ai"],
  ["OAI-SearchBot", /OAI-SearchBot/i, "ai"],
  ["ChatGPT-User", /ChatGPT-User/i, "ai"],
  ["ClaudeBot", /ClaudeBot|anthropic-ai|Claude-Web/i, "ai"],
  ["PerplexityBot", /PerplexityBot|Perplexity-User/i, "ai"],
  ["Google-Extended", /Google-Extended/i, "ai"],
  ["Applebot-Extended", /Applebot-Extended/i, "ai"],
  ["Meta-ExternalAgent", /Meta-ExternalAgent|FacebookBot/i, "ai"],
  ["Bytespider", /Bytespider/i, "ai"],
  ["CCBot", /CCBot/i, "ai"],
  ["Amazonbot", /Amazonbot/i, "ai"],
  ["cohere-ai", /cohere-ai/i, "ai"],
  ["Googlebot", /Googlebot/i, "search"],
  ["Bingbot", /bingbot|BingPreview/i, "search"],
  ["DuckDuckBot", /DuckDuckBot|DuckAssistBot/i, "search"],
  ["Applebot", /Applebot/i, "search"],
  ["YandexBot", /YandexBot/i, "search"],
  ["Baiduspider", /Baiduspider/i, "search"],
  ["Facebook", /facebookexternalhit/i, "social"],
  ["Twitterbot", /Twitterbot/i, "social"],
  ["LinkedInBot", /LinkedInBot/i, "social"],
  ["Slackbot", /Slackbot/i, "social"],
  ["Discordbot", /Discordbot/i, "social"],
  ["Telegram", /TelegramBot/i, "social"],
  ["WhatsApp", /WhatsApp/i, "social"]
];

function classifyUA(ua) {
  for (const [name, re, kind] of BOTS) if (re.test(ua)) return { name, kind };
  if (/bot|crawl|spider|slurp|headless|curl|wget|lighthouse|python-requests|scrapy/i.test(ua))
    return { name: "other bot", kind: "other" };
  return null;
}

async function logView(request, env, ctx, pathname) {
  if (!TRACK_PATHS.has(pathname)) return;
  const ua = request.headers.get("user-agent") || "";
  const bot = classifyUA(ua);
  const path = pathname === "/index.html" ? "/" : pathname.replace(/\.html$/, "");

  if (bot) {
    // Deterministic key per bot + path + day. Idempotent: a repeat crawl just
    // rewrites the same key with a newer timestamp. No read-modify-write, so
    // no lost updates. Records presence, not exact volume - KV cannot do
    // atomic counters, and for crawlers "did it come?" is the useful signal.
    const key = `bot:${dayKey()}:${bot.kind}:${bot.name}:${path}`;
    ctx.waitUntil(env.STORIES.put(key, String(Date.now()),
      { expirationTtl: 60 * 60 * 24 * 8 }));
    return;
  }

  const entry = {
    p: path,
    r: tidyRef(request.headers.get("referer")),
    c: request.headers.get("cf-ipcountry") || "??",
    t: Date.now()
  };
  ctx.waitUntil(env.STORIES.put(`hit:${dayKey()}:${crypto.randomUUID()}`,
    JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 8 }));
}

async function collectBots(env, day) {
  const out = {};
  let cursor;
  do {
    const list = await env.STORIES.list({ prefix: `bot:${day}:`, cursor, limit: 1000 });
    for (const k of list.keys) {
      const parts = k.name.split(":");           // bot : day : kind : name : path
      if (parts.length < 5) continue;
      const kind = parts[2], name = parts[3], path = parts.slice(4).join(":");
      if (!out[name]) out[name] = { kind, paths: [] };
      if (!out[name].paths.includes(path)) out[name].paths.push(path);
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return out;
}

async function collectDay(env, day) {
  const out = { total: 0, paths: {}, refs: {}, countries: {} };
  let cursor;
  do {
    const list = await env.STORIES.list({ prefix: `hit:${day}:`, cursor, limit: 1000 });
    for (const k of list.keys) {
      const raw = await env.STORIES.get(k.name);
      if (!raw) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      out.total++;
      out.paths[e.p] = (out.paths[e.p] || 0) + 1;
      out.refs[e.r] = (out.refs[e.r] || 0) + 1;
      out.countries[e.c] = (out.countries[e.c] || 0) + 1;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return out;
}

function top(obj, n = 6) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

const PRETTY = {
  "/": "Home",
  "/newly-diagnosed-aml": "Just Diagnosed",
  "/aml-caregiver-guide": "Caregiver Guide"
};

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { skipped: "no telegram secrets" };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML",
                           disable_web_page_preview: true })
  });
  return { ok: res.ok, status: res.status };
}

// ---- lifetime + rolling totals -----------------------------------------
// Rolled forward once a day by the cron, so there is exactly one writer and
// no race. Individual hit records still expire after 8 days; these do not.
const TOTALS_KEY = "totals:all";

async function getTotals(env) {
  const raw = await env.STORIES.get(TOTALS_KEY);
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return { views: 0, days: 0, paths: {}, refs: {}, countries: {},
           bots: {}, best: { day: null, n: 0 }, firstDay: null, rolled: [] };
}

// Roll a single day into the lifetime record. Idempotent: a day already
// rolled is skipped, so a manual re-run cannot double-count.
async function rollDay(env, day, d, botNames) {
  const t = await getTotals(env);
  if (t.rolled.includes(day)) return t;
  t.views += d.total;
  t.days += 1;
  t.firstDay = t.firstDay || day;
  for (const [k, v] of Object.entries(d.paths))     t.paths[k]     = (t.paths[k] || 0) + v;
  for (const [k, v] of Object.entries(d.refs))      t.refs[k]      = (t.refs[k] || 0) + v;
  for (const [k, v] of Object.entries(d.countries)) t.countries[k] = (t.countries[k] || 0) + v;
  for (const b of botNames) t.bots[b] = (t.bots[b] || 0) + 1;
  if (d.total > t.best.n) t.best = { day, n: d.total };
  t.rolled.push(day);
  if (t.rolled.length > 400) t.rolled = t.rolled.slice(-400);
  await env.STORIES.put(TOTALS_KEY, JSON.stringify(t));
  return t;
}

// Sum the last N days still held in KV (records live 8 days).
async function lastNDays(env, n, endDay) {
  const end = new Date(endDay + "T00:00:00Z");
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = await collectDay(env, dayKey(new Date(end.getTime() - i * 864e5)));
    sum += d.total;
  }
  return sum;
}

const KIND_LABEL = { ai: "AI assistants", search: "Search engines", social: "Link previews", other: "Other bots" };

async function botSection(env, day) {
  const bots = await collectBots(env, day);
  const names = Object.keys(bots);
  if (!names.length) return "\n\n<b>Crawlers</b>\n  none seen";
  const groups = { ai: [], search: [], social: [], other: [] };
  for (const n of names) (groups[bots[n].kind] || groups.other).push(n);
  let out = "\n\n<b>Crawlers &amp; AI</b>";
  for (const k of ["ai", "search", "social", "other"]) {
    if (!groups[k].length) continue;
    out += `\n  <i>${KIND_LABEL[k]}</i>: ${groups[k].sort().join(", ")}`;
  }
  const llm = names.filter(n => bots[n].paths.includes("/llms.txt"));
  if (llm.length) out += `\n  <i>read llms.txt</i>: ${llm.sort().join(", ")}`;
  return out;
}

// Destinations that are Danell's own, versus resources she points people to.
const HERS = new Set(["tiktok.com", "youtube.com", "youtu.be", "facebook.com",
  "gofund.me", "amazon.com", "auntnellsfriends.com"]);

async function collectClicks(env, day) {
  const out = {};
  let cursor;
  do {
    const list = await env.STORIES.list({ prefix: `click:${day}:`, cursor, limit: 1000 });
    for (const k of list.keys) {
      const raw = await env.STORIES.get(k.name);
      if (!raw) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      out[e.d] = (out[e.d] || 0) + 1;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return out;
}

async function clickSection(env, day) {
  const c = await collectClicks(env, day);
  const names = Object.keys(c);
  if (!names.length) return "\n\n<b>Clicked out</b>\n  nobody clicked through";
  const mine = [], other = [];
  for (const n of names) (HERS.has(n) ? mine : other).push([n, c[n]]);
  mine.sort((a, b) => b[1] - a[1]); other.sort((a, b) => b[1] - a[1]);
  let out = "\n\n<b>Clicked out</b>";
  if (mine.length)  out += "\n  <i>Her channels</i>: " + mine.map(([n, v]) => `${n} (${v})`).join(", ");
  if (other.length) out += "\n  <i>Resources</i>: " + other.slice(0, 6).map(([n, v]) => `${n} (${v})`).join(", ");
  return out;
}

async function totalsSection(env, day, d) {
  const bots = await collectBots(env, day);
  const t = await rollDay(env, day, d, Object.keys(bots));
  const week = await lastNDays(env, 7, day);
  let out = `\n\n<b>Totals</b>`;
  out += `\n  Last 7 days — ${week}`;
  out += `\n  Since launch — ${t.views} across ${t.days} day${t.days === 1 ? "" : "s"}`;
  if (t.best.day) out += `\n  Best day — ${t.best.n} on ${t.best.day}`;
  const tp = top(t.paths, 3).map(([p, n]) => `${PRETTY[p] || p} ${n}`).join(", ");
  if (tp) out += `\n  Top pages all-time — ${tp}`;
  return out;
}

async function buildDigest(env, dayOverride) {
  const now = new Date();
  const y = new Date(now.getTime() - 864e5);
  const day = dayOverride || dayKey(y);
  const d = await collectDay(env, day);
  const prev = await collectDay(env, dayKey(new Date(now.getTime() - 2 * 864e5)));

  if (d.total === 0) {
    return `<b>Nelly's Legacy — ${day}</b>\n\nNo human visits recorded yesterday.`
      + await botSection(env, day) + await totalsSection(env, day, d);
  }
  const delta = prev.total ? Math.round(((d.total - prev.total) / prev.total) * 100) : null;
  const arrow = delta === null ? "" : delta > 0 ? ` (▲ ${delta}%)` : delta < 0 ? ` (▼ ${Math.abs(delta)}%)` : " (flat)";

  let msg = `<b>Nelly's Legacy — ${day}</b>\n`;
  msg += `<b>${d.total}</b> page view${d.total === 1 ? "" : "s"}${arrow}\n\n`;
  msg += `<b>Pages</b>\n`;
  for (const [p, n] of top(d.paths)) msg += `  ${PRETTY[p] || p} — ${n}\n`;
  msg += `\n<b>Came from</b>\n`;
  for (const [r, n] of top(d.refs)) msg += `  ${r} — ${n}\n`;
  const countries = top(d.countries, 5).map(([c, n]) => `${c} ${n}`).join(", ");
  msg += `\n<b>Where</b>\n  ${countries}`;
  msg += await clickSection(env, day);
  msg += await botSection(env, day);
  msg += await totalsSection(env, day, d);
  return msg;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const text = await buildDigest(env);
      await sendTelegram(env, text);
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Public: live count of actively recruiting AML trials ---
    if (url.pathname === "/api/trials-count" && request.method === "GET") {
      const cacheKey = new Request(url.toString(), request);
      const cache = caches.default;
      let cached = await cache.match(cacheKey);
      if (cached) return cached;

      try {
        const ctgUrl = "https://clinicaltrials.gov/api/v2/studies?query.cond=Acute%20Myeloid%20Leukemia&filter.overallStatus=RECRUITING&countTotal=true&pageSize=1";
        const res = await fetch(ctgUrl, { headers: { "accept": "application/json" } });
        if (!res.ok) throw new Error("upstream error");
        const data = await res.json();
        const response = json({ count: data.totalCount || 0, updatedAt: new Date().toISOString() });
        response.headers.set("cache-control", "public, max-age=21600"); // 6 hours
        await cache.put(cacheKey, response.clone());
        return response;
      } catch (e) {
        return json({ count: null, error: "unavailable" }, 200);
      }
    }

    // --- Outbound click beacon (public, fire-and-forget) ---
    if (url.pathname === "/api/click" && request.method === "POST") {
      let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
      const dest = String(b.d || "").slice(0, 60).replace(/[^a-z0-9.\-]/gi, "");
      const from = String(b.f || "").slice(0, 60);
      if (!dest) return json({ ok: false }, 400);
      const ua = request.headers.get("user-agent") || "";
      if (classifyUA(ua)) return json({ ok: true, skipped: "bot" });
      ctx.waitUntil(env.STORIES.put(`click:${dayKey()}:${crypto.randomUUID()}`,
        JSON.stringify({ d: dest, f: from, t: Date.now() }),
        { expirationTtl: 60 * 60 * 24 * 8 }));
      return json({ ok: true });
    }

    // --- Submit a story (public) ---
    if (url.pathname === "/api/submit-story" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad request" }, 400); }
      const name = (body.name || "").toString().slice(0, 80).trim();
      const story = (body.story || "").toString().slice(0, 4000).trim();
      const yearsOut = (body.yearsOut || "").toString().slice(0, 40).trim();
      if (!story || story.length < 20) {
        return json({ error: "Story is too short." }, 400);
      }
      const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const entry = { id, name: name || "Anonymous", story, yearsOut, submittedAt: new Date().toISOString() };
      const pending = await getPending(env);
      pending.push(entry);
      await env.STORIES.put("pending-list", JSON.stringify(pending));
      return json({ ok: true });
    }

    // --- Public: list approved stories ---
    if (url.pathname === "/api/stories" && request.method === "GET") {
      const approved = await getApproved(env);
      return json({ stories: approved.slice().reverse() });
    }

    // --- Admin: view pending, approve/reject ---
    if (url.pathname === "/admin/stories") {
      const key = url.searchParams.get("key");
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return new Response("Not authorized.", { status: 401 });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const action = form.get("action");
        const id = form.get("id");
        const pending = await getPending(env);
        const idx = pending.findIndex((p) => p.id === id);
        if (idx !== -1) {
          const [entry] = pending.splice(idx, 1);
          await env.STORIES.put("pending-list", JSON.stringify(pending));
          if (action === "approve") {
            const approved = await getApproved(env);
            approved.push(entry);
            await env.STORIES.put("approved-list", JSON.stringify(approved));
          }
        }
        return Response.redirect(url.origin + "/admin/stories?key=" + encodeURIComponent(key), 303);
      }

      const pending = await getPending(env);
      const approved = await getApproved(env);
      const rows = pending.length
        ? pending.map((p) => `
          <div style="border:1px solid #ccc;border-radius:10px;padding:16px;margin-bottom:14px;">
            <strong>${escapeHtml(p.name)}</strong> ${p.yearsOut ? `— ${escapeHtml(p.yearsOut)}` : ""}
            <p style="white-space:pre-wrap;margin:10px 0;">${escapeHtml(p.story)}</p>
            <form method="POST" style="display:inline;">
              <input type="hidden" name="id" value="${escapeHtml(p.id)}">
              <button name="action" value="approve" style="background:#2F6B7A;color:#fff;border:0;padding:8px 16px;border-radius:6px;margin-right:8px;">Approve</button>
              <button name="action" value="reject" style="background:#999;color:#fff;border:0;padding:8px 16px;border-radius:6px;">Reject</button>
            </form>
          </div>`).join("")
        : "<p>No pending submissions.</p>";

      return new Response(`
        <html><head><title>Story Wall Admin</title>
        <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;}</style>
        </head><body>
        <h1>Pending Submissions (${pending.length})</h1>
        ${rows}
        <h2>Approved (${approved.length})</h2>
        <p>${approved.map((a) => escapeHtml(a.name)).join(", ") || "None yet."}</p>
        </body></html>
      `, { headers: { "content-type": "text/html" } });
    }

    // --- Manual digest preview (admin) ---
    if (url.pathname === "/admin/digest") {
      const key = url.searchParams.get("key");
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Not authorized.", { status: 401 });
      const text = await buildDigest(env, url.searchParams.get("day"));
      const send = url.searchParams.get("send") === "1" ? await sendTelegram(env, text) : { sent: false };
      return new Response(text.replace(/<[^>]+>/g, "") + "\n\n" + JSON.stringify(send),
        { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // --- Everything else: serve the static site ---
    await logView(request, env, ctx, url.pathname);
    return env.ASSETS.fetch(request);
  }
};
