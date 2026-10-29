// Evening recap: summarizes the day's YouTube session (from its public captions, when available)
// and adds encouraging words. Saved for the Cordial chat. Runs at 8:00 pm Nigerian time via evening-recap.js.
// The owner can also run it now from the Cordial chat (POST /api/recap).
// Environment variables in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (optional ANTHROPIC_MODEL).
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+1; SOCS=CAI" };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

async function readDoc(key) {
  const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: H });
  return ((r.ok ? await r.json() : [])[0] || {}).data || {};
}
async function writeDoc(key, data) {
  const [collection, id] = key.split("/");
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, collection, id, data }),
  });
}

// Public captions (best effort). Returns "" when none are available.
async function captionTracksViaApp(vid) {
  // YouTube's own app interface usually still hands out captions to servers
  try {
    const page = await (await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`, { headers: UA })).text();
    const k = (page.match(/"INNERTUBE_API_KEY":"([\w-]+)"/) || [])[1];
    const r = await fetch(`https://www.youtube.com/youtubei/v1/player${k ? "?key=" + k : ""}`, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip" },
      body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en", gl: "US" } }, videoId: vid }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  } catch { return []; }
}

async function transcript(vid) {
  try {
    let tracks = await captionTracksViaApp(vid);
    if (tracks.length) {
      const tr0 = tracks.find((x) => x.languageCode === "en" && x.kind !== "asr") || tracks.find((x) => String(x.languageCode || "").startsWith("en")) || tracks[0];
      try {
        const j0 = await (await fetch(tr0.baseUrl + "&fmt=json3", { headers: UA })).json();
        const t0 = (j0.events || []).map((e) => (e.segs || []).map((s) => s.utf8).join("")).join(" ").replace(/\s+/g, " ").trim();
        if (t0.length > 200) return shrink(t0);
      } catch {}
    }
  } catch {}
  try {
    const t = await (await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`, { headers: UA })).text();
    const m = t.match(/"captionTracks":(\[.*?\]),"(?:audioTracks|translationLanguages|defaultAudioTrackIndex)"/);
    if (!m) return "";
    const tracks = JSON.parse(m[1]);
    const tr = tracks.find((x) => x.languageCode === "en" && x.kind !== "asr") || tracks.find((x) => String(x.languageCode || "").startsWith("en")) || tracks[0];
    if (!tr || !tr.baseUrl) return "";
    const j = await (await fetch(tr.baseUrl + "&fmt=json3", { headers: UA })).json();
    const text = (j.events || []).map((e) => (e.segs || []).map((s) => s.utf8).join("")).join(" ").replace(/\s+/g, " ").trim();
    return shrink(text);
  } catch { return ""; }
}
function shrink(text) {
  if (text.length <= 60000) return text;
  const third = 20000, mid = Math.floor(text.length / 2);
  return text.slice(0, third) + " […] " + text.slice(mid - third / 2, mid + third / 2) + " […] " + text.slice(-third);
}

const SYSTEM = `You are Cordial, the friendly AI agent in a private family co-parenting hub. Write the evening recap that the whole family reads at 8:00 pm.
You are given the title of today's YouTube session and, if available, its transcript.
Format (plain text, no markdown symbols, no headings with #):
🌙 Evening recap
Then, if there is a transcript: "Today's session" followed by 3 to 5 short lines starting with "• " that summarize the main points, using only what the transcript actually says. Do not invent quotes, names, facts or promises. If there is no transcript, write one line saying the full summary isn't available today and mention the title.
Then "A word for tonight" followed by 2 to 3 warm, encouraging sentences for parents and families (kind, hopeful, practical; gentle faith language is welcome when the session was prayer, and never preachy).
Keep the whole message under 170 words. Speak to the reader as "you".`;

async function run() {
  if (!URL_ || !KEY || !AKEY) return { code: 501, body: { error: "not_configured" } };
  const feed = await readDoc("profiles/cordial_daily");
  const vid = feed.vid || "", title = feed.title || "";
  const tx = vid ? await transcript(vid) : "";
  const user = `Session title: ${title || "(unknown)"}\nTranscript: ${tx || "(not available)"}`;
  let text = "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) return { code: 502, body: { error: "ai_failed", status: r.status } };
    const j = await r.json();
    text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  } catch (e) { return { code: 502, body: { error: "ai_failed" } }; }
  if (!text) return { code: 502, body: { error: "empty" } };

  const lagos = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10); // Nigerian date
  const cur = await readDoc("profiles/cordial_recap");
  const items = (Array.isArray(cur.items) ? cur.items : []).filter((x) => x.day !== lagos);
  items.push({ day: lagos, vid, title, text, withTranscript: !!tx, ts: Date.now() });
  await writeDoc("profiles/cordial_recap", { items: items.slice(-7) });
  return { code: 200, body: { ok: true, withTranscript: !!tx } };
}
exports.run = run;

// Owner-only "run it now".
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY) return out(501, { error: "not_configured" });
  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin" });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin" });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=is_owner`, { headers: H });
  const m = (mr.ok ? await mr.json() : [])[0];
  if (!m || !m.is_owner) return out(403, { error: "forbidden" });
  const r = await run();
  return out(r.code, r.body);
};
