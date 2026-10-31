// Keeps the hub in step with the real Zoom meeting.
// It reads the meeting from Zoom, then (1) updates the hub's call schedule (days, time, start date),
// which drives the phone reminders, and (2) puts each upcoming call on the hub calendar as a real event.
// Uses the same variables as zoom-webhook.js: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, and optionally ZOOM_MEETING_NUMBER.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACC = process.env.ZOOM_ACCOUNT_ID;
const CID = process.env.ZOOM_CLIENT_ID;
const CSEC = process.env.ZOOM_CLIENT_SECRET;
const MID = String(process.env.ZOOM_MEETING_NUMBER || "81051139171").replace(/\D/g, "");
const WAT = 3600e3; // Nigeria is UTC+1, no daylight saving
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function token() {
  if (!ACC || !CID || !CSEC) return null;
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ACC)}`, {
    method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${CID}:${CSEC}`).toString("base64") },
  });
  return r.ok ? (await r.json()).access_token || null : null;
}
const wat = (ms) => new Date(ms + WAT).toISOString(); // Nigerian wall-clock time as an ISO string
async function upsert(key, data) {
  const i = key.indexOf("/");
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, collection: key.slice(0, i), id: key.slice(i + 1), data, updated_at: new Date().toISOString() }),
  });
}

async function syncSchedule() {
  if (!URL_ || !KEY) return { ok: false, reason: "not_configured" };
  const tk = await token();
  if (!tk) return { ok: false, reason: "no_zoom_api" };
  const r = await fetch(`https://api.zoom.us/v2/meetings/${MID}`, { headers: { Authorization: `Bearer ${tk}` } });
  if (!r.ok) return { ok: false, reason: "zoom_" + r.status };
  const m = await r.json();
  const now = Date.now();

  let occ = (m.occurrences || [])
    .filter((o) => o.status !== "deleted")
    .map((o) => ({ id: String(o.occurrence_id), start: Date.parse(o.start_time), dur: o.duration || m.duration || 60 }))
    .filter((o) => o.start > now - 3600e3)
    .sort((a, b) => a.start - b.start);
  if (!occ.length && m.start_time && Date.parse(m.start_time) > now - 3600e3)
    occ = [{ id: "single" + Date.parse(m.start_time), start: Date.parse(m.start_time), dur: m.duration || 60 }];
  if (!occ.length) return { ok: true, empty: true };

  const first = occ[0];
  // The weekly time comes from the series itself, so moving ONE call doesn't change every week
  const t = m.recurrence && m.start_time ? wat(Date.parse(m.start_time)).slice(11, 16) : wat(first.start).slice(11, 16);
  let days;
  if (m.recurrence && m.recurrence.type === 2 && m.recurrence.weekly_days) {
    days = String(m.recurrence.weekly_days).split(",").map((n) => parseInt(n, 10) - 1).filter((n) => n >= 0 && n <= 6); // Zoom: 1 = Sunday
  } else {
    days = [...new Set(occ.map((o) => new Date(o.start + WAT).getUTCDay()))];
  }
  days.sort();
  await upsert("settings/callplan", { days, t, from: wat(first.start).slice(0, 10), synced: now, meetingId: MID });

  // Real calendar events for the next calls
  const keep = new Set();
  const lr = await fetch(`${URL_}/rest/v1/docs?collection=eq.schedule&id=like.ev_zoom_*&select=key,data`, { headers: H });
  const have = lr.ok ? await lr.json() : [];
  const old = {}; have.forEach((d) => { old[d.key] = d.data || {}; });
  for (const o of occ.slice(0, 12)) {
    const id = "ev_zoom_" + o.id.replace(/[^A-Za-z0-9]/g, "");
    keep.add("schedule/" + id);
    const prev = old["schedule/" + id] || {};
    const rec = {
      title: "Family Zoom call", date: wat(o.start).slice(0, 10), time: wat(o.start).slice(11, 16),
      place: "Zoom, in the hub", notes: "", zoom: true, occ: o.id, by: "cordial_ai", ts: now,
    };
    if (prev.moved) rec.moved = prev.moved;
    await upsert("schedule/" + id, rec);
  }
  // Remove future call events that Zoom no longer has (rescheduled or cancelled)
  const today = wat(now).slice(0, 10);
  for (const d of have) {
    if (keep.has(d.key) || !d.data || String(d.data.date || "") < today) continue;
    await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(d.key)}`, { method: "DELETE", headers: H });
  }
  return { ok: true, days, t, events: keep.size };
}

module.exports = { syncSchedule };

// Called by the hub itself ("Refresh from Zoom"): any signed-in member can ask for a fresh copy of the Zoom schedule.
exports.handler = async (event) => {
  const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY) return out(500, { error: "not_configured" });
  const tk = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!tk) return out(401, { error: "signin" });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tk}` } });
  if (!who.ok) return out(401, { error: "signin" });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=user_id`, { headers: H });
  if (!(mr.ok && (await mr.json())[0])) return out(403, { error: "forbidden" });
  try { return out(200, await syncSchedule()); } catch (e) { return out(502, { ok: false, reason: "failed" }); }
};
