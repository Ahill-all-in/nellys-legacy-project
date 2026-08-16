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
  "/gift-travel", "/gift-travel.html",
  "/more-ways-to-help", "/more-ways-to-help.html",
  "/first-days-with-aml", "/first-days-with-aml.html",
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
// ---- Aunt Nell quote collection over Telegram ---------------------------
const QUOTE_PROMPTS = [
  "What does she do that no other grown-up does?",
  "What is the funniest thing she has ever done?",
  "If you were telling a friend about her, what would you say?",
  "What is your favourite thing she reads or makes up?",
  "What do you feel like when she is around?",
  "What is the best place she has ever taken you, and what did you do there?"
];

async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return r.json().catch(() => null);
}

async function listQuotes(env, state) {
  const raw = await env.STORIES.get(`quotes-${state}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveQuote(env, entry) {
  const p = await listQuotes(env, "pending");
  p.push(entry);
  await env.STORIES.put("quotes-pending", JSON.stringify(p));
}

async function handleTelegramUpdate(env, update) {
  const m = update.message;
  if (!m) return;
  const chatId = m.chat.id;
  const from = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(" ") || "someone";
  const text = (m.text || m.caption || "").trim();

  // Deep link t.me/NellysLegacy_Bot?start=quote jumps straight to a question
  if (/^\/start\s+quote/.test(text)) {
    const q = QUOTE_PROMPTS[Math.floor(Date.now() / 60000) % QUOTE_PROMPTS.length];
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text:
      "<b>Aunt Nell's Friends</b>\n\nDanell reads stories to kids, and we are collecting little " +
      "quotes from children about her for her website.\n\nAsk yours this \u2014 use whatever they " +
      `call her, <b>Aunt Nell</b> or <b>NoNo</b>:\n\n<b>${q}</b>\n\n` +
      "Send me their answer in their own words. Nothing goes public until Austin approves it." });
    return;
  }
  if (/^\/start/.test(text)) {
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text:
      "<b>Aunt Nell's Friends</b>\n\nThis bot collects little quotes from kids about Aunt Nell \u2014 NoNo, if that is what yours calls her \u2014 " +
      "to put on her site so other families know she is worth a watch.\n\n" +
      "Send <b>/quote</b> and I will give you a question to ask your kid. Then just type " +
      "what they say and send it, with their first name at the end if you like.\n\n" +
      "Nothing goes public until Austin approves it." });
    return;
  }
  if (/^\/quote/.test(text)) {
    const q = QUOTE_PROMPTS[Math.floor(Date.now() / 60000) % QUOTE_PROMPTS.length];
    await tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text:
      `Ask them this \u2014 use whatever they call her, <b>Aunt Nell</b> or <b>NoNo</b> \u2014 then send me `
      + `their answer word for word:\n\n<b>${q}</b>\n\n` +
      "<i>Their exact words beat a tidy version every time. Wonky grammar is the point.</i>" });
    return;
  }
  if (m.voice || m.audio) {
    await tg(env, "sendMessage", { chat_id: chatId, text:
      "Got the voice note — Austin will hear it in Telegram. If you can also type roughly what they said, send that and I will save it as a quote." });
    return;
  }
  if (text.length < 3) return;

  await saveQuote(env, {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    text: text.slice(0, 600),
    from: from.slice(0, 60),
    chatId,
    at: new Date().toISOString()
  });
  await tg(env, "sendMessage", { chat_id: chatId, text:
    "Saved, thank you. Austin will look at it before anything goes on the site." });
  if (env.TELEGRAM_CHAT_ID && String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
    await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML",
      text: `<b>New Aunt Nell quote</b> from ${from}\n\n“${text.slice(0, 400)}”\n\nApprove at /admin/quotes` });
  }
}

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


function photosAdminPage(key, slides, hash, configured) {
  const data = JSON.stringify({ key, slides, hash }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Photos &mdash; Danell's Journey</title>
<style>
  :root{--ink:#152530;--paper:#F1EFE7;--teal:#2F6B7A;--teal-deep:#153447;--gold:#C9A66B;--line:#D7DCD5;}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--paper);
    color:var(--ink);margin:0;padding:24px 16px 80px;line-height:1.55;}
  .wrap{max-width:760px;margin:0 auto;}
  h1{font-size:1.5rem;margin:0 0 4px;color:var(--teal-deep);}
  p.sub{margin:0 0 24px;color:#5A6E75;font-size:.95rem;}
  .warn{background:#FBF0EE;border:2px solid #C97F73;border-radius:12px;padding:16px 18px;margin-bottom:22px;}
  .warn code{background:#fff;padding:2px 6px;border-radius:4px;font-size:.85rem;}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px;
    display:flex;gap:14px;align-items:flex-start;}
  .card img{width:110px;height:138px;object-fit:cover;border-radius:8px;background:#eee;flex:0 0 auto;}
  .fields{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;}
  label{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:#6A7B80;font-weight:700;}
  input[type=text]{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:.95rem;}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:.88rem;}
  button:hover{background:#F3F6F3;}
  button.primary{background:var(--teal-deep);color:#fff;border-color:var(--teal-deep);font-weight:600;}
  button.danger{color:#9A3B32;}
  #drop{border:2px dashed var(--line);border-radius:14px;padding:28px;text-align:center;color:#5A6E75;
    background:#fff;margin-bottom:18px;}
  #drop.over{border-color:var(--teal);background:#F0F5F3;}
  #status{position:fixed;left:0;right:0;bottom:0;background:var(--teal-deep);color:#fff;padding:12px 16px;
    text-align:center;font-size:.92rem;transform:translateY(100%);transition:transform .2s;}
  #status.show{transform:none;}
  .hint{font-size:.82rem;color:#6A7B80;margin-top:-4px;}
</style></head><body><div class="wrap">
<h1>Photos</h1>
<p class="sub">These are the photos in the slideshow at the top of the home page. Add one straight from your phone &mdash; iPhone photos are fine, they get converted automatically.</p>
${configured ? "" : `<div class="warn"><strong>Not connected yet.</strong><br>
  Cloudflare Images needs three secrets before uploads will work:
  <code>CF_ACCOUNT_ID</code>, <code>CF_IMAGES_TOKEN</code>, <code>CF_IMAGES_HASH</code>.
  You can still reorder and edit captions below.</div>`}
<div id="drop">
  <p style="margin:0 0 10px"><strong>Add a photo</strong></p>
  <input type="file" id="file" accept="image/*" multiple>
  <p class="hint" style="margin:10px 0 0">Drag and drop works too. Max 10&nbsp;MB each.</p>
</div>
<div id="list"></div>
<div class="row" style="margin-top:18px">
  <button class="primary" id="save">Save changes</button>
  <a href="/" target="_blank" style="font-size:.88rem;color:var(--teal);">View the site &rarr;</a>
</div>
</div>
<div id="status"></div>
<script>
var S = ${data};
var list = document.getElementById('list');
function say(m, ms){ var s=document.getElementById('status'); s.textContent=m; s.classList.add('show');
  clearTimeout(say.t); say.t=setTimeout(function(){s.classList.remove('show');}, ms||2600); }
function url(id){ return S.hash ? 'https://imagedelivery.net/'+S.hash+'/'+id+'/public' : ''; }
function render(){
  list.innerHTML='';
  if(!S.slides.length){ list.innerHTML='<p style="color:#6A7B80">No photos yet &mdash; the site is showing its built-in ones.</p>'; return; }
  S.slides.forEach(function(s, i){
    var d=document.createElement('div'); d.className='card';
    d.innerHTML='<img src="'+url(s.id)+'" alt="">'+
      '<div class="fields">'+
      '<div><label>Caption</label><input type="text" data-f="cap" value="'+(s.cap||'').replace(/"/g,'&quot;')+'"></div>'+
      '<div><label>Description for screen readers</label><input type="text" data-f="alt" value="'+(s.alt||'').replace(/"/g,'&quot;')+'"></div>'+
      '<div><label>Vertical focus (0% top &ndash; 100% bottom)</label><input type="text" data-f="pos" value="'+(s.pos||'center 50%')+'"></div>'+
      '<div class="row"><button data-a="up">&uarr; Up</button><button data-a="down">&darr; Down</button>'+
      '<button class="danger" data-a="del">Remove</button></div></div>';
    d.querySelectorAll('input').forEach(function(inp){
      inp.addEventListener('input', function(){ S.slides[i][inp.dataset.f]=inp.value; });
    });
    d.querySelector('[data-a=up]').onclick=function(){ if(i>0){ var t=S.slides[i-1]; S.slides[i-1]=S.slides[i]; S.slides[i]=t; render(); } };
    d.querySelector('[data-a=down]').onclick=function(){ if(i<S.slides.length-1){ var t=S.slides[i+1]; S.slides[i+1]=S.slides[i]; S.slides[i]=t; render(); } };
    d.querySelector('[data-a=del]').onclick=function(){ if(confirm('Remove this photo from the slideshow?')){ S.slides.splice(i,1); render(); } };
    list.appendChild(d);
  });
}
async function upload(file){
  if(file.size > 10*1024*1024){ say(file.name+' is over 10 MB'); return; }
  say('Uploading '+file.name+'…', 60000);
  var r = await fetch('/api/photos/upload-url?key='+encodeURIComponent(S.key), {method:'POST'});
  var j = await r.json();
  if(!j.uploadURL){ say(j.error || 'Could not get an upload link'); return; }
  var fd = new FormData(); fd.append('file', file);
  var up = await fetch(j.uploadURL, {method:'POST', body:fd});
  if(!up.ok){ say('Upload failed'); return; }
  S.slides.push({id:j.id, cap:'', alt:'', pos:'center 50%'});
  render(); say('Added. Remember to Save.');
}
document.getElementById('file').addEventListener('change', function(e){
  [].slice.call(e.target.files).forEach(upload); e.target.value='';
});
var drop=document.getElementById('drop');
['dragenter','dragover'].forEach(function(ev){ drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add('over');}); });
['dragleave','drop'].forEach(function(ev){ drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove('over');}); });
drop.addEventListener('drop', function(e){ [].slice.call(e.dataTransfer.files).forEach(upload); });
document.getElementById('save').onclick=async function(){
  say('Saving…', 30000);
  var r = await fetch('/api/photos/save?key='+encodeURIComponent(S.key),
    {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({slides:S.slides})});
  var j = await r.json();
  say(j.ok ? ('Saved '+j.count+' photo'+(j.count===1?'':'s')+'. Refresh the site to see it.') : (j.error||'Save failed'));
};
render();
</script></body></html>`;
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

    // --- Telegram webhook ---
    if (url.pathname === "/api/tg" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!env.TG_WEBHOOK_SECRET || secret !== env.TG_WEBHOOK_SECRET) {
        return new Response("no", { status: 401 });
      }
      let update; try { update = await request.json(); } catch { return json({ ok: true }); }
      ctx.waitUntil(handleTelegramUpdate(env, update));
      return json({ ok: true });
    }

    // --- Admin: approve Aunt Nell quotes ---
    if (url.pathname === "/admin/quotes") {
      const key = url.searchParams.get("key");
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Not authorized.", { status: 401 });
      if (request.method === "POST") {
        const form = await request.formData();
        const id = form.get("id"), action = form.get("action");
        const pending = await listQuotes(env, "pending");
        const idx = pending.findIndex(q => q.id === id);
        if (idx !== -1) {
          const [q] = pending.splice(idx, 1);
          await env.STORIES.put("quotes-pending", JSON.stringify(pending));
          if (action === "approve") {
            const ok = await listQuotes(env, "approved");
            ok.push(q);
            await env.STORIES.put("quotes-approved", JSON.stringify(ok));
          }
        }
        return Response.redirect(url.origin + "/admin/quotes?key=" + encodeURIComponent(key), 303);
      }
      const pending = await listQuotes(env, "pending");
      const approved = await listQuotes(env, "approved");
      const rows = pending.length ? pending.map(q => `
        <div style="border:1px solid #ccc;border-radius:10px;padding:16px;margin-bottom:14px;">
          <strong>${escapeHtml(q.from)}</strong> <span style="color:#888;">${escapeHtml(q.at.slice(0,10))}</span>
          <p style="white-space:pre-wrap;font-size:1.1rem;">“${escapeHtml(q.text)}”</p>
          <form method="POST" style="display:inline;">
            <input type="hidden" name="id" value="${escapeHtml(q.id)}">
            <button name="action" value="approve" style="background:#2F6B7A;color:#fff;border:0;padding:8px 16px;border-radius:6px;margin-right:8px;">Approve</button>
            <button name="action" value="reject" style="background:#999;color:#fff;border:0;padding:8px 16px;border-radius:6px;">Reject</button>
          </form>
        </div>`).join("") : "<p>Nothing waiting.</p>";
      return new Response(`<html><head><title>Aunt Nell Quotes</title>
        <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;}</style></head><body>
        <h1>Pending quotes (${pending.length})</h1>${rows}
        <h2>Approved (${approved.length})</h2>
        ${approved.map(q => `<p>“${escapeHtml(q.text)}” <em>— ${escapeHtml(q.from)}</em></p>`).join("") || "<p>None yet.</p>"}
        </body></html>`, { headers: { "content-type": "text/html" } });
    }

    // --- Public: approved quotes ---
    // ---------- PHOTOS: Cloudflare Images ----------
    // Everything here degrades to nothing if the secrets or KV config are absent,
    // so the public site keeps serving its built-in photos.
    const PHOTOS_KEY = "photos:hero";

    if (url.pathname === "/api/photos" && request.method === "GET") {
      const raw = await env.STORIES.get(PHOTOS_KEY);
      if (!raw) return json({ slides: [] });
      let cfg;
      try { cfg = JSON.parse(raw); } catch (e) { return json({ slides: [] }); }
      const hash = env.CF_IMAGES_HASH;
      if (!hash || !Array.isArray(cfg.slides)) return json({ slides: [] });
      return json({
        slides: cfg.slides.map(s => ({
          src: `https://imagedelivery.net/${hash}/${s.id}/public`,
          alt: s.alt || "",
          cap: s.cap || "",
          pos: s.pos || "center 50%"
        }))
      });
    }

    // one-time upload URL so the file never streams through the Worker
    if (url.pathname === "/api/photos/upload-url" && request.method === "POST") {
      const key = url.searchParams.get("key");
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
      if (!env.CF_ACCOUNT_ID || !env.CF_IMAGES_TOKEN) {
        return json({ error: "Cloudflare Images is not configured yet. Missing CF_ACCOUNT_ID or CF_IMAGES_TOKEN." }, 500);
      }
      const form = new FormData();
      form.append("requireSignedURLs", "false");
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v2/direct_upload`,
        { method: "POST", headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` }, body: form });
      const data = await r.json();
      if (!data.success) return json({ error: "Cloudflare rejected the request", detail: data.errors }, 502);
      return json({ id: data.result.id, uploadURL: data.result.uploadURL });
    }

    if (url.pathname === "/api/photos/save" && request.method === "POST") {
      const key = url.searchParams.get("key");
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
      if (!body || !Array.isArray(body.slides)) return json({ error: "slides must be an array" }, 400);
      if (body.slides.length > 12) return json({ error: "twelve photos is plenty" }, 400);
      const clean = body.slides
        .filter(s => s && typeof s.id === "string" && s.id.length && s.id.length < 200)
        .map(s => ({
          id: s.id,
          alt: String(s.alt || "").slice(0, 300),
          cap: String(s.cap || "").slice(0, 200),
          pos: /^center \d{1,3}%$/.test(s.pos || "") ? s.pos : "center 50%"
        }));
      await env.STORIES.put(PHOTOS_KEY, JSON.stringify({ slides: clean, updated: Date.now() }));
      return json({ ok: true, count: clean.length });
    }

    if (url.pathname === "/admin/photos") {
      const key = url.searchParams.get("key") || "";
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Not authorized.", { status: 401 });
      const raw = await env.STORIES.get(PHOTOS_KEY);
      let slides = [];
      try { slides = raw ? (JSON.parse(raw).slides || []) : []; } catch (e) { slides = []; }
      const hash = env.CF_IMAGES_HASH || "";
      const configured = !!(env.CF_ACCOUNT_ID && env.CF_IMAGES_TOKEN && hash);
      return new Response(photosAdminPage(key, slides, hash, configured),
        { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    if (url.pathname === "/api/quotes" && request.method === "GET") {
      return json({ quotes: (await listQuotes(env, "approved")).map(q => ({ text: q.text, from: q.from })) });
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
