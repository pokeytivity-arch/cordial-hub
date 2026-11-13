// Phone reminder for messages you have not opened: once a message has sat unseen for 6 hours you get a push,
// then another every 6 hours until you open the chat. Never between 23:00 and 05:59 Nigerian time.
// Runs every 30 minutes (schedule in netlify.toml). Same Netlify variables as push.js.
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const GAP = 6 * 3600e3;
const WAT = 3600e3;
const BOT_ID = "cordial_ai";

async function getJson(path) { const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function readDoc(key) { return ((await getJson(`docs?key=eq.${encodeURIComponent(key)}&select=data`))[0] || {}).data || null; }
async function writeDoc(key, collection, id, data) {
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, collection, id, data }) });
}

exports.handler = async () => {
  if (!URL_ || !KEY || !process.env.VAPID_PRIVATE_KEY) return { statusCode: 501, body: "not_configured" };
  const now = Date.now();
  const hr = new Date(now + WAT).getUTCHours();
  if (hr >= 23 || hr < 6) return { statusCode: 200, body: "quiet hours" };

  const members = await getJson("members?select=user_id,name,is_owner,grp");
  const rows = await getJson("docs?collection=eq.messages&select=data&order=created_at.desc&limit=600");
  const msgs = rows.map((r) => r.data || {}).filter((m) => m.ts && now - m.ts < 14 * 86400e3 && m.by && m.by !== BOT_ID && m.kind !== "sys");
  const profs = await getJson("docs?collection=eq.profiles&select=key,data&limit=500");
  const prof = {}; for (const p of profs) prof[p.key] = p.data || {};
  const state = prof["profiles/unseenremind"] || {};
  const nameOf = (id) => ((members.find((m) => m.user_id === id) || {}).name || "Someone").split(" ")[0];
  let sent = 0, changed = false;

  for (const mem of members) {
    const uid = mem.user_id;
    if (mem.is_owner && mem.grp !== "parent") { if (state[uid]) { delete state[uid]; changed = true; } continue; } // the Cordial owner account only observes: it cannot open the family chats, so it is never reminded
    const lp = prof[`profiles/cp_${uid}`];
    if (!lp) continue;
    const read = lp.read || {}, since = lp.since || 0, arch = lp.arch || [], mute = lp.mute || [];
    // messages for this person that they have not opened
    const unseen = msgs.filter((m) => {
      if (m.by === uid) return false;
      const chat = m.chat || "family";
      if (chat.indexOf("dm_") === 0 && chat.indexOf(uid) < 0) return false;
      if (chat.indexOf("dm_") !== 0 && chat !== "family") {
        const g = prof[`profiles/chat_${chat}`];
        if (!g || !(g.members || []).includes(uid)) return false;
      }
      if (arch.includes(chat) || mute.includes(chat)) return false;
      return m.ts > Math.max(read[chat] || 0, since, lp.ack || 0);
    });
    if (!unseen.length) { if (state[uid]) { delete state[uid]; changed = true; } continue; }
    const oldest = Math.min(...unseen.map((m) => m.ts));
    const last = state[uid] || 0;
    if (now - oldest < GAP || now - last < GAP) continue;
    const subs = Array.isArray(lp.push) ? lp.push : [];
    if (!subs.length) continue;
    const newest = unseen.sort((a, b) => b.ts - a.ts)[0];
    const n = unseen.length;
    const payload = {
      kind: "reminder",
      title: `${n} unread ${n === 1 ? "message" : "messages"}`,
      body: n === 1 ? `${nameOf(newest.by)} sent you a message you haven’t opened yet.` : `You have messages you haven’t opened yet, the latest from ${nameOf(newest.by)}.`,
      tag: "unseen-" + uid,
      url: "/?chat=" + (newest.chat || "family"),
    };
    const keep = []; let ok = false;
    for (const s of subs) {
      if (!s || !s.endpoint || !s.keys) continue;
      let st = 0; try { st = await push._sendOne(s, payload); } catch { st = 0; }
      if (st >= 200 && st < 300) { sent++; ok = true; }
      if (st !== 404 && st !== 410) keep.push(s);
    }
    if (keep.length !== subs.length) { lp.push = keep; await writeDoc(`profiles/cp_${uid}`, "profiles", `cp_${uid}`, lp); }
    if (ok) { state[uid] = now; changed = true; }
  }
  if (changed) await writeDoc("profiles/unseenremind", "profiles", "unseenremind", state);
  return { statusCode: 200, body: JSON.stringify({ sent }) };
};
