// Cordial: the hub's AI agent. Answers co-parenting questions and hub how-tos.
// Environment variables in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
// (optional: ANTHROPIC_MODEL, default claude-haiku-5-5; CORDIAL_DAILY_LIMIT, default 40 questions per person per day).
// The key lives only here, on the server, never in the web page.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const PIN = parseFloat(process.env.CORDIAL_PRICE_IN || "1"), POUT = parseFloat(process.env.CORDIAL_PRICE_OUT || "5"); // dollars per million tokens (estimate; set to your model's real rates)
const LIMIT = parseInt(process.env.CORDIAL_DAILY_LIMIT || "40", 10);

const out = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
const admin = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const SYSTEM = `You are Cordial, the friendly AI agent inside "Cordial Co-Parenting", a private hub where separated parents and family share a calendar, messages, expenses, documents, meetings, notes, trips and visits, and video calls.
Always be clear that you are an AI if asked. You are not a lawyer, doctor, therapist or mediator.
Style: warm, calm, plain words, short answers (usually under 150 words). Use short paragraphs or a few simple bullet points. No headings.
Help with: co-parenting communication and conflict, routines, hand-overs, talking to children about separation, scheduling, keeping records, drafting short polite messages the person can send, and using the hub.
Hub help you know: Calendar and Meetings (attended, missed, rescheduled), Notes (editable, shows last edit), Trips and Visits (upload tickets, hotels, expenses), Documents (open inside the hub; download or share), Messages (private chats and groups, voice notes, reply by swiping, edit within 1 hour), Calls (tap the video or phone icon in a chat; the other person's phone rings), Alerts (turn on in Account and settings for the icon number and ringing when closed; on iPhone open from the Home Screen icon), Face ID lock (Account and settings).
Where things are: the hub has two looks (Account and settings > Interface). Social look: bottom bar with Home, Photos and videos, Notifications, Profile, and a Menu button that opens every section: Schedule, Expenses, Notes, Meetings, Kids, Documents, Messages, Timeline, Media, Notifications, Profile, Calls, People, Trips and Visits, Access (owner only) and Help. Classic look: the same sections as tabs across the top. Tapping Messages or Calls opens the chat area with tabs Chats, Updates, Calls and You. In Chats: the + button starts a new chat or group; swipe a chat right for Unread and Pin (up to 3 pinned chats), swipe left for More and Archive; inside a chat, swipe a message left to reply, press and hold a message for actions (react, copy, edit within 1 hour, pin up to 3 messages, delete); the + beside the message box adds photos, documents, contacts and location; the microphone records a voice note. The Cordial chat is in the Chats list. Account and settings (on the Menu / Home page) holds Interface, Alerts, Face ID lock, Sound, Reaction skin tone, Take a tour and Log out. Only the owner sees Access, where members and permissions are managed. Tapping a saved document opens it inside the hub with Download and Share. If you are not sure exactly where something is, say so and describe the nearest place instead of guessing.
Camera or microphone keeps asking on iPhone: Settings > Apps > Safari > Camera and Microphone set to Allow; in Safari tap "aA" > Website Settings > Allow both. Android Chrome: tap the lock icon by the address > Permissions > Allow.
Be even-handed. Never take sides against the other parent, never help hide a child, harass, track or intimidate anyone. For legal questions, give general information and suggest a family lawyer or local family court services. For medical or mental-health worries, suggest a doctor or counsellor. If a child or anyone is in immediate danger, tell them to contact local emergency services right away.
Stay strictly on co-parenting and using this hub: parenting, children's needs, schedules, hand-overs, expenses, school and health logistics, communication with the other parent, family support, and how the hub works. If asked about anything else (general knowledge, coding, homework, news, entertainment, politics, shopping, other businesses), reply in one or two kind sentences that you only help with co-parenting and the hub, and offer a co-parenting-related alternative. Do not answer the off-topic question even partly.
You cannot see anyone's private messages or calendar. You CAN prepare actions with your tools when the person clearly asks: create_event (put an event on the shared calendar), create_request (post a request to the other parent or a family member), create_post (a timeline post), save_document (file the document or photo they attached into Documents). The person always sees a Confirm button before anything is saved, so never say it is already done; say you have prepared it and ask them to tap Confirm. Only use a tool when asked; otherwise just answer. Resolve dates like "next Friday" from today's date (given below) and use YYYY-MM-DD. Ask a short question if the date, or what to write, is missing. Keep request and post text polite, neutral and in the person's own voice, without blame.
If a photo or PDF is attached, describe what is relevant to co-parenting (for example a school letter, receipt, medical note, schedule) and help with it. If the attachment is unrelated to co-parenting, say so kindly. If you don't know, say so.`;

