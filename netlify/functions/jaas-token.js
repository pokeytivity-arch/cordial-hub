// Signs a short-lived call pass for your own Jitsi account (8x8 JaaS).
// Environment variables in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// JAAS_APP_ID (looks like vpaas-magic-cookie-xxxx), JAAS_KID (the API key id, looks like vpaas-magic-cookie-xxxx/abcd12),
// JAAS_PRIVATE_KEY (the whole private key text, from -----BEGIN ... to -----END ...).
// The private key never goes in the web page. It lives only here, on the server.
const crypto = require("crypto");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = process.env.JAAS_APP_ID;
const KID = process.env.JAAS_KID;
const PK = (process.env.JAAS_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const out = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY || !APP || !KID || !PK) return out(501, { error: "not_configured" });

  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin" });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin" });
  const me = await who.json();

  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=name,grp,is_owner`, { headers: admin });
  const m = (mr.ok ? await mr.json() : [])[0];
  if (!m) return out(403, { error: "forbidden" });
  if (!m.is_owner) {
    const pr = await fetch(`${URL_}/rest/v1/group_permissions?grp=eq.${encodeURIComponent(m.grp)}&feature=eq.calls&select=can_view,can_edit`, { headers: admin });
    const p = (pr.ok ? await pr.json() : [])[0];
    if (!p || !(p.can_view || p.can_edit)) return out(403, { error: "forbidden" });
  }

  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch {}
  const room = String(b.room || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 60);
  if (!room) return out(400, { error: "bad" });

  const now = Math.floor(Date.now() / 1000);
  const moderator = m.is_owner || m.grp === "parent" || m.grp === "guardian";
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const payload = {
    aud: "jitsi", iss: "chat", sub: APP, room,
    iat: now, nbf: now - 10, exp: now + 3 * 3600,
    context: {
      user: { id: me.id, name: m.name || "Member", email: me.email || "", moderator: moderator ? "true" : "false" },
      features: { livestreaming: "false", recording: "false", transcription: "false", "outbound-call": "false", "sip-outbound-call": "false" },
    },
  };
  try {
    const data = `${b64(header)}.${b64(payload)}`;
    const sig = crypto.sign("RSA-SHA256", Buffer.from(data), PK).toString("base64url");
    return out(200, { jwt: `${data}.${sig}`, appId: APP });
  } catch (e) {
    return out(500, { error: "sign_failed", message: "The call key could not be read. Check JAAS_PRIVATE_KEY in Netlify." });
  }
};
