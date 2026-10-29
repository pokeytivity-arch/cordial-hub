// Owner-only helper: invites people by email, makes one-time invite links, and removes people.
// It needs two environment variables in Netlify: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// The service key never goes in the web page. It lives only here, on the server.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROUPS = ["parent", "guardian", "family", "nanny", "lawyer", "mediator", "therapist", "gal"];

const out = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY) return out(500, { error: "not_configured" });

  // 1. Who is asking? They must be signed in AND be an owner.
  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin", message: "Please sign in again." });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin", message: "Please sign in again." });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=is_owner`, { headers: admin });
  const mrows = mr.ok ? await mr.json() : [];
  if (!mrows[0] || !mrows[0].is_owner) return out(403, { error: "forbidden", message: "Only the owner can do this." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return out(400, { error: "bad", message: "Bad request." }); }

  // Only send people back to this site.
  const host = event.headers["x-forwarded-host"] || event.headers.host || "";
  let redirect = "";
  try { const u = new URL(b.redirectTo); if (u.host === host) redirect = u.origin + u.pathname; } catch {}
  if (!redirect) redirect = process.env.URL || "";

  if (b.action === "remove") {
    if (!b.user_id || b.user_id === me.id) return out(400, { error: "bad", message: "You can’t remove yourself." });
    const t = await fetch(`${URL_}/rest/v1/members?user_id=eq.${encodeURIComponent(b.user_id)}&select=is_owner`, { headers: admin });
    const trows = t.ok ? await t.json() : [];
    if (trows[0] && trows[0].is_owner) return out(400, { error: "bad", message: "You can’t remove an owner." });
    const r = await fetch(`${URL_}/auth/v1/admin/users/${encodeURIComponent(b.user_id)}`, { method: "DELETE", headers: admin });
    return r.ok ? out(200, { ok: true }) : out(502, { error: "failed", message: "Couldn’t remove them." });
  }

  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return out(400, { error: "bad", message: "That email doesn’t look right." });
  const grp = GROUPS.includes(b.grp) ? b.grp : "family";
  const name = String(b.name || "").trim().slice(0, 40);
  const data = { name, grp };

  // Only one co-parent: the owner plus one more parent. Once both slots are used, nobody else can be a parent.
  if (grp === "parent") {
    const pr = await fetch(`${URL_}/rest/v1/members?grp=eq.parent&select=user_id`, { headers: admin });
    const parents = pr.ok ? await pr.json() : [];
    if (parents.length >= 2) {
      let already = false;
      if (b.action === "link") {
        const er = await fetch(`${URL_}/rest/v1/member_private?email=eq.${encodeURIComponent(email)}&select=user_id`, { headers: admin });
        const eu = er.ok ? await er.json() : [];
        already = eu.some((x) => parents.some((p) => p.user_id === x.user_id));
      }
      if (!already) return out(409, { error: "slot", message: "The co-parent slot is already used. Only one co-parent can be in the hub." });
    }
  }

  if (b.action === "invite") {
    const r = await fetch(`${URL_}/auth/v1/invite${redirect ? `?redirect_to=${encodeURIComponent(redirect)}` : ""}`, {
      method: "POST", headers: admin, body: JSON.stringify({ email, data }),
    });
    if (r.ok) return out(200, { ok: true });
    const j = await r.json().catch(() => ({}));
    const msg = j.msg || j.message || "";
    if (/already|registered|exists/i.test(msg)) return out(409, { error: "exists", message: "That person already has an account. Use “Get invite link” to send them a fresh sign-in link." });
    if (/rate|limit/i.test(msg)) return out(429, { error: "rate", message: "Too many emails sent. Wait a while, or use “Get invite link”." });
    return out(502, { error: "failed", message: msg || "The invite email couldn’t be sent. Try “Get invite link”." });
  }

  if (b.action === "link") {
    const gen = (type) => fetch(`${URL_}/auth/v1/admin/generate_link`, {
      method: "POST", headers: admin, body: JSON.stringify({ type, email, data, redirect_to: redirect || undefined }),
    });
    let r = await gen("invite");
    if (!r.ok) r = await gen("recovery");            // already has an account: give a set-password link
    const j = await r.json().catch(() => ({}));
    const link = j.action_link || (j.properties && j.properties.action_link);
    return link ? out(200, { ok: true, link }) : out(502, { error: "failed", message: j.msg || j.message || "Couldn’t make a link." });
  }

  return out(400, { error: "bad", message: "Unknown request." });
};
