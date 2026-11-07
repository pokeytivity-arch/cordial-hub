// Cordial's summaries: sent on the LAST day of every week (Sunday), month, quarter and year, at 8:30 pm Nigerian time.
// Runs every day at 19:30 UTC (netlify.toml) and only writes when today closes a week / month / quarter / year.
// Covers meetings, events, documents, support and expenses, notes, posts, photos, calls and messages (counts only for chats).
// Items marked private (shared with chosen people only) are never read. Saved in profiles/cordial_summaries (shown in the Cordial chat) and sent as a push.
// Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (optional; without it a plain count summary is sent), VAPID keys (push).
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const WAT = 3600e3, DAY = 86400e3;
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

async function getJson(path) { const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function readDoc(key) { return ((await getJson(`docs?key=eq.${encodeURIComponent(key)}&select=data`))[0] || {}).data || {}; }
async function writeDoc(key, data) {
  const [collection, id] = key.split("/");
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, collection, id, data }) });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ymd = (d) => d.toISOString().slice(0, 10);
// Which periods end on this Nigerian date?  Returns [{kind,label,start(Date UTC midnight of Lagos day),end}]
function periodsEnding(today) {
  const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate(), wd = today.getUTCDay();
  const tomorrow = new Date(today.getTime() + DAY);
  const list = [];
  if (wd === 0) list.push({ kind: "week", label: "Week of " + ymd(new Date(today.getTime() - 6 * DAY)) + " to " + ymd(today), start: new Date(today.getTime() - 6 * DAY) });
  if (tomorrow.getUTCMonth() !== m) {
    list.push({ kind: "month", label: MONTHS[m] + " " + y, start: new Date(Date.UTC(y, m, 1)) });
    if (m % 3 === 2) list.push({ kind: "quarter", label: "Quarter " + (Math.floor(m / 3) + 1) + " " + y + " (" + MONTHS[m - 2] + " to " + MONTHS[m] + ")", start: new Date(Date.UTC(y, m - 2, 1)) });
    if (m === 11) list.push({ kind: "year", label: "Year " + y, start: new Date(Date.UTC(y, 0, 1)) });
  }
  return list.map((p) => ({ ...p, end: new Date(today.getTime() + DAY), day: d }));
}

const COLS = [["schedule", "Events"], ["meetingnotes", "Meetings"], ["documents", "Documents"], ["expenses", "Support, school fees and expenses"], ["notes", "Notes"], ["posts", "Posts"], ["media", "Photos"], ["calllog", "Calls"], ["messages", "Messages"], ["checkins", "Verified check-ins"]];
const pick = (d) => {
  const o = {};
  for (const k of ["title", "name", "what", "desc", "description", "type", "cat", "category", "status", "amount", "amt", "currency", "date", "start", "when", "place", "kind"]) if (d[k] != null && typeof d[k] !== "object") o[k] = String(d[k]).slice(0, 80);
  if (!o.title && !o.name && typeof d.text === "string" && d.kind !== "text") o.text = d.text.slice(0, 80);
  return o;
};

async function gather(p) {
  const from = new Date(p.start.getTime() - WAT).toISOString(), to = new Date(p.end.getTime() - WAT).toISOString();
  const facts = {};
  for (const [col, label] of COLS) {
    const rows = await getJson(`docs?collection=eq.${col}&created_at=gte.${from}&created_at=lt.${to}&select=id,data&limit=1000`);
    let list = rows.map((r) => ({ id: r.id, d: r.data || {} })).filter((r) => !Array.isArray(r.d.share));
    if (col === "schedule") list = list.filter((r) => /^ev_/.test(r.id));
    if (col === "messages") list = list.filter((r) => r.d.kind !== "sys" && r.d.by !== "cordial_ai");
    const count = list.length;
    facts[label] = col === "messages" || col === "media" || col === "calllog" || col === "checkins" ? { count } : { count, items: list.slice(0, 40).map((r) => pick(r.d)) };
  }
  return facts;
}

function plain(p, facts) {
  const lines = Object.entries(facts).filter(([, v]) => v.count).map(([k, v]) => `• ${k}: ${v.count}`);
  return `📋 ${p.label}\n\n` + (lines.length ? "What was added in this period:\n" + lines.join("\n") : "Nothing new was added to the hub in this period.");
}

