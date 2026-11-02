// Extra YouTube channels for the hub's timeline (besides Streams of Joy NSPPD).
// Each channel is found from one video link (the "seed"), then its newest video and live status are saved
// so the hub can show a card with "Watch here". Runs every 15 minutes (netlify.toml) and when the hub asks.
// Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional: YT_EXTRA_SEEDS = comma-separated video ids.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEEDS = String(process.env.YT_EXTRA_SEEDS || "GkIAp6nj5vY,qihY3KKkbfw").split(",").map((s) => s.trim()).filter(Boolean);
const KEYNAME = "profiles/yt_extra";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const dec = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const CH = (t) => (t.match(/"channelId":"(UC[\w-]{22})"/) || t.match(/"externalId":"(UC[\w-]{22})"/) || t.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || t.match(/itemprop="channelId" content="(UC[\w-]{22})"/) || [])[1] || "";

async function channelOf(vid) {
  try { const t = await (await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`, { headers: UA })).text(); const c = CH(t); if (c) return c; } catch {}
  try {
    const o = await (await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + vid)}&format=json`, { headers: UA })).json();
    if (o.author_url) { const t = await (await fetch(o.author_url, { headers: UA })).text(); const c = CH(t); if (c) return c; }
  } catch {}
  return "";
}
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
  const saved = await readSaved(), now = Date.now();
  if (saved.checked && now - saved.checked < 5 * 60 * 1000 && (saved.channels || []).length) return out(200, { ok: true, cached: true });
  const prev = {}; (saved.channels || []).forEach((c) => { prev[c.seed] = c; });
  const res = [];
  for (const seed of SEEDS) {
    const old = prev[seed] || {};
    let ch = old.channelId || await channelOf(seed);
    if (!ch) { if (old.vid) res.push(old); continue; }
    let vid = "", title = "", pub = now, name = "";
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`, { headers: UA });
      if (r.ok) {
        const xml = await r.text(), entry = (xml.match(/<entry>[\s\S]*?<\/entry>/) || [""])[0];
        vid = (entry.match(/<yt:videoId>([\w-]{6,20})<\/yt:videoId>/) || [])[1] || "";
        title = dec((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]).trim().slice(0, 200);
        pub = Date.parse((entry.match(/<published>([^<]+)<\/published>/) || [])[1] || "") || now;
        name = dec((xml.match(/<author>\s*<name>([\s\S]*?)<\/name>/) || [])[1]).trim().slice(0, 80);
      }
    } catch {}
    if (!vid) {
      try { const t = await (await fetch(`https://www.youtube.com/channel/${ch}/videos`, { headers: UA })).text(); const v = t.match(/"videoId":"([\w-]{11})"/); if (v) vid = v[1]; } catch {}
    }
    if (!vid) vid = old.vid || seed;
    const liveVid = await liveVideo(ch);
    res.push({
      seed, channelId: ch, channel: name || old.channel || "YouTube", vid, title: title || old.title || "",
      url: `https://www.youtube.com/watch?v=${vid}`, live: `https://www.youtube.com/channel/${ch}/live`,
      liveNow: !!liveVid, liveVid, published: pub, seen: old.vid === vid ? (old.seen || now) : now,
    });
  }
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: KEYNAME, collection: "profiles", id: "yt_extra", data: { channels: res, checked: now } }),
  });
  return out(200, { ok: true, channels: res.map((c) => c.channel) });
};
