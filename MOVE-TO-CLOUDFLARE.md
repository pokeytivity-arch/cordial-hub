# Moving the hub from Netlify to Cloudflare

This branch (`cloudflare`) adds three files and changes nothing else:
- `worker.js` – serves /api/<name> using the same function code as before, and runs the scheduled jobs.
- `wrangler.jsonc` – Cloudflare settings (one cron trigger every 5 minutes decides which jobs are due).
- `.assetsignore` – keeps the function source out of the public website.

## Steps
1. Cloudflare dashboard → Workers & Pages → Create → Import a repository → `cordial-hub`, branch `cloudflare`.
   Leave the build command empty. The deploy command stays `npx wrangler deploy`.
2. Settings → Variables and secrets. Copy every value from Netlify (Site configuration → Environment variables):
   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
   JAAS_APP_ID, JAAS_KID, JAAS_PRIVATE_KEY, ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_MEETING_NUMBER,
   ZOOM_MEETING_PASSCODE, ZOOM_SDK_KEY, ZOOM_SDK_SECRET, ZOOM_WEBHOOK_SECRET, YT_CHANNEL_ID, YT_NOTIFY (and any of
   ANTHROPIC_MODEL, CORDIAL_DAILY_LIMIT, CORDIAL_PRICE_IN, CORDIAL_PRICE_OUT, YT_EXTRA_SEEDS, YT_SEED_VIDEO you use).
   Add them as "Secret" type. Change `URL` in wrangler.jsonc to the hub's real address.
3. Test on the free *.workers.dev address first: sign in, send a message, Ask Cordial, start a call.
4. Custom domain: Settings → Domains & Routes → Add. Use the SAME address people already use, so logins and
   notification permissions carry over.
5. Update the places that know the address: Zoom Marketplace app (event notification URL
   https://YOUR-ADDRESS/api/zoom-webhook), Supabase → Authentication → URL configuration.
6. When all works: merge `cloudflare` into `main`, set Cloudflare's production branch to `main`, then pause and delete the Netlify site.
