'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/removeathlete.js    just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── AN ATHLETE WHO SHOULD NEVER HAVE BEEN IMPORTED IS REMOVED WHOLE ────────
//
// The row, the queued cards, the on-demand claims and the fill state go; the
// drafts behind the queued cards are cadence-stopped so Home cannot show them;
// sent cards and their logs stay as history. Dry run by default.

const store = require(REPO + 'server/store.js');
const R = require(REPO + 'scripts/remove-athlete.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'ra-agent', ATH = 'ra-ath', KEEP = 'ra-keep';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    await P().query(`DELETE FROM outreach_queue WHERE athlete_id IN ($1,$2)`, [ATH, KEEP]).catch(() => {});
    await P().query(`DELETE FROM outreach_logs WHERE id LIKE 'ra-log-%'`).catch(() => {});
    await P().query(`DELETE FROM outreach_queue_ondemand WHERE athlete_id IN ($1,$2)`, [ATH, KEEP]).catch(() => {});
    await P().query(`DELETE FROM athlete_state WHERE athlete_id IN ($1,$2)`, [ATH, KEEP]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE id IN ($1,$2)`, [ATH, KEEP]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Greg Test','ra-agent@x.com','x','agent')`, [AG]);
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3), ($4,$2,$5)`,
    [ATH, AG, { name: 'Lydia Test', sport: 'ice hockey', school: 'North Yarmouth Academy', importedFrom: 'csv' }, KEEP, { name: 'Keep Me', sport: 'golf', school: 'Wofford College' }]);
  // Two queued cards with drafts, one sent card, for the athlete; one queued card for the other athlete.
  const logCols = (await P().query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'outreach_logs'`)).rows.map((r) => r.column_name);
  const mkLog = async (id) => {
    const cols = ['id', 'agent_id', 'athlete_id', 'brand_name'].filter((c) => logCols.includes(c));
    const vals = { id, agent_id: AG, athlete_id: ATH, brand_name: 'Brand ' + id };
    await P().query(`INSERT INTO outreach_logs (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map((c) => vals[c])).catch(() => {});
  };
  await mkLog('ra-log-1'); await mkLog('ra-log-2');
  const mkCard = (ath, slot, state, logId) => P().query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, channel, state, identity_key, outreach_log_id)
     VALUES ($1,$2,$3,$4,$5,'why','email',$6,$7,$8)`, [AG, ath, slot, 'k-' + ath + slot, 'Brand ' + slot, state, 'id-' + ath + slot, logId]);
  await mkCard(ATH, 1, 'queued', 'ra-log-1'); await mkCard(ATH, 2, 'queued', 'ra-log-2'); await mkCard(ATH, 3, 'sent', null);
  await mkCard(KEEP, 1, 'queued', null);
  await P().query(`INSERT INTO outreach_queue_ondemand (athlete_id, run_date) VALUES ($1, '2099-01-01')`, [ATH]).catch(() => {});
  await P().query(`INSERT INTO athlete_state (athlete_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ATH]).catch(() => {});

  // ── 1. THE DRY RUN SEES EVERYTHING AND CHANGES NOTHING ───────────────────
  OUT.push('-- the dry run --');
  const info = await R.inspect(P(), ATH);
  ok('the athlete and the roster are named', info && info.athlete.name === 'Lydia Test' && info.athlete.agent_email === 'ra-agent@x.com' && info.athlete.imported_from === 'csv', info && info.athlete);
  ok('  two queued cards listed, one sent card counted as history', info.queued.length === 2 && info.sent === 1, { q: info.queued.length, sent: info.sent });
  ok('  the on-demand claim and the state row counted', info.ondemand === 1 && info.state >= 0, { od: info.ondemand, st: info.state });
  ok('an unknown id is null', (await R.inspect(P(), 'ra-nope')) === null);
  const before = (await P().query(`SELECT COUNT(*)::int n FROM athletes WHERE id = $1`, [ATH])).rows[0].n;
  ok('inspect changed nothing', before === 1);

  // ── 2. THE REMOVAL ───────────────────────────────────────────────────────
  OUT.push('', '-- the removal --');
  const r = await R.remove(P(), ATH);
  ok('the athlete row is gone', r.athlete === 1 && (await P().query(`SELECT COUNT(*)::int n FROM athletes WHERE id = $1`, [ATH])).rows[0].n === 0, r);
  ok('  both queued cards are gone, the sent card stays', r.cards === 2 && (await P().query(`SELECT state FROM outreach_queue WHERE athlete_id = $1`, [ATH])).rows.map((x) => x.state).join() === 'sent');
  const stopped = (await P().query(`SELECT cadence_stop_reason FROM outreach_logs WHERE id IN ('ra-log-1','ra-log-2')`)).rows;
  ok('  the drafts behind them are cadence-stopped with the reason, not deleted', stopped.length === 2 && stopped.every((x) => x.cadence_stop_reason === 'athlete removed from the roster'), stopped);
  ok('  the on-demand claim is gone', (await P().query(`SELECT COUNT(*)::int n FROM outreach_queue_ondemand WHERE athlete_id = $1`, [ATH])).rows[0].n === 0);
  ok('the other athlete on the roster is untouched', (await P().query(`SELECT COUNT(*)::int n FROM athletes WHERE id = $1`, [KEEP])).rows[0].n === 1 && (await P().query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = $1`, [KEEP])).rows[0].n === 1);
  const Job = require(REPO + 'server/jobs/outreachQueue.js');
  const left = await Job.loadAthletesForQueue(P(), AG);
  ok('tonight\'s fill no longer lists her', left.length === 1 && left[0].id === KEEP, left.map((a) => a.id));
  const src = require('fs').readFileSync(REPO + 'scripts/remove-athlete.js', 'utf8');
  ok('the script is a dry run unless --commit, in one transaction', /const commit = flag\('commit'\)/.test(src) && /if \(!commit\) \{/.test(src) && /BEGIN/.test(src) && /COMMIT/.test(src) && /ROLLBACK/.test(src));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
