'use strict';
// ── WHO LOOKED AT THE DEMO, AND WHAT THEY DID ───────────────────────────────
//
// Reads demo_events, which the public /demo page writes through
// POST /api/demo/event (services/demoEvents). Read-only.
//
//   node scripts/demo-stats.js
//   /api/admin/scripts/demo-stats?text=1
//
// A VISIT is one session_id: the random id the page makes when it loads. Days
// and weeks are on Central time (America/Chicago), the week starting Monday.
// Bots are never written, so nothing here needs to filter them.
//
// TIME ON PAGE is a visit's first event to its last. The page sends a heartbeat
// every 30 seconds while the tab is visible and a 'leave' when it is closed or
// hidden, so the span is accurate to about half a minute. A visit that sent
// only its first event has a span of zero; the median is given both with and
// without those, because they are the people who glanced and left.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const TZ = 'America/Chicago';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 + '%' : '-');
function dur(sec) {
  if (sec == null) return '-';
  const s = Math.round(Number(sec));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  console.log('DEMO PAGE  /demo  ' + new Date().toISOString() + '  (days in Central time)\n');

  // Day and week boundaries in Central time, computed by Postgres.
  const B = `date_trunc('day', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
  const W = `date_trunc('week', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
  const v = (await P.query(`
    WITH s AS (SELECT session_id, MIN(created_at) AS first_at FROM demo_events GROUP BY session_id)
    SELECT COUNT(*) FILTER (WHERE first_at >= ${B})::int AS today,
           COUNT(*) FILTER (WHERE first_at >= ${W})::int AS week,
           COUNT(*) FILTER (WHERE first_at >= NOW() - INTERVAL '7 days')::int AS last7,
           COUNT(*)::int AS all_time,
           MIN(first_at) AS since
      FROM s`)).rows[0];
  console.log('VISITS');
  console.log(`  today                ${v.today}`);
  console.log(`  this week (from Mon) ${v.week}`);
  console.log(`  last 7 days          ${v.last7}`);
  console.log(`  all time             ${v.all_time}${v.since ? '   (since ' + new Date(v.since).toISOString().slice(0, 10) + ')' : ''}\n`);

  // ── WHERE THEY CAME FROM ─────────────────────────────────────────────────
  // The referrer recorded on each visit's 'view' event.
  const refs = (await P.query(`
    WITH s AS (
      SELECT session_id, MIN(created_at) AS first_at,
             (ARRAY_AGG(referrer ORDER BY created_at) FILTER (WHERE event = 'view'))[1] AS ref
        FROM demo_events GROUP BY session_id)
    SELECT COALESCE(ref, '(no view event)') AS ref,
           COUNT(*)::int AS all_time,
           COUNT(*) FILTER (WHERE first_at >= NOW() - INTERVAL '7 days')::int AS last7
      FROM s GROUP BY 1 ORDER BY 2 DESC LIMIT 20`)).rows;
  console.log('VISITS BY REFERRER');
  if (!refs.length) console.log('  (none yet)');
  else {
    console.log('  ' + 'source'.padEnd(32) + 'all time   last 7 days');
    for (const r of refs) console.log('  ' + String(r.ref).slice(0, 30).padEnd(32) + String(r.all_time).padStart(8) + String(r.last7).padStart(14));
  }
  console.log('');

  // ── SCREENS ──────────────────────────────────────────────────────────────
  const screens = (await P.query(`
    SELECT screen, COUNT(*)::int AS views, COUNT(DISTINCT session_id)::int AS visits
      FROM demo_events WHERE event = 'screen' AND screen IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`)).rows;
  console.log('MOST VIEWED SCREENS');
  if (!screens.length) console.log('  (none yet)');
  else {
    console.log('  ' + 'screen'.padEnd(20) + 'views   visits');
    for (const s of screens) console.log('  ' + String(s.screen).padEnd(20) + String(s.views).padStart(5) + String(s.visits).padStart(9));
  }
  console.log('');

  // ── WHAT THEY DID ────────────────────────────────────────────────────────
  const a = (await P.query(`
    SELECT COUNT(DISTINCT session_id)::int AS visits,
           COUNT(DISTINCT session_id) FILTER (WHERE event = 'deal_scan')::int     AS scan,
           COUNT(DISTINCT session_id) FILTER (WHERE event = 'pitch_open')::int    AS open,
           COUNT(DISTINCT session_id) FILTER (WHERE event = 'pitch_approve')::int AS approve,
           COUNT(DISTINCT session_id) FILTER (WHERE event = 'book_call')::int     AS book,
           COUNT(*) FILTER (WHERE event = 'book_call')::int                        AS book_clicks
      FROM demo_events`)).rows[0];
  console.log('WHAT VISITORS DID (all time; share of visits)');
  console.log(`  ran a Deal Scan      ${String(a.scan).padStart(5)}   ${pct(a.scan, a.visits)}`);
  console.log(`  opened a pitch       ${String(a.open).padStart(5)}   ${pct(a.open, a.visits)}`);
  console.log(`  approved a pitch     ${String(a.approve).padStart(5)}   ${pct(a.approve, a.visits)}`);
  console.log(`  clicked Book a call  ${String(a.book).padStart(5)}   ${pct(a.book, a.visits)}   (${a.book_clicks} click${a.book_clicks === 1 ? '' : 's'})\n`);

  // ── TIME ON PAGE ─────────────────────────────────────────────────────────
  const t = (await P.query(`
    WITH s AS (SELECT session_id, EXTRACT(EPOCH FROM MAX(created_at) - MIN(created_at)) AS sec
                 FROM demo_events GROUP BY session_id)
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY sec) AS median_all,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY sec) FILTER (WHERE sec > 0) AS median_stayed,
           COUNT(*) FILTER (WHERE sec = 0)::int AS bounced,
           COUNT(*)::int AS n
      FROM s`)).rows[0];
  console.log('TIME ON PAGE (first event to last)');
  console.log(`  median, every visit              ${dur(t.median_all)}`);
  console.log(`  median, visits that stayed       ${dur(t.median_stayed)}`);
  console.log(`  visits with only one event       ${t.bounced} of ${t.n}\n`);

  const dev = (await P.query(`
    WITH s AS (SELECT session_id, MIN(device) AS device, MIN(country) AS country FROM demo_events GROUP BY session_id)
    SELECT 'device' AS k, COALESCE(device, 'unknown') AS v, COUNT(*)::int AS n FROM s GROUP BY 2
    UNION ALL
    SELECT 'country', COALESCE(country, 'unknown'), COUNT(*)::int FROM s GROUP BY 2
    ORDER BY 1, 3 DESC`)).rows;
  const line = (k) => dev.filter((d) => d.k === k).slice(0, 8).map((d) => `${d.v} ${d.n}`).join(', ') || '(none yet)';
  console.log('DEVICE    ' + line('device'));
  console.log('COUNTRY   ' + line('country') + (dev.some((d) => d.k === 'country' && d.v !== 'unknown') ? ''
    : '   (no country header reaches the app; see services/demoEvents)'));

  try { await P.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('demo-stats: FAILED', e); process.exit(1); });
