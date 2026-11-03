// Removes stories (status updates) older than 7 days: the video file in storage, the photo data, and the story itself.
// Stories are separate from feed posts, so feed posts are never touched here (only docs with wa = 1).
// Runs once a day (schedule in netlify.toml). Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const WEEK = 7 * 24 * 3600e3;

exports.handler = async () => {
  if (!URL_ || !KEY) return { statusCode: 501, body: "not_configured" };
  const now = Date.now();
  let rows = [];
  try {
    const r = await fetch(`${URL_}/rest/v1/docs?collection=eq.posts&data->>wa=eq.1&select=key,data`, { headers: H });
    rows = r.ok ? await r.json() : [];
  } catch (e) { return { statusCode: 502, body: "lookup_failed" }; }
  let files = 0, docs = 0;
  for (const row of rows) {
    const d = row.data || {};
    if (!(now - (d.ts || 0) > WEEK)) continue;
    if (d.vpath) {
      // only ever touch files that belong to stories
      if (!/^chat\/[^/]*story-/.test(d.vpath)) continue;
      try {
        const dr = await fetch(`${URL_}/storage/v1/object/files/${d.vpath.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE", headers: H });
        if (dr.ok || dr.status === 404 || dr.status === 400) files++;
        else continue; // keep the row so the next run tries again
      } catch (e) { continue; }
    }
    if (d.mid) {
      try { await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent("media/" + d.mid)}`, { method: "DELETE", headers: H }); } catch (e) {}
    }
    try {
      const xr = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(row.key)}`, { method: "DELETE", headers: H });
      if (xr.ok) docs++;
    } catch (e) {}
  }
  return { statusCode: 200, body: JSON.stringify({ checked: rows.length, filesDeleted: files, rowsDeleted: docs }) };
};
