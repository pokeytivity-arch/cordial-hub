// Shared by feed.js and feed-extra.js: tells everyone's phones when a YouTube channel goes live and when the live ends.
// Not a web address itself. Same Netlify variables as push.js (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_*).
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" };

async function getJson(path) { const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function writeDoc(key, collection, id, data) {
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, collection, id, data }) });
}

// title of a video (live or not) and whether it can still be watched
async function videoInfo(vid) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + vid)}&format=json`, { headers: UA, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { title: "", available: r.status >= 500 };
    const j = await r.json();
    return { title: String(j.title || "").slice(0, 160), available: true };
  } catch { return { title: "", available: true }; }
}

// send one message to every phone that has alerts on
async function notifyAll(payload) {
  if (!URL_ || !KEY || !process.env.VAPID_PRIVATE_KEY) return 0;
  const profs = await getJson("docs?collection=eq.profiles&key=like.profiles/cp_*&select=key,data&limit=500");
  let sent = 0;
  for (const p of profs) {
    const lp = p.data || {}, subs = Array.isArray(lp.push) ? lp.push : [];
    if (!subs.length) continue;
    const keep = [];
    for (const s of subs) {
      if (!s || !s.endpoint || !s.keys) continue;
      let st = 0; try { st = await push._sendOne(s, payload); } catch { st = 0; }
      if (st >= 200 && st < 300) sent++;
      if (st !== 404 && st !== 410) keep.push(s);
    }
    if (keep.length !== subs.length) { lp.push = keep; await writeDoc(p.key, "profiles", p.key.replace("profiles/", ""), lp); }
  }
  return sent;
}

// Compare the saved state of a channel with what we just found. Returns extra fields to save.
// old = previously saved channel data; cur = { channel, liveVid }.
async function liveTransition(old, cur) {
  const extra = { liveTitle: old.liveTitle || "", notedLive: old.notedLive || "", notedEnd: old.notedEnd || "", lastLive: old.lastLive || null };
  const name = cur.channel || old.channel || "YouTube";
  // Live alerts for the pastors' channels (NSPPD, Pastor Jerry) are switched off. Set YT_NOTIFY=1 in Netlify to turn them back on.
  if (process.env.YT_NOTIFY !== "1") return extra;
  try {
    if (cur.liveVid) {
      if (cur.liveVid !== old.liveVid || !extra.liveTitle) extra.liveTitle = (await videoInfo(cur.liveVid)).title || extra.liveTitle;
      if (extra.notedLive !== cur.liveVid) {
        const sent = await notifyAll({ kind: "live", title: `🔴 ${name} is live`, body: extra.liveTitle || "Watch now", tag: "yt-live-" + cur.liveVid, url: "/?yt=" + cur.liveVid });
        extra.notedLive = cur.liveVid;
        extra.liveSent = sent;
      }
    } else if (old.liveNow && old.liveVid && extra.notedEnd !== old.liveVid) {
      const info = await videoInfo(old.liveVid);
      const title = extra.liveTitle || info.title || "";
      await notifyAll({ kind: "live", title: `${name}’s live has ended`, body: (title ? title + " · " : "") + (info.available ? "Tap to watch the replay" : "The replay isn’t available"), tag: "yt-end-" + old.liveVid, url: "/?yt=" + old.liveVid });
      extra.notedEnd = old.liveVid;
      extra.lastLive = { vid: old.liveVid, title, ts: Date.now(), available: info.available };
      extra.liveTitle = "";
    }
  } catch (e) {}
  return extra;
}

exports.liveTransition = liveTransition;
exports.videoInfo = videoInfo;
exports.handler = async () => ({ statusCode: 404, body: "not_a_page" });
