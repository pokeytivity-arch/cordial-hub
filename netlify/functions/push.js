// Sends phone alerts (Web Push) so a call rings even when the app is closed.
// Environment variables in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (for example mailto:you@example.com).
const crypto = require("crypto");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUB = (process.env.VAPID_PUBLIC_KEY || "").trim();
const PRIV = (process.env.VAPID_PRIVATE_KEY || "").trim();
const SUBJ = (process.env.VAPID_SUBJECT || "mailto:admin@example.com").trim();

const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

function vapidHeader(endpoint) {
  const pub = unb64u(PUB);
  const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: PRIV }, format: "jwk" });
  const data = `${b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJ }))}`;
  const sig = crypto.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${data}.${b64u(sig)}, k=${PUB}`;
}

// RFC 8291 (aes128gcm) encryption of the message for one phone.
function encrypt(sub, text) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(ua);
  const salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
exports._encrypt = encrypt;
exports._sendOne = (...a) => sendOne(...a);

async function sendOne(sub, payload) {
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { Authorization: vapidHeader(sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "60", Urgency: "high" },
    body: encrypt(sub, JSON.stringify(payload)),
  });
  return r.status;
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") return PUB ? out(200, { key: PUB }) : out(501, { error: "not_configured" });
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY || !PUB || !PRIV) return out(501, { error: "not_configured" });

  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin" });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin" });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?select=user_id,name`, { headers: admin });
  const members = mr.ok ? await mr.json() : [];
  const sender = members.find((m) => m.user_id === me.id);
  if (!sender) return out(403, { error: "forbidden" });

  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch {}
  const kind = b.kind === "missed" ? "missed" : b.kind === "msg" ? "msg" : b.kind === "task" ? "task" : "call";
  const ids = (Array.isArray(b.to) ? b.to : []).map(String).filter((id) => id !== me.id && members.some((m) => m.user_id === id)).slice(0, 10);
  if (!ids.length) return out(200, { sent: 0 });
  const audio = !!b.audio;
  const label = audio ? "voice" : "video";
  const callId = String(b.callId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  const chat = String(b.chat || "family").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
  const payload = kind === "task"
    ? { kind: "task", title: clip(b.title, 80) || "Task update", body: clip(b.body, 160), tag: "task-" + String(b.tag || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40), url: "/?goto=meet" }
    : kind === "call"
    ? { kind, title: sender.name || "Someone", body: `Incoming ${label} call`, tag: "call-" + callId, url: "/?ring=" + callId }
    : kind === "msg"
      ? { kind, title: clip(b.title, 80) || sender.name || "New message", body: clip(b.body, 160), tag: "chat-" + chat, url: "/?chat=" + chat }
      : { kind, title: sender.name || "Someone", body: `📞 Missed ${label} call`, tag: "call-" + callId, url: "/?chat=" + chat };

  let sent = 0;
  for (const uid of ids) {
    const key = `profiles/cp_${uid}`;
    const rr = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: admin });
    const row = (rr.ok ? await rr.json() : [])[0];
    const data = (row && row.data) || {};
    if (kind === "msg" && Array.isArray(data.mute) && data.mute.indexOf(chat) >= 0) continue;
    const subs = Array.isArray(data.push) ? data.push : [];
    const keep = [];
    for (const s of subs) {
      if (!s || !s.endpoint || !s.keys) continue;
      let st = 0;
      try { st = await sendOne(s, payload); } catch { st = 0; }
      if (st >= 200 && st < 300) sent++;
      if (st !== 404 && st !== 410) keep.push(s);
    }
    if (keep.length !== subs.length) {
      data.push = keep;
      await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
        method: "POST", headers: { ...admin, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, collection: "profiles", id: `cp_${uid}`, data }),
      });
    }
  }
  return out(200, { sent });
};