async function write(p, facts) {
  if (!AKEY) return plain(p, facts);
  const sys = `You are Cordial, the friendly AI agent in a private family co-parenting hub. Write the ${p.kind}ly summary the whole family reads on the last day of the ${p.kind}.
Plain text only, no markdown symbols and no # headings. Start with "📋 ${p.label}". Then short sections, each with a title line and lines starting with "• ", only for sections that have something: Meetings, Events, Documents, Support and expenses (mention amounts only if they are in the data), Notes, Posts and photos, Calls and messages (counts only). End with one warm, calm sentence. Use only the data given; never invent names, amounts, dates or promises. Under 260 words.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, max_tokens: 16000, system: sys, messages: [{ role: "user", content: JSON.stringify(facts) }] }) });
    if (!r.ok) return plain(p, facts);
    const j = await r.json();
    return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim() || plain(p, facts);
  } catch { return plain(p, facts); }
}

async function notify(title, body) {
  const members = await getJson("members?select=user_id");
  let sent = 0;
  for (const m of members) {
    const lp = await readDoc(`profiles/cp_${m.user_id}`);
    const subs = Array.isArray(lp.push) ? lp.push : [];
    if (!subs.length) continue;
    const keep = []; 
    for (const s of subs) {
      if (!s || !s.endpoint || !s.keys) continue;
      let st = 0; try { st = await push._sendOne(s, { kind: "summary", title, body, tag: "summary-" + title, url: "/?chat=cordial_ai" }); } catch {}
      if (st >= 200 && st < 300) sent++;
      if (st !== 404 && st !== 410) keep.push(s);
    }
    if (keep.length !== subs.length) { lp.push = keep; await writeDoc(`profiles/cp_${m.user_id}`, lp); }
  }
  return sent;
}

async function run(only) {
  if (!URL_ || !KEY) return { code: 501, body: { error: "not_configured" } };
  const today = new Date(Math.floor((Date.now() + WAT) / DAY) * DAY); // Nigerian date at 00:00 (as UTC)
  let periods = periodsEnding(today);
  if (only) {
    const base = new Date(today); const y = base.getUTCFullYear(), m = base.getUTCMonth();
    const all = { week: { kind: "week", label: "Week of " + ymd(new Date(today.getTime() - 6 * DAY)) + " to " + ymd(today), start: new Date(today.getTime() - 6 * DAY) }, month: { kind: "month", label: MONTHS[m] + " " + y, start: new Date(Date.UTC(y, m, 1)) }, quarter: { kind: "quarter", label: "Quarter " + (Math.floor(m / 3) + 1) + " " + y, start: new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1)) }, year: { kind: "year", label: "Year " + y, start: new Date(Date.UTC(y, 0, 1)) } };
    periods = all[only] ? [{ ...all[only], end: new Date(today.getTime() + DAY) }] : [];
  }
  if (!periods.length) return { code: 200, body: { ok: true, sent: [] } };
  const cur = await readDoc("profiles/cordial_summaries");
  let items = Array.isArray(cur.items) ? cur.items : [];
  const sent = [];
  for (const p of periods) {
    const id = p.kind + "_" + ymd(today);
    if (!only && items.some((x) => x.id === id)) continue;
    const facts = await gather(p);
    const text = await write(p, facts);
    items = items.filter((x) => x.id !== id);
    items.push({ id, kind: p.kind, label: p.label, text, ts: Date.now() });
    await notify(`📋 ${p.kind[0].toUpperCase() + p.kind.slice(1)} summary`, p.label);
    sent.push(id);
  }
  await writeDoc("profiles/cordial_summaries", { items: items.slice(-24) });
  return { code: 200, body: { ok: true, sent } };
}
exports.run = run;

exports.handler = async (event) => {
  if (event.httpMethod === "POST") { // owner-only "send it now": body {period:"week"|"month"|"quarter"|"year"}
    const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
    if (!token) return out(401, { error: "signin" });
    const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!who.ok) return out(401, { error: "signin" });
    const me = await who.json();
    const m = (await getJson(`members?user_id=eq.${me.id}&select=is_owner`))[0];
    if (!m || !m.is_owner) return out(403, { error: "forbidden" });
    let b = {}; try { b = JSON.parse(event.body || "{}"); } catch {}
    const r = await run(b.period || "week");
    return out(r.code, r.body);
  }
  const r = await run();
  return out(r.code, r.body);
};