const TOOLS = [
  { name: "create_event", description: "Add an event to the shared hub calendar.", input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, title: { type: "string", description: "Short event name" }, time: { type: "string", description: "Optional HH:MM 24h" }, whose_day: { type: "string", enum: ["a", "b", "other"], description: "Optional: a = first parent, b = second parent, other = neither/shared. Default other." } }, required: ["date", "title"] } },
  { name: "create_request", description: "Post a polite request to the other parent or a family member on the hub timeline.", input_schema: { type: "object", properties: { to: { type: "string", description: "Optional first name of the person it is for" }, text: { type: "string", description: "The request, written politely" } }, required: ["text"] } },
  { name: "create_post", description: "Make a post on the hub timeline.", input_schema: { type: "object", properties: { text: { type: "string" }, attach_image: { type: "boolean", description: "True to include the attached photo" } }, required: ["text"] } },
  { name: "save_document", description: "Save the attached photo or file into Documents.", input_schema: { type: "object", properties: { title: { type: "string" }, category: { type: "string", enum: ["Medical", "School", "Legal", "Financial", "Other"] } }, required: ["title", "category"] } },
];
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
function cleanAction(t, i, a) {
  a = a || {};
  const id = "a" + Date.now().toString(36) + i;
  if (t === "create_event" && /^\d{4}-\d{2}-\d{2}$/.test(a.date || "") && a.title) return { id, type: "event", date: a.date, title: clip(a.title, 80), time: /^\d{2}:\d{2}$/.test(a.time || "") ? a.time : "", who: a.whose_day === "a" || a.whose_day === "b" ? a.whose_day : "x" };
  if (t === "create_request" && a.text) return { id, type: "request", to: clip(a.to, 40), text: clip(a.text, 1000) };
  if (t === "create_post" && a.text) return { id, type: "post", text: clip(a.text, 2000), image: !!a.attach_image };
  if (t === "save_document" && a.title) return { id, type: "doc", title: clip(a.title, 80), cat: ["Medical", "School", "Legal", "Financial", "Other"].includes(a.category) ? a.category : "Other" };
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") return out(405, { error: "post_only" });
  if (!URL_ || !KEY || !AKEY) return out(501, { error: "not_configured" });

  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin" });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin" });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=name,is_owner`, { headers: admin });
  const m = (mr.ok ? await mr.json() : [])[0];
  if (!m) return out(403, { error: "forbidden" });

  const getDoc = async (k) => { const r = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(k)}&select=data`, { headers: admin }); return ((r.ok ? await r.json() : [])[0] || {}).data || {}; };
  const putDoc = (k, data) => fetch(`${URL_}/rest/v1/docs?on_conflict=key`, { method: "POST", headers: { ...admin, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: k, collection: "aiuse", id: k.split("/")[1], data }) });
  const cost = (a, c) => (Math.max(0, (a.in || 0) - (c.in || 0)) * PIN + Math.max(0, (a.out || 0) - (c.out || 0)) * POUT) / 1e6;
  if (event.httpMethod === "GET" || (event.httpMethod === "POST" && event.body && event.body.indexOf('"setBudget"') > -1)) {
    if (!m.is_owner) return out(403, { error: "owner_only" });
    if (event.httpMethod === "POST") {
      let q = {}; try { q = JSON.parse(event.body || "{}"); } catch {}
      const amt = parseFloat(q.setBudget);
      if (!(amt >= 0 && amt < 100000)) return out(400, { error: "bad" });
      const tot0 = await getDoc("aiuse/total");
      await putDoc("aiuse/budget", { amount: amt, in: tot0.in || 0, out: tot0.out || 0, ts: Date.now() });
    }
    const tot = await getDoc("aiuse/total"), bud = await getDoc("aiuse/budget");
    const spent = cost(tot, bud.amount != null ? bud : {});
    return out(200, { model: MODEL, n: tot.n || 0, tokensIn: tot.in || 0, tokensOut: tot.out || 0, spentAll: cost(tot, {}), budget: bud.amount != null ? bud.amount : null, spent, left: bud.amount != null ? Math.max(0, bud.amount - spent) : null, rates: { in: PIN, out: POUT }, limit: LIMIT });
  }
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });

  // daily limit per person
  const day = new Date().toISOString().slice(0, 10);
  const id = `${me.id}_${day}`, key = `aiuse/${id}`;
  const ur = await fetch(`${URL_}/rest/v1/docs?key=eq.${encodeURIComponent(key)}&select=data`, { headers: admin });
  const used = ((ur.ok ? await ur.json() : [])[0] || {}).data || {};
  const n = used.n || 0;
  if (n >= LIMIT) return out(429, { error: "limit", limit: LIMIT });

  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch {}
  let msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter((x) => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string" && x.content.trim())
    .map((x) => ({ role: x.role, content: x.content.slice(0, 2000) }))
    .slice(-12);
  // must start with a user turn and alternate
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  const merged = [];
  for (const x of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === x.role) last.content += "\n" + x.content; else merged.push({ ...x });
  }
  if (!merged.length || merged[merged.length - 1].role !== "user") return out(400, { error: "bad" });
  // optional attachment on the latest user turn (client shrinks photos; PDFs are passed through)
  const at = b.attachment;
  if (at && typeof at.data === "string" && at.data.length < 4800000) {
    const last = merged[merged.length - 1], blocks = [];
    if (at.kind === "image" && /^image\/(jpeg|png|webp|gif)$/.test(at.media || "")) blocks.push({ type: "image", source: { type: "base64", media_type: at.media, data: at.data } });
    else if (at.kind === "pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: at.data } });
    if (blocks.length) { blocks.push({ type: "text", text: last.content }); last.content = blocks; }
  }
  const nameOnly = at && at.name && !(at.data) ? `\n[The person attached a file named "${clip(at.name, 80)}" that you cannot open.]` : "";
  if (nameOnly) merged[merged.length - 1].content += nameOnly;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const tp = (k) => (today.find((x) => x.type === k) || {}).value;
  const todayStr = `${tp("weekday")} ${tp("year")}-${tp("month")}-${tp("day")} (Africa/Lagos)`;
  let names = "";
  try { const nr = await fetch(`${URL_}/rest/v1/docs?key=eq.settings%2Fnames&select=data`, { headers: admin }); const nd = ((nr.ok ? await nr.json() : [])[0] || {}).data || {}; names = ` The two parents are called "${clip(nd.a || "Parent 1", 30)}" (a) and "${clip(nd.b || "Parent 2", 30)}" (b).`; } catch {}

  let reply = "", actions = [], usage = {};
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 800, tools: TOOLS, system: SYSTEM + `\nToday is ${todayStr}.${names} The person you are talking to is called ${String(m.name || "a member").slice(0, 40)}.`, messages: merged }),
    });
    if (!r.ok) {
      let e = {}; try { e = await r.json(); } catch {}
      return out(502, { error: "ai_failed", status: r.status, detail: String((e.error && e.error.message) || "").slice(0, 160) });
    }
    const j = await r.json();
    reply = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    usage = j.usage || {};
    actions = (j.content || []).filter((c) => c.type === "tool_use").map((c, i) => cleanAction(c.name, i, c.input)).filter(Boolean).slice(0, 3);
    if (!reply && actions.length) reply = "I’ve prepared this for you. Please check it and tap Confirm.";
  } catch (e) {
    return out(502, { error: "ai_failed", detail: String(e && e.message || e).slice(0, 120) });
  }
  if (!reply) return out(502, { error: "empty" });

  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...admin, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, collection: "aiuse", id, data: { n: n + 1, day } }),
  });
  try { const tt = await getDoc("aiuse/total"); await putDoc("aiuse/total", { in: (tt.in || 0) + (usage.input_tokens || 0), out: (tt.out || 0) + (usage.output_tokens || 0), n: (tt.n || 0) + 1 }); } catch {}
  return out(200, { reply, actions, left: Math.max(0, LIMIT - n - 1) });
};
