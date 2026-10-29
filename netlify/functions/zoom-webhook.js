// Receives Zoom events and saves meeting summaries and transcripts into the hub (Meetings page).
// Netlify environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ZOOM_WEBHOOK_SECRET (the app's "Secret Token"), ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET.
// None of these keys ever go in the web page. They live only here, on the server.
const crypto = require("crypto");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.ZOOM_WEBHOOK_SECRET;
const ACC = process.env.ZOOM_ACCOUNT_ID;
const CID = process.env.ZOOM_CLIENT_ID;
const CSEC = process.env.ZOOM_CLIENT_SECRET;

const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("hex");

async function zoomToken() {
  if (!ACC || !CID || !CSEC) return null;
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ACC)}`, {
    method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${CID}:${CSEC}`).toString("base64") },
  });
  if (!r.ok) return null;
  return (await r.json()).access_token || null;
}
const encUuid = (u) => (u.startsWith("/") || u.includes("//") ? encodeURIComponent(encodeURIComponent(u)) : encodeURIComponent(u));

function summaryText(o) {
  const parts = [];
  if (o.summary_title) parts.push(o.summary_title);
  if (o.summary_overview) parts.push(o.summary_overview);
  (o.summary_details || []).forEach((d) => { if (d && (d.label || d.summary)) parts.push(`${d.label ? d.label + ": " : ""}${d.summary || ""}`); });
  return parts.join("\n\n").trim();
}
function nextSteps(o) { return Array.isArray(o.next_steps) ? o.next_steps.filter(Boolean).join("\n") : ""; }
function cleanVtt(t) {
  return String(t).split(/\r?\n/).filter((l) => l && l !== "WEBVTT" && !/^\d+$/.test(l) && !/^\d{2}:\d{2}:\d{2}\.\d+\s+-->/.test(l)).join("\n");
}

// Permanent call-log entry (insert only; the database blocks any later edit or delete).
async function logZoom(uuid, topic, start, durSec) {
  const id = "z_" + crypto.createHash("sha1").update(uuid).digest("hex").slice(0, 22);
  const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const data = { source: "zoom", outcome: "zoom", topic, name: "Zoom", withNames: "Family Zoom call", audio: false, to: [], chat: "family", ts: start || Date.now(), dur: durSec || 0, logged: Date.now() };
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...h, Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ key: `calllog/${id}`, collection: "calllog", id, data }),
  });
}

async function save(uuid, patch) {
  const id = crypto.createHash("sha1").update(uuid).digest("hex").slice(0, 24);
  const key = `meetingnotes/${id}`;
  const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const cur = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: h });
  const old = ((cur.ok ? await cur.json() : [])[0] || {}).data || {};
  const data = { source: "zoom", ts: Date.now(), start: Date.now(), ...old };
  for (const k of Object.keys(patch)) if (patch[k] !== undefined && patch[k] !== "") data[k] = patch[k];
  const r = await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...h, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, collection: "meetingnotes", id, data }),
  });
  return r.ok;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!SECRET || !URL_ || !KEY) return out(501, { error: "not_configured" });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
  let b; try { b = JSON.parse(raw); } catch { return out(400, { error: "bad" }); }

  if (b.event === "endpoint.url_validation") {
    const pt = b.payload && b.payload.plainToken;
    return out(200, { plainToken: pt, encryptedToken: hmac(pt || "") });
  }

  const ts = event.headers["x-zm-request-timestamp"] || "";
  const sig = event.headers["x-zm-signature"] || "";
  const want = "v0=" + hmac(`v0:${ts}:${raw}`);
  const okSig = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  if (!okSig || Math.abs(Date.now() / 1000 - Number(ts)) > 600) return out(401, { error: "signature" });

  const o = (b.payload && b.payload.object) || {};
  const uuid = String(o.meeting_uuid || o.uuid || "");
  if (!uuid) return out(200, { ok: true, skipped: "no meeting" });
  const topic = o.meeting_topic || o.topic || "Zoom meeting";
  const start = Date.parse(o.meeting_start_time || o.start_time || "") || undefined;

  try {
    const durSec = Number(o.duration) ? Number(o.duration) * 60 : 0;
    if (b.event === "meeting.ended") { await logZoom(uuid, topic, Date.parse(o.start_time || "") || start, durSec); return out(200, { ok: true }); }
    if (b.event === "meeting.summary_completed" || b.event === "recording.completed" || b.event === "recording.transcript_completed") await logZoom(uuid, topic, start, 0);
    if (b.event === "meeting.summary_completed") {
      let text = summaryText(o), steps = nextSteps(o);
      if (!text) {
        const tk = await zoomToken();
        if (tk) {
          const r = await fetch(`https://api.zoom.us/v2/meetings/${encUuid(uuid)}/meeting_summary`, { headers: { Authorization: `Bearer ${tk}` } });
          if (r.ok) { const j = await r.json(); text = summaryText(j); steps = nextSteps(j); }
        }
      }
      await save(uuid, { topic, start, summary: text.slice(0, 60000), next_steps: steps.slice(0, 10000), meeting_id: o.meeting_id || o.id });
    } else if (b.event === "recording.transcript_completed" || b.event === "recording.completed") {
      const f = (o.recording_files || []).find((x) => x.file_type === "TRANSCRIPT" || x.recording_type === "audio_transcript");
      if (f && f.download_url) {
        const dt = b.download_token;
        let r = await fetch(dt ? `${f.download_url}?access_token=${encodeURIComponent(dt)}` : f.download_url);
        if (!r.ok) { const tk = await zoomToken(); if (tk) r = await fetch(f.download_url, { headers: { Authorization: `Bearer ${tk}` } }); }
        if (r.ok) await save(uuid, { topic, start, transcript: cleanVtt(await r.text()).slice(0, 180000), meeting_id: o.id || o.meeting_id });
      }
    }
  } catch (e) { return out(500, { error: "failed" }); }
  return out(200, { ok: true });
};
