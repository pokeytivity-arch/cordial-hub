// Finds the newest post of the baby shop's public Instagram page, so the hub can show it big at the top.
// The app calls /api/shoplatest when someone opens "Latest posts" (at most once every 20 minutes).
// Environment variables in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const UA = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", "Accept-Language": "en-US,en;q=0.9" };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

async function readDoc(key) {
  const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: H });
  return ((r.ok ? await r.json() : [])[0] || {}).data || {};
}

exports.handler = async (event) => {
  const debug = !!(event && event.queryStringParameters && event.queryStringParameters.debug);
  if (!URL_ || !KEY) return out(501, { error: "not_configured" });
  const shop = await readDoc("profiles/cordial_shop");
  const handle = String(shop.handle || "one_stop_baby_shop").replace(/[^\w.]/g, "").slice(0, 40);
  const saved = await readDoc("profiles/cordial_shoplatest");
  const now = Date.now();
  if (!debug && saved.handle === handle && saved.checked && now - saved.checked < 20 * 60 * 1000) return out(200, { ok: true, cached: true, code: saved.code });

  const log = {};
  let first = null;

  // Way 1: Instagram's public profile data (newest by date, ignoring pinned posts)
  try {
    const r = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, {
      headers: { ...UA, "X-IG-App-ID": "936619743392459", "X-Requested-With": "XMLHttpRequest", Accept: "*/*", Referer: `https://www.instagram.com/${handle}/` },
    });
    log.api = r.status;
    if (r.ok) {
      const j = await r.json();
      const edges = (((j.data || {}).user || {}).edge_owner_to_timeline_media || {}).edges || [];
      const nodes = edges.map((e) => e.node).filter((n) => n && n.shortcode);
      nodes.sort((a, b) => (b.taken_at_timestamp || 0) - (a.taken_at_timestamp || 0));
      if (nodes[0]) first = { kind: "p", code: nodes[0].shortcode, ts: (nodes[0].taken_at_timestamp || 0) * 1000 };
    }
  } catch (e) { log.api = "error"; }

  // Way 2: the profile's embed page (first post listed; may be a pinned one)
  if (!first) {
    try {
      const r = await fetch(`https://www.instagram.com/${handle}/embed/`, { headers: UA });
      log.embed = r.status;
      if (r.ok) {
        const html = await r.text();
        log.len = html.length;
        const re = /(?:\\?\/)(p|reel|tv)(?:\\?\/)([A-Za-z0-9_-]{8,14})(?=[\\\/"?&'])/g;
        let m;
        while ((m = re.exec(html))) { if (m[2] !== "embed") { first = { kind: m[1], code: m[2] }; break; } }
      }
    } catch (e) { log.embed = "error"; }
  }
  if (!first) return out(502, { error: "no_post_found", log });
  if (debug) return out(200, { ok: true, debug: true, log, first });

  const data = { handle, kind: first.kind, code: first.code, checked: now, seen: saved.code === first.code ? (saved.seen || now) : now };
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "profiles/cordial_shoplatest", collection: "profiles", id: "cordial_shoplatest", data }),
  });
  return out(200, { ok: true, code: first.code, kind: first.kind });
};
