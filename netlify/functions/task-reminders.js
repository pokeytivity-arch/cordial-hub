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
      const payload = { kind: "task", title: "⏰ Task waiting for your confirmation", body: `“${String(t.title || "").slice(0, 100)}” was marked done. Please confirm it.`, tag: "task-" + row.id, url: "/?goto=todo" };
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
  // Janet's checklist: tell both parents once when a consumable (milk, diapers...) drops to 30% or less.
  try {
    const cs = await readDoc("expenses/chk_state");
    if (cs && cs.done) {
      let changed = false;
      for (const k of Object.keys(cs.done)) {
        const d = cs.done[k];
        if (!d || !d.days || d.low || !d.ts) continue;
        const tot = d.days * DAY;
        const left = Math.max(0, tot - (now - d.ts));
        if (left / tot > 0.3) continue;
        const days = Math.ceil(left / DAY);
        const payload = { kind: "task", title: "🛒 Running low", body: `${String(d.t || "An item").slice(0, 80)} is down to about ${days} ${days === 1 ? "day" : "days"}. Time to restock.`, tag: "chk-" + k, url: "/?goto=chk" };
        for (const m of members.filter((x) => x.grp === "parent")) {
          const key = `profiles/cp_${m.user_id}`;
          const pd = (await readDoc(key)) || {};
          const subs = Array.isArray(pd.push) ? pd.push : [];
          const keep = [];
          for (const sub of subs) {
            if (!sub || !sub.endpoint || !sub.keys) continue;
            let c = 0;
            try { c = await push._sendOne(sub, payload); } catch { c = 0; }
            if (c >= 200 && c < 300) sent++;
            if (c !== 404 && c !== 410) keep.push(sub);
          }
          if (keep.length !== subs.length) { pd.push = keep; await writeDoc(key, "profiles", `cp_${m.user_id}`, pd); }
        }
        cs.done[k] = { ...d, low: 1 };
        changed = true;
      }
      if (changed) await writeDoc("expenses/chk_state", "expenses", "chk_state", cs);
    }
  } catch {}
  // Twice a week (Tuesday and Friday, 9am Lagos time) Cordial asks Mummy for news and photos of Janet.
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "short", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const g = (t) => (parts.find((x) => x.type === t) || {}).value;
    const today = `${g("year")}-${g("month")}-${g("day")}`;
    if ((g("weekday") === "Tue" || g("weekday") === "Fri") && Number(g("hour")) === 9) {
      const st = (await readDoc("profiles/janetnudge")) || {};
      if (st.day !== today) {
        const jr = await fetch(`${URL_}/rest/v1/docs?collection=eq.profiles&id=like.janet_*&select=data`, { headers: H });
        const entries = jr.ok ? await jr.json() : [];
        const lastEntry = entries.reduce((m, e) => Math.max(m, (e.data || {}).ts || 0), 0);
        const parents = members.filter((m) => m.grp === "parent");
        const mum = parents.find((m) => /glory|mngutyo/i.test(m.name || "")) || parents.find((m) => !/onyemachi/i.test(m.name || ""));
        if (mum && now - lastEntry > 2 * DAY) {
          const key = `profiles/cp_${mum.user_id}`;
          const d = (await readDoc(key)) || {};
          const subs = Array.isArray(d.push) ? d.push : [];
          const keep = [];
          const payload = { kind: "task", title: "📝 Janet’s journal", body: "Cordial would love a photo and a quick update on Janet: school, health, how happy she is, anything we should know. It helps document her journey.", tag: "janet-" + today, url: "/?goto=janet" };
          for (const sub of subs) {
            if (!sub || !sub.endpoint || !sub.keys) continue;
            let c = 0;
            try { c = await push._sendOne(sub, payload); } catch { c = 0; }
            if (c >= 200 && c < 300) sent++;
            if (c !== 404 && c !== 410) keep.push(sub);
          }
          if (keep.length !== subs.length) { d.push = keep; await writeDoc(key, "profiles", `cp_${mum.user_id}`, d); }
        }
        await writeDoc("profiles/janetnudge", "profiles", "janetnudge", { day: today });
      }
    }
  } catch {}
  return { statusCode: 200, body: JSON.stringify({ checked: rows.length, sent }) };
};
