// "Get from Zoom" button on the Meetings page: pulls the summary, transcript and to-dos of past Zoom calls into the hub.
// Needs the Zoom app scopes: cloud_recording:read:list_user_recordings:admin, cloud_recording:read:list_recording_files:admin,
// cloud_recording:read:recording:admin and the meeting summary scope, plus the usual Netlify variables.
// Body: {list:true} -> recent Zoom calls and what the hub already has;  {uuid:"..."} -> bring one call in.
const T = require("./zoom-webhook.js")._t;
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function recentCalls(tk) {
  const to = Date.now() + 86400e3, from = to - 29 * 86400e3;
  const r = await fetch(`https://api.zoom.us/v2/users/me/recordings?from=${day(from)}&to=${day(to)}&page_size=30`, { headers: { Authorization: `Bearer ${tk}` } });
  if (!r.ok) throw new Error("zoom_" + r.status);
  return ((await r.json()).meetings || []).map((m) => ({ uuid: m.uuid, id: m.id, topic: m.topic || "Zoom meeting", start: Date.parse(m.start_time || "") || 0, files: m.recording_files || [] }))
    .sort((a, b) => b.start - a.start);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY) return out(501, { error: "not_configured" });
  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin" });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin" });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=name,is_owner`, { headers: admin });
  if (!(mr.ok ? await mr.json() : [])[0]) return out(403, { error: "forbidden" });
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch {}

  const tk = await T.zoomToken();
  if (!tk) return out(501, { error: "zoom_not_configured", detail: "The Zoom API keys are not set in Netlify." });
  let calls;
  try { calls = await recentCalls(tk); } catch (e) { return out(502, { error: "zoom_failed", detail: String(e.message || e).slice(0, 80) + " (check the Zoom app scopes)" }); }

  if (b.list) {
    const rows = [];
    for (const c of calls.slice(0, 12)) {
      const n = await T.getNote(c.uuid);
      rows.push({ uuid: c.uuid, topic: c.topic, start: c.start, hasNote: !!(n.summary || n.takeaways), hasTranscript: !!n.transcript, hasTranscriptInZoom: c.files.some((f) => f.file_type === "TRANSCRIPT") });
    }
    return out(200, { calls: rows });
  }

  const c = calls.find((x) => x.uuid === b.uuid);
  if (!c) return out(404, { error: "not_found", detail: "Zoom no longer has that call." });
  try {
    // 1) the transcript, saved first so it shows even if the rest takes long
    let vtt = "";
    const f = c.files.find((x) => x.file_type === "TRANSCRIPT" || x.recording_type === "audio_transcript");
    if (f && f.download_url) {
      const r = await fetch(f.download_url, { headers: { Authorization: `Bearer ${tk}` } });
      if (r.ok) vtt = T.cleanVtt(await r.text());
    }
    await T.save(c.uuid, { topic: c.topic, start: c.start, meeting_id: c.id, ...(vtt ? { transcript: vtt.slice(0, 150000) } : {}) });
    // 2) Zoom's own summary and next steps (or Cordial's from the transcript)
    let text = "", steps = "";
    const sr = await fetch(`https://api.zoom.us/v2/meetings/${T.encUuid(c.uuid)}/meeting_summary`, { headers: { Authorization: `Bearer ${tk}` } });
    if (sr.ok) { const j = await sr.json(); text = T.summaryText(j); steps = T.nextSteps(j); }
    const src = (text + (steps ? "\n\nNext steps from Zoom:\n" + steps : "")).trim() || vtt;
    if (!src) return out(200, { ok: true, transcript: !!vtt, summary: false });
    await T.finish(c.uuid, c.topic, c.start, c.id, src, text ? "summary" : "transcript", vtt, true);
    await T.logZoom(c.uuid, c.topic, c.start, 0);
    return out(200, { ok: true, transcript: !!vtt, summary: true });
  } catch (e) { return out(502, { error: "failed", detail: String((e && e.message) || e).slice(0, 80) }); }
};
