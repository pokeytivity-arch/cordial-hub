// Cloudflare Worker for the hub.
// - Static files (index.html, sw.js, icons...) are served by Cloudflare's asset hosting.
// - /api/<name> runs the same function code that used to run on Netlify (netlify/functions/<name>.js).
// - One cron trigger (every 5 minutes) decides which scheduled jobs are due.
import { cleanEnv } from "./env-clean.js";
import call_reminders from "./netlify/functions/call-reminders.js";
import cordial from "./netlify/functions/cordial.js";
import daily_feed from "./netlify/functions/daily-feed.js";
import daily_tip from "./netlify/functions/daily-tip.js";
import evening_recap from "./netlify/functions/evening-recap.js";
import extra_check from "./netlify/functions/extra-check.js";
import feed_extra from "./netlify/functions/feed-extra.js";
import feed from "./netlify/functions/feed.js";
import invite from "./netlify/functions/invite.js";
import jaas_token from "./netlify/functions/jaas-token.js";
import move_notice from "./netlify/functions/move-notice.js";
import live_check from "./netlify/functions/live-check.js";
import push from "./netlify/functions/push.js";
import recap from "./netlify/functions/recap.js";
import reschedule from "./netlify/functions/reschedule.js";
import shoplatest from "./netlify/functions/shoplatest.js";
import story_cleanup from "./netlify/functions/story-cleanup.js";
import summary from "./netlify/functions/summary.js";
import task_reminders from "./netlify/functions/task-reminders.js";
import unseen_reminder from "./netlify/functions/unseen-reminder.js";
import zoom_backfill from "./netlify/functions/zoom-backfill.js";
import zoom_signature from "./netlify/functions/zoom-signature.js";
import zoom_sync from "./netlify/functions/zoom-sync.js";
import zoom_webhook from "./netlify/functions/zoom-webhook.js";

const FN = {
  "call-reminders": call_reminders, cordial, "daily-feed": daily_feed, "daily-tip": daily_tip, "evening-recap": evening_recap,
  "extra-check": extra_check, "feed-extra": feed_extra, feed, invite, "jaas-token": jaas_token,
  "live-check": live_check, "move-notice": move_notice, push, recap, reschedule, shoplatest, "story-cleanup": story_cleanup, summary,
  "task-reminders": task_reminders, "unseen-reminder": unseen_reminder, "zoom-backfill": zoom_backfill,
  "zoom-signature": zoom_signature, "zoom-sync": zoom_sync, "zoom-webhook": zoom_webhook,
};

// Same times the Netlify schedules used (all in UTC).
const DUE = [
  ["call-reminders", () => true],
  ["extra-check", (h, m) => m % 15 === 0],
  ["unseen-reminder", (h, m) => m % 30 === 0],
  ["task-reminders", (h, m) => m === 0],
  ["live-check", (h, m) => m % 10 === 0 && h >= 5 && h <= 14],
  ["daily-feed", (h, m) => h === 6 && m === 5],
  ["daily-tip", (h, m) => h === 7 && m === 0],
  ["summary", (h, m) => h === 19 && m === 30],
  ["story-cleanup", (h, m) => h === 3 && m === 30],
  ["move-notice", (h, m) => m % 15 === 0],
];

function setEnv(env) {
  // Secrets and variables from Cloudflare show up in process.env (nodejs_compat); copy and tidy them here.
  try { cleanEnv(env); for (const k of Object.keys(env || {})) if (typeof env[k] === "string") process.env[k] = env[k]; } catch {}
}
async function api(request, env, name) {
  const h = FN[name] && FN[name].handler;
  if (!h) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  let body = null;
  if (!["GET", "HEAD"].includes(request.method)) body = await request.text();
  const event = {
    httpMethod: request.method, headers, body, isBase64Encoded: false,
    path: url.pathname, rawUrl: request.url,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
  };
  const res = (await h(event, {})) || {};
  const out = new Headers(res.headers || {});
  if (res.multiValueHeaders) for (const [k, arr] of Object.entries(res.multiValueHeaders)) (arr || []).forEach((v) => out.append(k, v));
  const status = res.statusCode || 200;
  let payload = res.body == null ? null : res.body;
  if (res.isBase64Encoded && typeof payload === "string") { const bin = atob(payload); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); payload = u8; }
  if (status === 204 || status === 304) payload = null;
  return new Response(payload, { status, headers: out });
}

export default {
  async fetch(request, env, ctx) {
    setEnv(env);
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-z0-9-]+)\/?$/);
    if (m) {
      try { return await api(request, env, m[1]); }
      catch (e) { return new Response(JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } }); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    setEnv(env);
    const d = new Date(event.scheduledTime), h = d.getUTCHours(), m = d.getUTCMinutes();
    const jobs = DUE.filter(([, due]) => due(h, m)).map(([name]) => name);
    ctx.waitUntil(Promise.allSettled(jobs.map(async (name) => {
      try { await FN[name].handler({ httpMethod: "SCHEDULED", headers: {}, body: null, queryStringParameters: {} }, {}); }
      catch (e) { console.log("scheduled job failed:", name, String((e && e.message) || e)); }
    })));
  },
};
