// (HTTP version: the app calls /api/feed. daily-feed.js runs it on a schedule.)
// Finds the newest video / live stream of a YouTube channel (Streams of Joy NSPPD) and saves its link
// so the Cordial chat can show a "Watch today" card. Runs every day at 7:00 am Nigerian time (06:00 UTC),
// and the app can also ask it to refresh (at most once every 10 minutes).
// Environment variables in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional: YT_CHANNEL_ID (starts with UC), YT_SEED_VIDEO (any video id from the channel; default by4HnBk9Kg0).
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEED = process.env.YT_SEED_VIDEO || "by4HnBk9Kg0";
const KEYNAME = "profiles/cordial_daily";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const dec = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function channelFromVideo(vid) {
  const r = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`, { headers: UA });
  const t = await r.text();
  const m = t.match(/"channelId":"(UC[\w-]{22})"/) || t.match(/"externalId":"(UC[\w-]{22})"/) || t.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || t.match(/itemprop="channelId" content="(UC[\w-]{22})"/);
  return m ? m[1] : "";
}

async function channelFromHandle(vid) {
  // fallback: video page -> oEmbed gives the channel page address -> read the channel id from that page
  const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + vid)}&format=json`, { headers: UA });
  if (!o.ok) return "";
  const j = await o.json();
  if (!j.author_url) return "";
  const t = await (await fetch(j.author_url, { headers: UA })).text();
  const m = t.match(/"channelId":"(UC[\w-]{22})"/) || t.match(/"externalId":"(UC[\w-]{22})"/) || t.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || t.match(/itemprop="channelId" content="(UC[\w-]{22})"/);
  return m ? m[1] : "";
}

// Is the channel streaming right now? Reads the channel's "/live" page. Returns the live video id or "".
async function liveVideo(ch) {
  try {
    const t = await (await fetch(`https://www.youtube.com/channel/${ch}/live`, { headers: UA })).text();
    if (!/"isLiveNow":true|"isLive":true/.test(t)) return "";
    const m = t.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/) || t.match(/"videoId":"([\w-]{11})"/);
    return m ? m[1] : "";
  } catch { return ""; }
}

async function readSaved() {
  const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(KEYNAME)}&select=data`, { headers: H });
  return ((r.ok ? await r.json() : [])[0] || {}).data || {};
}

exports.handler = async (event) => {
  if (!URL_ || !KEY) return out(501, { error: "not_configured" });
  const saved = await readSaved();
  const now = Date.now();
  // during the 7:00 am-12:00 weekday window (Nigerian time) check more often
  const lagos = new Date(now + 3600 * 1000), wk = lagos.getUTCDay() >= 1 && lagos.getUTCDay() <= 5, inWin = wk && lagos.getUTCHours() >= 7 && lagos.getUTCHours() < 12;
  const gap = (inWin ? 2 : 10) * 60 * 1000;
  if (!event.force && saved.checked && now - saved.checked < gap && saved.vid) return out(200, { ok: true, cached: true, title: saved.title, url: saved.url });

  let ch = (process.env.YT_CHANNEL_ID || saved.channelId || "").trim();
  try { if (!ch) ch = await channelFromVideo(SEED); } catch {}
  try { if (!ch) ch = await channelFromHandle(SEED); } catch {}
  if (!ch) return out(502, { error: "channel_not_found" });

  // 1) the channel's public video feed (two tries), 2) the channel's Videos page as a backup
  let vid = "", title = "", pub = now, chName = "", why = "";
  for (let i = 0; i < 2 && !vid; i++) {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`, { headers: UA });
      if (!r.ok) { why = "feed_" + r.status; continue; }
      const xml = await r.text();
      const entry = (xml.match(/<entry>[\s\S]*?<\/entry>/) || [""])[0];
      vid = (entry.match(/<yt:videoId>([\w-]{6,20})<\/yt:videoId>/) || [])[1] || "";
      title = dec((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]).trim().slice(0, 200);
      pub = Date.parse((entry.match(/<published>([^<]+)<\/published>/) || [])[1] || "") || now;
      chName = dec((xml.match(/<author>\s*<name>([\s\S]*?)<\/name>/) || [])[1]).trim().slice(0, 80);
    } catch (e) { why = "feed_error"; }
  }
  if (!vid) {
    try {
      const t = await (await fetch(`https://www.youtube.com/channel/${ch}/videos`, { headers: UA })).text();
      const v = t.match(/"videoId":"([\w-]{11})"/);
      const tt = t.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
      if (v) { vid = v[1]; title = tt ? JSON.parse('"' + tt[1] + '"') : ""; }
    } catch { why = why || "videos_page_failed"; }
  }
  if (!vid) {
    // nothing worked this time: keep showing what we already have instead of an error
    if (saved.vid) { await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: KEYNAME, collection: "profiles", id: "cordial_daily", data: { ...saved, checked: now - 5 * 60 * 1000 } }) }); return out(200, { ok: true, stale: true, why }); }
    return out(502, { error: "feed_failed", why });
  }
  const liveVid = await liveVideo(ch);
  const data = {
    liveNow: !!liveVid, liveVid,
    channelId: ch, channel: chName || saved.channel || "YouTube", vid, title,
    url: `https://www.youtube.com/watch?v=${vid}`, live: `https://www.youtube.com/channel/${ch}/live`,
    published: pub, seen: saved.vid === vid ? (saved.seen || now) : now, checked: now,
  };
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: KEYNAME, collection: "profiles", id: "cordial_daily", data }),
  });
  return out(200, { ok: true, title, url: data.url, channel: data.channel });
};
