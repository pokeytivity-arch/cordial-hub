// Runs before the Hub's functions load. If a secret was pasted as the whole Netlify export table
// ("| Production | value |"), keep only the Production value, and trim stray spaces from every value.
function cleanVal(v) {
  if (typeof v !== "string") return v;
  const m = v.match(/\|\s*Production\s*\|\s*([\s\S]*?)\s*\|\s*(?:\r?\n|$)/);
  return (m ? m[1] : v).trim();
}
export function cleanEnv(env) {
  try {
    const keys = Object.keys(env || {});
    for (const k of keys) if (typeof env[k] === "string") { const c = cleanVal(env[k]); if (c !== env[k]) env[k] = c; }
  } catch {}
}
try { cleanEnv(process.env); } catch {}
