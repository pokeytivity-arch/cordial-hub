// Extra YouTube channels for the hub's timeline (besides Streams of Joy NSPPD).
// Each channel is found from one video link (the "seed"), then its newest video and live status are saved
// so the hub can show a card with "Watch here". Runs every 15 minutes (netlify.toml) and when the hub asks.
// Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional: YT_EXTRA_SEEDS = comma-separated video ids.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ytn = require("./yt-notify.js");
const SEEDS = String(process.env.YT_EXTRA_SEEDS || "GkIAp6nj5vY,qihY3KKkbfw").split(",").map((s) => s.trim()).filter(Boolean);
const KEYNAME = "profiles/yt_extra";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const dec = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const CH = (t) => (t.match(/"channelId":"(UC[\w-]{22})"/) || t.match(/"externalId":"(UC[\w-]{22})"/) || t.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || t.match(/itemprop="channelId" content="(UC[\w-]{22})"/) || [])[1] || "";

async function channelOf(vid) {
  try { const t = await (await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`, { headers: UA, signal: AbortSignal.timeout(5000) })).text(); const c = CH(t); if (c) return c; } catch {}
  try {
    const o = await (await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + vid)}&format=json`, { headers: UA, signal: AbortSignal.timeout(5000) })).json();
    if (o.author_url) { const t = await (await fetch(o.author_url, { headers: UA, signal: AbortSignal.timeout(5000) })).text(); const c = CH(t); if (c) return c; }
  } catch {}
  return "";
}
async function liveVideo(ch) {
  try {
    const t = await (await fetch(`https://www.youtube.com/channel/${ch}/live`, { headers: UA, signal: AbortSignal.timeout(5000) })).text();
    if (!/"isLiveNow":true|"isLive":true/.test(t)) return "";
    const m = t.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,20})"/) || t.match(/"videoId":"([\w-]{11})"/);
    return m ? m[1] : "";
  } catch { return ""; }
}
async function readSaved() {
  const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(KEYNAME)}&select=data`, { headers: H });
  return ((r.ok ? await r.json() : [])[0] || {}).data || {};
}

async function run(event) {
  if (!URL_ || !KEY) return out(501, { error: "not_configured" });
  const saved = await readSaved(), now = Date.now();
  const force = !!((event.queryStringParameters || {}).force);
  if (!force && saved.checked && now - saved.checked < 5 * 60 * 1000 && (saved.channels || []).length) return out(200, { ok: true, cached: true });
  const prev = {}; (saved.channels || []).forEach((c) => { prev[c.seed] = c; });
  const why = {};
  // all channels at the same time, so it finishes well inside Netlify's time limit
  const got = await Promise.all(SEEDS.map(async (seed) => {
    const old = prev[seed] || {};
    try {
      let ch = old.channelId || await channelOf(seed);
      if (!ch) { why[seed] = "channel_not_found"; return old.vid ? old : null; }
      let vid = "", title = "", pub = now, name = "";
      const [feedRes, liveVid] = await Promise.all([
        fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`, { headers: UA, signal: AbortSignal.timeout(5000) }).then(async (r) => { why[seed] = "feed_" + r.status; return r.ok ? await r.text() : ""; }).catch(() => ""),
        liveVideo(ch),
      ]);
      if (feedRes) {
        const entry = (feedRes.match(/<entry>[\s\S]*?<\/entry>/) || [""])[0];
        vid = (entry.match(/<yt:videoId>([\w-]{6,20})<\/yt:videoId>/) || [])[1] || "";
        title = dec((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]).trim().slice(0, 200);
        pub = Date.parse((entry.match(/<published>([^<]+)<\/published>/) || [])[1] || "") || now;
        name = dec((feedRes.match(/<author>\s*<name>([\s\S]*?)<\/name>/) || [])[1]).trim().slice(0, 80);
      }
      if (!vid) {
        try { const t = await (await fetch(`https://www.youtube.com/channel/${ch}/videos`, { headers: UA, signal: AbortSignal.timeout(5000) })).text(); const v = t.match(/"videoId":"([\w-]{11})"/); if (v) vid = v[1]; } catch {}
      }
      if (!vid) vid = old.vid || seed;
      const chName = name || old.channel || "YouTube";
      const extra = await ytn.liveTransition(old, { channel: chName, liveVid });
      return {
        seed, channelId: ch, channel: chName, vid, title: title || old.title || "",
        url: `https://www.youtube.com/watch?v=${vid}`, live: `https://www.youtube.com/channel/${ch}/live`,
        liveNow: !!liveVid, liveVid, published: pub, seen: old.vid === vid ? (old.seen || now) : now, ...extra,
      };
    } catch (e) { why[seed] = "error"; return old.vid ? old : null; }
  }));
  const res = got.filter(Boolean);
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: KEYNAME, collection: "profiles", id: "yt_extra", data: { channels: res, checked: now } }),
  });
  return out(res.length ? 200 : 502, { ok: res.length > 0, channels: res.map((c) => c.channel), why });
};

exports.handler = async (event) => {
  try { return await run(event); } catch (e) { return out(500, { ok: false, error: "crashed", message: String((e && e.message) || e) }); }
};
