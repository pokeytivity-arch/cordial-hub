// Reschedule a meeting from the hub.
// - Zoom calls (events synced from Zoom): moves that one call on Zoom itself, then updates the hub calendar.
// - Other events: updates the hub calendar.
// Then sends a phone alert to BOTH parents. Only a parent or the owner can do this.
// Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_*, and for Zoom: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID,
// ZOOM_CLIENT_SECRET (the Zoom app needs the scope "meeting:update:meeting:admin"), optional ZOOM_MEETING_NUMBER.
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACC = process.env.ZOOM_ACCOUNT_ID, CID = process.env.ZOOM_CLIENT_ID, CSEC = process.env.ZOOM_CLIENT_SECRET;
const MID = String(process.env.ZOOM_MEETING_NUMBER || "81051139171").replace(/\D/g, "");
const WAT = 3600e3; // Nigeria is UTC+1
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

async function readDoc(key) {
  const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: admin });
  return ((r.ok ? await r.json() : [])[0] || {}).data || null;
}
async function writeDoc(key, data) {
  const i = key.indexOf("/");
  return fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...admin, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, collection: key.slice(0, i), id: key.slice(i + 1), data, updated_at: new Date().toISOString() }),
  });
}
async function zoomToken() {
  if (!ACC || !CID || !CSEC) return null;
  const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ACC)}`, {
    method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${CID}:${CSEC}`).toString("base64") },
  });
  return r.ok ? (await r.json()).access_token || null : null;
}
const nice = (d, t) => {
  const dt = new Date(d + "T12:00:00Z");
  const day = dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  if (!t) return day;
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  const ap = h >= 12 ? "PM" : "AM", h12 = h % 12 || 12;
  return `${day}, ${h12}:${String(m).padStart(2, "0")} ${ap}`;
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY) return out(500, { error: "not_configured", message: "The hub server isn’t set up." });
  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin", message: "Please sign in again." });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin", message: "Please sign in again." });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=is_owner,grp,name`, { headers: admin });
  const mrow = (mr.ok ? await mr.json() : [])[0];
  if (!mrow || (!mrow.is_owner && mrow.grp !== "parent")) return out(403, { error: "forbidden", message: "Only a parent can reschedule a meeting." });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return out(400, { error: "bad", message: "Bad request." }); }
  const id = String(b.id || "");
  const date = String(b.date || ""), time = String(b.time || "");
  if (!/^ev_[A-Za-z0-9_]+$/.test(id)) return out(400, { error: "bad", message: "Unknown meeting." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return out(400, { error: "bad", message: "Pick a date." });
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) return out(400, { error: "bad", message: "Pick a time." });

  const key = "schedule/" + id;
  const ev = await readDoc(key);
  if (!ev) return out(404, { error: "missing", message: "That meeting isn’t on the calendar any more." });
  if (ev.date === date && (ev.time || "") === time) return out(400, { error: "same", message: "That is already the date and time." });

  let zoomDone = false;
  if (ev.zoom) {
    if (!time) return out(400, { error: "bad", message: "Pick a time for the call." });
    const tk = await zoomToken();
    if (!tk) return out(501, { error: "zoom_not_configured", message: "Zoom isn’t connected to the hub yet (the Zoom keys are missing on the server), so the call wasn’t moved." });
    const [Y, M, D] = date.split("-").map((x) => parseInt(x, 10)), [hh, mm] = time.split(":").map((x) => parseInt(x, 10));
    const iso = new Date(Date.UTC(Y, M - 1, D, hh, mm) - WAT).toISOString().replace(/\.\d{3}Z$/, "Z");
    const occ = ev.occ && !String(ev.occ).startsWith("single") ? `?occurrence_id=${encodeURIComponent(ev.occ)}` : "";
    const zr = await fetch(`https://api.zoom.us/v2/meetings/${MID}${occ}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ start_time: iso, timezone: "UTC" }),
    });
    if (!(zr.status >= 200 && zr.status < 300)) {
      let detail = ""; try { detail = (await zr.json()).message || ""; } catch {}
      return out(502, { error: "zoom_failed", message: `Zoom wouldn’t move the call (${zr.status}${detail ? ": " + detail : ""}). Nothing was changed.` });
    }
    zoomDone = true;
  }

  const actor = mrow.name || "A parent";
  const moved = { fromDate: ev.date, fromTime: ev.time || "", by: me.id, byName: actor, ts: Date.now() };
  await writeDoc(key, { ...ev, date, time, moved });

  // Phone alerts to both parents (and the owner who made the change, if not a parent)
  const pr = await fetch(`${URL_}/rest/v1/members?select=user_id,grp`, { headers: admin });
  const ms = (pr.ok ? await pr.json() : []).filter((m) => m.grp === "parent" || m.user_id === me.id);
  const payload = {
    kind: "reminder", title: `Rescheduled: ${ev.title || "Meeting"}`,
    body: `${actor} moved it from ${nice(ev.date, ev.time)} to ${nice(date, time)}.` + (zoomDone ? " The Zoom call was updated too." : ""),
    tag: "resched-" + id + "-" + Date.now(), url: "/?goto=sched",
  };
  let sent = 0;
  for (const m of ms) {
    const k = `profiles/cp_${m.user_id}`;
    const d = (await readDoc(k)) || {};
    const subs = Array.isArray(d.push) ? d.push : [], keep = [];
    for (const s of subs) {
      if (!s || !s.endpoint || !s.keys) continue;
      let st = 0;
      try { st = await push._sendOne(s, payload); } catch { st = 0; }
      if (st >= 200 && st < 300) sent++;
      if (st !== 404 && st !== 410) keep.push(s);
    }
    if (keep.length !== subs.length) await writeDoc(k, { ...d, push: keep });
  }
  return out(200, { ok: true, zoom: zoomDone, pushed: sent });
};
