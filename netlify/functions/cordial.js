// Cordial: the hub's AI agent. Answers co-parenting questions and hub how-tos.
// Environment variables in Netlify: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
// (optional: ANTHROPIC_MODEL, default claude-haiku-5-5; CORDIAL_DAILY_LIMIT, default 40 questions per person per day).
// The key lives only here, on the server, never in the web page.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
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
You cannot see anyone's private messages, files or calendar, and you cannot change anything in the hub. If you don't know, say so.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return out(405, { error: "post_only" });
  if (!URL_ || !KEY || !AKEY) return out(501, { error: "not_configured" });

  const token = (event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer /i, "");
  if (!token) return out(401, { error: "signin" });
  const who = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!who.ok) return out(401, { error: "signin" });
  const me = await who.json();
  const mr = await fetch(`${URL_}/rest/v1/members?user_id=eq.${me.id}&select=name`, { headers: admin });
  const m = (mr.ok ? await mr.json() : [])[0];
  if (!m) return out(403, { error: "forbidden" });

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

  let reply = "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system: SYSTEM + `\nThe person you are talking to is called ${String(m.name || "a member").slice(0, 40)}.`, messages: merged }),
    });
    if (!r.ok) {
      let e = {}; try { e = await r.json(); } catch {}
      return out(502, { error: "ai_failed", status: r.status, detail: String((e.error && e.error.message) || "").slice(0, 160) });
    }
    const j = await r.json();
    reply = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  } catch (e) {
    return out(502, { error: "ai_failed", detail: String(e && e.message || e).slice(0, 120) });
  }
  if (!reply) return out(502, { error: "empty" });

  await fetch(`${URL_}/rest/v1/docs?on_conflict=key`, {
    method: "POST", headers: { ...admin, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, collection: "aiuse", id, data: { n: n + 1, day } }),
  });
  return out(200, { reply, left: Math.max(0, LIMIT - n - 1) });
};
