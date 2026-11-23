// Cordial's tip of the day, sent as a phone notification (not a chat message) at 8:00 am Nigerian time.
// Tapping it opens the Cordial page in the hub with that day's tip.
const push = require("./push.js");
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
// Keep in step with BOT_TIPS in index.html (same order, so the same day gives the same tip).
const TIPS = [
"Keep it about the child. Before you send a message, ask: does this help our child? If not, leave it out.",
"Write like a colleague. Short, polite and factual messages are easier to read and harder to argue with.",
"Pause before you reply. If a message makes you angry, wait an hour. Most things don’t need an answer in minutes.",
"Never use your child as a messenger. Pass plans and news directly to the other parent.",
"Say it once, clearly. Put the date, time and place in one message instead of several small ones.",
"Praise out loud. When the other parent does something good for your child, tell them. It builds goodwill.",
"Keep routines similar in both homes: bedtime, screen time and homework rules. Children feel safer with consistency.",
"Don’t speak badly about the other parent in front of your child, even when you are upset.",
"Hand-overs go better when they are short and calm. Be on time, say hello, and keep the talking for later.",
"Use the Calendar. A plan that is written down can’t be remembered two different ways.",
"Share school news fast. Report cards, events and notes are for both parents.",
"When you disagree, name the shared goal first: “We both want what’s best for her.” Then discuss the choice.",
"Ask, don’t tell. “Can we swap Saturday?” works better than “I’m taking Saturday.”",
"Give notice for changes. The earlier you tell the other parent, the easier it is for them to say yes.",
"Let small things go. Different snacks and different outfits rarely matter. Save your energy for what does.",
"Listen to your child’s feelings without taking sides. “That sounds hard” is often enough.",
"Keep a record of expenses in the hub with receipts. Clear records prevent money arguments.",
"Be reliable. If you say you’ll call at 6, call at 6. Children measure love by consistency.",
"Take care of yourself too. Rest, exercise and friends make you a calmer parent.",
"Celebrate milestones together when you can: birthdays, graduations and recitals. Your child will remember it.",
"Agree on how to handle emergencies before one happens: who to call, who has the insurance card, who is closer.",
"Avoid “always” and “never”. They start fights. Describe the one thing that happened instead.",
"Stay flexible within limits. Life changes, and swapping a weekend now and then keeps the peace.",
"Tell your child the plan ahead of time. Knowing what comes next lowers worry at hand-overs.",
"Keep new partners out of disputes. Introduce them slowly and only when you are sure the relationship is steady.",
"Respect the other parent’s time. Don’t call or text during their parenting time unless it matters.",
"When a message upsets you, reread it and ask: what is the actual request? Answer only that.",
"Let your child love both homes. Never ask them to pick a side or report on the other parent.",
"Review your parenting plan once a year. Children grow, and the plan should grow with them.",
"If talking keeps failing, ask a mediator or family counsellor for help. It is a sign of strength."
];

async function getJson(path) { const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
async function readDoc(key) { return ((await getJson(`docs?key=eq.${encodeURIComponent(key)}&select=data`))[0] || {}).data || {}; }
async function writeDoc(key, data) {
  const i = key.indexOf("/");
  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, collection: key.slice(0, i), id: key.slice(i + 1), data, updated_at: new Date().toISOString() }) });
}
function short(t) { const s = String(t).split(/(?<=[.!?])\s/)[0]; return s.length > 150 ? s.slice(0, 147) + "…" : s; }

async function run(force) {
  if (!URL_ || !KEY) return { ok: false, reason: "not_configured" };
  const n = Math.floor(Date.now() / 86400000);
  const flag = await readDoc("settings/dailyTip");
  if (flag.day === n && !force) return { ok: true, skipped: "already_sent" };
  await writeDoc("settings/dailyTip", { day: n, ts: Date.now() }); // claim first so two runs never both send
  const tip = TIPS[n % TIPS.length];
  const members = await getJson("members?select=user_id");
  let sent = 0;
  for (const m of members) {
    const lp = await readDoc(`profiles/cp_${m.user_id}`);
    const subs = Array.isArray(lp.push) ? lp.push : [];
    const keep = [];
    for (const s of subs) {
      if (!s || !s.endpoint || !s.keys) continue;
      let st = 0;
      try { st = await push._sendOne(s, { kind: "summary", title: "💡 Cordial’s tip of the day", body: short(tip), tag: "cordial-tip", url: `/?chat=cordial_ai&tip=${n}` }); } catch {}
      if (st >= 200 && st < 300) sent++;
      if (st !== 404 && st !== 410) keep.push(s);
    }
    if (keep.length !== subs.length) { lp.push = keep; await writeDoc(`profiles/cp_${m.user_id}`, lp); }
  }
  return { ok: true, day: n, pushed: sent };
}
exports.run = run;
exports.handler = async () => out(200, await run(false));
