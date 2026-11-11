// Watchdog for the fresh-install event-log snapshot (relayer/events-seed.ts). Read only, no dependencies.
// Exits 1 when the snapshot is missing, the hourly cron is failing, or its last success is older than 3 hours:
// a stale snapshot means new installs fetch too much history from the public RPC and get 429 again.
//   node scripts/seed-watch.mjs [base url, default https://api.h081.xyz]
const base = (process.argv[2] || 'https://api.h081.xyz').replace(/\/$/, '');
const MAX_AGE_S = 3 * 3600;
const problems = [];
let status;
try {
  const res = await fetch(`${base}/events/status`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) problems.push(`GET /events/status answered ${res.status}`);
  else status = await res.json();
} catch (e) { problems.push(`GET /events/status failed: ${e.message}`); }
if (status) {
  if (status.ageSeconds === null || status.ageSeconds === undefined) problems.push('the cron has never succeeded');
  else if (status.ageSeconds > MAX_AGE_S) problems.push(`the last successful run was ${(status.ageSeconds / 3600).toFixed(1)} h ago (limit 3 h)`);
  if (status.failing) problems.push(`the last run failed: ${status.error}`);
  try {
    const snap = await fetch(`${base}/events/${status.file}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (snap.status !== 307) problems.push(`GET /events/${status.file} answered ${snap.status}, expected a 307 to the snapshot`);
  } catch (e) { problems.push(`GET /events/${status.file} failed: ${e.message}`); }
}
if (problems.length) { console.error(`seed snapshot NOT healthy at ${base}:\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`seed snapshot healthy: ${status.events} events, last run ${Math.round(status.ageSeconds / 60)} min ago${status.partial ? ' (still catching up)' : ''}`);
