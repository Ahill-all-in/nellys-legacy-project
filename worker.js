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

export default {
  async fetch(request, env) {
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

    // --- Everything else: serve the static site ---
    return env.ASSETS.fetch(request);
  }
};
