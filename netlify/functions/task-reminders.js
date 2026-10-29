// Reminds the other parent when a task was marked done but is still waiting for confirmation.
// Sends a phone alert after 24 hours, then again each day, up to 3 reminders. Runs every hour (schedule in netlify.toml).
// Uses the same Netlify variables as push.js.
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const DAY = 86400e3;

async function readDoc(key) {
  const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: H });
  return ((r.ok ? await r.json() : [])[0] || {}).data || null;
}
async function writeDoc(key, collection, id, data) {
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, collection, id, data }) });
}

exports.handler = async () => {
  if (!URL_ || !KEY || !process.env.VAPID_PRIVATE_KEY) return { statusCode: 501, body: "not_configured" };
  const now = Date.now();
  const r = await fetch(`${URL_}/rest/v1/docs?collection=eq.expenses&data->>kind=eq.todo&data->>status=eq.done&select=id,data`, { headers: H });
  const rows = r.ok ? await r.json() : [];
  const mr = await fetch(`${URL_}/rest/v1/members?select=user_id,name,grp,is_owner`, { headers: H });
  const members = mr.ok ? await mr.json() : [];
  let sent = 0;
  for (const row of rows) {
    const t = row.data || {};
    const n = t.remindCount || 0;
    const since = t.remindedAt || t.doneAt || 0;
    if (!t.doneAt || n >= 3 || now - since < DAY) continue;
    const others = members.filter((m) => m.grp === "parent" && m.user_id !== t.doneBy);
    for (const m of others) {
      const key = `profiles/cp_${m.user_id}`;
      const d = (await readDoc(key)) || {};
      const subs = Array.isArray(d.push) ? d.push : [];
      const keep = [];
      const payload = { kind: "task", title: "⏰ Task waiting for your confirmation", body: `“${String(t.title || "").slice(0, 100)}” was marked done. Please confirm it.`, tag: "task-" + row.id, url: "/?goto=meet" };
      for (const s of subs) {
        if (!s || !s.endpoint || !s.keys) continue;
        let st = 0;
        try { st = await push._sendOne(s, payload); } catch { st = 0; }
        if (st >= 200 && st < 300) sent++;
        if (st !== 404 && st !== 410) keep.push(s);
      }
      if (keep.length !== subs.length) { d.push = keep; await writeDoc(key, "profiles", `cp_${m.user_id}`, d); }
    }
    await writeDoc(`expenses/${row.id}`, "expenses", row.id, { ...t, remindCount: n + 1, remindedAt: now });
  }
  return { statusCode: 200, body: JSON.stringify({ checked: rows.length, sent }) };
};
