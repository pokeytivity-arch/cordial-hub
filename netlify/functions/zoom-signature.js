// Signs a short-lived Zoom Meeting SDK pass so hub members can join the Zoom call inside the hub.
// Netlify environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ZOOM_SDK_KEY (the Client ID of your Meeting SDK app), ZOOM_SDK_SECRET (its Client Secret),
// ZOOM_MEETING_NUMBER (optional, default 83026513168), ZOOM_MEETING_PASSCODE (optional, only if the meeting has one).
// The secret never goes in the web page. It lives only here, on the server.
const crypto = require("crypto");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SDK_KEY = process.env.ZOOM_SDK_KEY;
const SDK_SECRET = process.env.ZOOM_SDK_SECRET;
const MN = String(process.env.ZOOM_MEETING_NUMBER || "83026513168").replace(/\D/g, "");
const PWD = process.env.ZOOM_MEETING_PASSCODE || "";

const out = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY || !SDK_KEY || !SDK_SECRET) return out(501, { error: "not_configured" });

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

  const now = Math.floor(Date.now() / 1000) - 30;
  const exp = now + 2 * 3600;
  const payload = { appKey: SDK_KEY, sdkKey: SDK_KEY, mn: MN, role: 0, iat: now, exp, tokenExp: exp };
  try {
    const data = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
    const sig = crypto.createHmac("sha256", SDK_SECRET).update(data).digest("base64url");
    return out(200, { signature: `${data}.${sig}`, sdkKey: SDK_KEY, meetingNumber: MN, password: PWD, name: m.name || "Member" });
  } catch (e) {
    return out(500, { error: "sign_failed" });
  }
};
