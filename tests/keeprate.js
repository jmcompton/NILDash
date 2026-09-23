'use strict';
// Runs against the local test Postgres. No network.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/keeprate.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE KEEP RATE IS IN THE RUN REPORT ──────────────────────────────────────
// Discovery's definition of done is five cards a night the agent KEEPS. The
// run report counted cards written and never asked what became of them.
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const KR = require(REPO + 'server/services/keepRate.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const AG = 'kr-agent', A1 = 'kr-ath-1', A2 = 'kr-ath-2', EMAIL = 'kr-agent@example.com';
const N1 = '2099-05-11', N2 = '2099-05-12';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query('DELETE FROM outreach_queue WHERE agent_id = $1', [AG]).catch(() => {});
    await P.query('DELETE FROM outreach_queue_runs WHERE agent_id = $1', [AG]).catch(() => {});
    await P.query('DELETE FROM athletes WHERE agent_id = $1', [AG]).catch(() => {});
    await P.query('DELETE FROM users WHERE id = $1', [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Kay Reed',$2,'x','agent')`, [AG, EMAIL]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$3,'{"name":"Amari Allen"}'),($2,$3,'{"name":"Jo Doe"}')`, [A1, A2, AG]);
  let slot = 0;
  // One card, created at a Central wall-clock time, in a given state.
  const card = (ath, night, hhmm, state) => P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, created_at)
     VALUES ($1, $2, $3, $4, $4, 'dm', $5, ($6::timestamp AT TIME ZONE 'America/Chicago'))`,
    [AG, ath, ++slot, 'kr brand ' + slot, state, `${night} ${hhmm}`]);
  // Night 1, the nightly run (2:30am): Amari 3 kept, 1 skipped, 1 expired; Jo 1 kept, 2 skipped, 1 waiting.
  for (const s of ['sent', 'sent', 'sent', 'skipped', 'expired']) await card(A1, N1, '02:30', s);
  for (const s of ['sent', 'skipped', 'skipped', 'queued']) await card(A2, N1, '02:40', s);
  // The same day, an on-demand fill at 2pm: kept apart from the night.
  for (const s of ['skipped', 'skipped']) await card(A1, N1, '14:00', s);
  // Night 2: Amari 2 kept, nothing skipped.
  for (const s of ['sent', 'sent', 'queued']) await card(A1, N2, '03:10', s);
  // A card from 4:59am is the night's; 5:00am is not.
  await card(A2, N2, '04:59', 'sent');
  await card(A2, N2, '05:00', 'skipped');
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, finished_at)
                 VALUES ($1,$2,9,'[]'::jsonb,NOW()),($1,$3,4,'[]'::jsonb,NOW())`, [AG, N1, N2]);

  // ── 1. THE NUMBERS ──────────────────────────────────────────────────────
  OUT.push('-- the keep rate --');
  const sum = KR.summarise(await KR.keepRateRows(P, AG, { days: 40000 }));
  const n1 = sum.find((x) => x.night === N1), n2 = sum.find((x) => x.night === N2);
  ok('two nights', sum.length === 2 && n1 && n2, sum.map((x) => x.night));
  ok('NIGHT 1: 4 kept of 7 decided (expired and waiting left out)',
    n1.nightly.placed === 9 && n1.nightly.kept === 4 && n1.nightly.skipped === 3
    && n1.nightly.expired === 1 && n1.nightly.waiting === 1 && Math.abs(n1.nightly.rate - 4 / 7) < 1e-9, n1.nightly);
  ok('  the 2pm on-demand fill is counted apart, not in the night',
    n1.onDemand.placed === 2 && n1.onDemand.skipped === 2 && n1.onDemand.rate === 0, n1.onDemand);
  const amari = n1.athletes.find((a) => a.name === 'Amari Allen'), jo = n1.athletes.find((a) => a.name === 'Jo Doe');
  ok('PER ATHLETE: Amari kept 3 of 4', amari && amari.kept === 3 && amari.skipped === 1 && amari.rate === 0.75, amari);
  ok('  Jo kept 1 of 3', jo && jo.kept === 1 && jo.skipped === 2 && Math.abs(jo.rate - 1 / 3) < 1e-9, jo);
  ok('NIGHT 2: the 4:59am card is the night\'s, the 5:00am one is on-demand',
    n2.nightly.placed === 4 && n2.nightly.kept === 3 && n2.nightly.skipped === 0 && n2.onDemand.placed === 1, n2);
  ok('  and with nothing skipped the rate is 100%', n2.nightly.rate === 1 && KR.pct(n2.nightly.rate) === '100%');
  ok('no decisions at all is n/a, never 0% or 100%', KR.rate(0, 0) === null && KR.pct(null) === 'n/a');

  // ── 2. THE REPORT PRINTS IT ─────────────────────────────────────────────
  OUT.push('', '-- the admin run report --');
  let text = '';
  try {
    text = execFileSync(process.execPath, [REPO + 'scripts/nightly-run-report.js', '--agent', EMAIL, '--nights', '2'],
      { encoding: 'utf8', env: { ...process.env, INIT_WAIT_MS: '6000' }, timeout: 90000 });
  } catch (e) { text = String(e.stdout || '') + String(e.stderr || ''); }
  ok('the report has a KEEP RATE section', /KEEP RATE \(nightly-run cards/.test(text), text.slice(0, 400));
  ok('  a row per night with the rate', /2099-05-11\s+9\s+4\s+3\s+1\s+1\s+57%/.test(text) && /2099-05-12\s+4\s+3\s+0\s+0\s+1\s+100%/.test(text),
    (text.match(/2099-05-1\d .*/g) || []));
  ok('  the on-demand fill beside it, not in it', /2099-05-11.*\+ 2 on-demand \(keep 0%\)/.test(text));
  ok('  and a window total', /window\s+13\s+7\s+3\s+1\s+2\s+70%/.test(text), (text.match(/window.*/) || [])[0]);
  ok('each night lists its athletes\' keep rates',
    /Amari Allen\s+placed 5, kept 3, skipped 1, expired 1, waiting 0\s+->\s+keep rate 75% \(3 of 4 decided\)/.test(text)
    && /Jo Doe\s+placed 4, kept 1, skipped 2, expired 0, waiting 1\s+->\s+keep rate 33% \(1 of 3 decided\)/.test(text),
    (text.match(/(Amari Allen|Jo Doe)\s+placed.*/g) || []));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('keeprate: FAILED', e); process.exit(1); });
