// One-time notice from Cordial to everyone: the hub has a new address and the old app stops working.
// Runs from the cron; sends once (flag in settings/moveNotice) from 8:00 am Nigerian time on Saturday 21 Nov 2026.
// An owner can also POST to it to send immediately.
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const START = Date.UTC(2026, 10, 21, 7, 0); // 08:00 Nigeria time
const END = Date.UTC(2026, 10, 24, 0, 0);

const TEXT = `📢 Cordial Coparent has a new address

The old app will stop working at 12 midnight on Monday, 23 November 2026. Please move to the new one before then.

New link: https://cordialcoparent.com

How to add it to your Home Screen

iPhone (use Safari):
1. Open https://cordialcoparent.com in Safari.
2. Tap the Share button (the square with an arrow pointing up) at the bottom of the screen.
3. Scroll down and tap "Add to Home Screen".
4. Tap "Add" at the top right.
5. Open the new Cordial Coparent icon and sign in with your usual email and password.
6. When asked, tap "Allow" for notifications, so calls and messages reach you.

Android (use Chrome):
1. Open https://cordialcoparent.com in Chrome.
2. Tap the three dots at the top right.
3. Tap "Add to Home screen" (or "Install app"), then tap "Add" or "Install".
4. Open the new icon and sign in with your usual email and password.
5. Allow notifications when asked.

Your messages, photos, documents and records are all there already. After you have signed in on the new icon, you can delete the old one.`;

async function getJson(path) { const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function readDoc(key) { return ((await getJson(`docs?key=eq.${encodeURIComponent(key)}&select=data`))[0] || {}).data || {}; }
async function writeDoc(key, data) {
  const i = key.indexOf("/");
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, collection: key.slice(0, i), id: key.slice(i + 1), data, updated_at: new Date().toISOString() }) });
}

async function run(force) {
  if (!URL_ || !KEY) return { ok: false, reason: "not_configured" };
  const now = Date.now();
  if (!force && (now < START || now >= END)) return { ok: true, skipped: "not_time" };
  const flag = await readDoc("settings/moveNotice");
  if (flag.sent && !force) return { ok: true, skipped: "already_sent" };
  await writeDoc("settings/moveNotice", { sent: now }); // claim it first so two runs never both send
  const cur = await readDoc("profiles/cordial_summaries");
  let items = Array.isArray(cur.items) ? cur.items : [];
  items = items.filter((x) => x.id !== "move_notice");
  items.push({ id: "move_notice", kind: "notice", label: "New address", text: TEXT, ts: now });
  await writeDoc("profiles/cordial_summaries", { ...cur, items: items.slice(-24) });
  const members = await getJson("members?select=user_id");
  let sent = 0;
  for (const m of members) {
    const lp = await readDoc(`profiles/cp_${m.user_id}`);
    const subs = Array.isArray(lp.push) ? lp.push : [];
    const keep = [];
    for (const s of subs) {
      if (!s || !s.endpoint || !s.keys) continue;
      let st = 0;
      try { st = await push._sendOne(s, { kind: "summary", title: "📢 Cordial Coparent has a new address", body: "The old app stops working at 12 midnight on Monday 23 Nov. Tap for the new link and how to add it to your Home Screen.", tag: "move-notice", url: "/?chat=cordial_ai" }); } catch {}
      if (st >= 200 && st < 300) sent++;
      if (st !== 404 && st !== 410) keep.push(s);
    }
    if (keep.length !== subs.length) { lp.push = keep; await writeDoc(`profiles/cp_${m.user_id}`, lp); }
  }
  return { ok: true, posted: true, pushed: sent };
}
exports.run = run;
exports.TEXT = TEXT;

exports.handler = async (event) => {
  if (event.httpMethod === "POST") {
    const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
    if (!token) return out(401, { error: "signin" });
    const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!who.ok) return out(401, { error: "signin" });
    const me = await who.json();
    const m = (await getJson(`members?user_id=eq.${me.id}&select=is_owner`))[0];
    if (!m || !m.is_owner) return out(403, { error: "forbidden" });
    return out(200, await run(true));
  }
  return out(200, await run(false));
};
