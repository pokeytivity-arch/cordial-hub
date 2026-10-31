// Sends phone alerts 6 hours, 3 hours and 30 minutes before each scheduled weekly call.
// Runs every 5 minutes (schedule in netlify.toml). Uses the same Netlify variables as push.js
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT).
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const OFFSETS = [[6 * 3600e3, "6 hours"], [3 * 3600e3, "3 hours"], [30 * 60e3, "30 minutes"]];
const LATE = 14 * 60e3; // still send if the timer fires up to 14 minutes late
const WAT = 3600e3;     // Nigeria is UTC+1, no daylight saving

async function readDoc(key) {
  const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: H });
  return ((r.ok ? await r.json() : [])[0] || {}).data || null;
}

exports.handler = async () => {
  if (!URL_ || !KEY || !process.env.VAPID_PRIVATE_KEY) return { statusCode: 501, body: "not_configured" };
  // Keep the schedule in step with the real Zoom meeting (at most once an hour)
  try {
    const cur = (await readDoc("settings/callplan")) || {};
    if (!cur.synced || Date.now() - cur.synced > 3600e3) await require("./zoom-sync.js").syncSchedule();
  } catch (e) {}
  const plan = (await readDoc("settings/callplan")) || {};
  const days = Array.isArray(plan.days) ? plan.days : [0, 2, 5];
  const from = String(plan.from || "2026-11-03");
  const [hh, mm] = String(plan.t || "18:30").split(":").map((x) => parseInt(x, 10) || 0);
  const now = Date.now();
  const state = (await readDoc("profiles/callremind")) || {};
  const sent = state.sent || {};
  const todo = [];

  for (let i = 0; i < 3; i++) {
    const base = new Date(now + WAT + i * 86400e3); // Nigerian calendar date
    const callAt = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm) - WAT;
    const wd = new Date(callAt + WAT).getUTCDay();
    if (!days.includes(wd) || callAt < now) continue;
    if (new Date(callAt + WAT).toISOString().slice(0, 10) < from) continue;
    for (const [off, label] of OFFSETS) {
      const due = callAt - off, k = `${callAt}_${off}`;
      if (now >= due && now - due < LATE && !sent[k]) todo.push({ k, label, callAt });
    }
  }
  // Calendar events added in the hub (schedule/ev_*): remind 1 hour and 15 minutes before (events with no time: 8:00 that morning)
  try {
    const er = await fetch(`${URL_}/rest/v1/docs?key=like.schedule/ev_*&select=key,data`, { headers: H });
    const evs = er.ok ? await er.json() : [];
    for (const row of evs) {
      const e = row.data || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) continue;
      const hasT = /^\d{1,2}:\d{2}$/.test(e.time || "");
      const [eh, em] = hasT ? e.time.split(":").map((x) => parseInt(x, 10)) : [8, 0];
      const [Y, M, D] = e.date.split("-").map((x) => parseInt(x, 10));
      const at = Date.UTC(Y, M - 1, D, eh, em) - WAT;
      const offs = hasT ? [[3600e3, "1 hour"], [15 * 60e3, "15 minutes"]] : [[0, "today"]];
      for (const [off, label] of offs) {
        const due = at - off, k = `ev_${row.key}_${at}_${off}`;
        if (now >= due && now - due < LATE && at + 60e3 > now - 3600e3 && !sent[k]) todo.push({ k, label, callAt: at, ev: e.title || "Event", hasT });
      }
    }
  } catch (e) {}
  if (!todo.length) return { statusCode: 200, body: "nothing due" };

  // Everyone who has phone alerts turned on
  const mr = await fetch(`${URL_}/rest/v1/members?select=user_id`, { headers: H });
  const members = mr.ok ? await mr.json() : [];
  let count = 0;
  for (const t of todo) {
    const when = new Date(t.callAt + WAT).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    const payload = t.ev
      ? { kind: "reminder", title: "Reminder: " + t.ev, body: t.label === "today" ? `${t.ev} is today.` : `${t.ev} starts in ${t.label} (${when}).`, tag: "evrem-" + t.k, url: "/?goto=sched" }
      : { kind: "reminder", title: "Family call reminder", body: `Your weekly call is in ${t.label} (${when}).`, tag: "callrem-" + t.k, url: "/?goto=call" };
    for (const m of members) {
      const key = `profiles/cp_${m.user_id}`;
      const d = (await readDoc(key)) || {};
      const subs = Array.isArray(d.push) ? d.push : [];
      const keep = [];
      for (const s of subs) {
        if (!s || !s.endpoint || !s.keys) continue;
        let st = 0;
        try { st = await push._sendOne(s, payload); } catch { st = 0; }
        if (st >= 200 && st < 300) count++;
        if (st !== 404 && st !== 410) keep.push(s);
      }
      if (keep.length !== subs.length) {
        d.push = keep;
        await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
          method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ key, collection: "profiles", id: `cp_${m.user_id}`, data: d }),
        });
      }
    }
    sent[t.k] = now;
  }
  for (const k of Object.keys(sent)) if (now - sent[k] > 3 * 86400e3) delete sent[k];
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "profiles/callremind", collection: "profiles", id: "callremind", data: { sent } }),
  });
  return { statusCode: 200, body: JSON.stringify({ sent: count, reminders: todo.length }) };
};
