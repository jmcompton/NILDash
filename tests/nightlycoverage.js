'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js               every suite, against the committed baseline
//   node tests/nightlycoverage.js   just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── WHO THE NIGHT RAN, AND THE ATHLETES THE LOCAL LANE CANNOT PLACE ────────
//   1. scripts/nightly-coverage: every athlete-night is classified by the rule
//      that decided it (ran, slots full, paused, not reached, unfinished,
//      skipped, no row, error), read from outreach_queue_runs.
//   2. services/schoolCheck: no school, a pro team typed as the school, a pro
//      with no city, a school the run could not find; the one-click fix only
//      where the record determines it; the agent's list; Home shows it.
const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const AG = 'nc-agent', AG2 = 'nc-agent-dormant';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const SC = require(REPO + 'server/services/schoolCheck.js');
  const NC = require(REPO + 'scripts/nightly-coverage.js');
  const Job = require(REPO + 'server/jobs/outreachQueue.js');

  // ── 1. CLASSIFY ─────────────────────────────────────────────────────────
  OUT.push('-- every athlete-night has a rule --');
  const fin = (details, extra) => ({ finished_at: new Date(), filled: 0, note: null, details, ...extra });
  const c = (run, id) => NC.classify(run, id || 'x').cls;
  ok('no run row for the agent: NO-ROW', c(null) === 'NO-ROW');
  ok('a "skipped: ..." row: SKIP, with the note', c(fin([], { note: 'skipped: dormant, last login 20 days ago' })) === 'SKIP');
  ok('claimed, never finished: UNFIN', c({ finished_at: null, details: null, created_at: new Date() }) === 'UNFIN');
  ok('a finished run without them: NOT-REACHED', c(fin([{ athleteId: 'y', loop: {} }])) === 'NOT-REACHED');
  ok('the loop ran: RAN', c(fin([{ athleteId: 'x', loop: { held: 5 }, filled: 5 }])) === 'RAN');
  ok('five unactioned cards: FULL', c(fin([{ athleteId: 'x', emptyReason: 'slots-full', note: 'all 5 slots already hold work' }])) === 'FULL');
  ok('the backoff: PAUSED', c(fin([{ athleteId: 'x', paused: true, emptyReason: 'paused' }])) === 'PAUSED');
  ok('a throw: ERROR', c(fin([{ athleteId: 'x', error: 'boom' }])) === 'ERROR');

  // ── 2. THE SCHOOL CHECK ─────────────────────────────────────────────────
  OUT.push('', '-- the school check --');
  const pf = (d, o) => SC.problemFor({ data: d }, o);
  const jy = pf({ name: 'Jared Young', school: 'New York Mets' });
  ok('"New York Mets" in the school field: a pro team, fix = pro, New York Mets, New York, NY',
    jy && jy.code === 'team-in-school' && jy.fix.athleteType === 'pro' && jy.fix.team === 'New York Mets' && jy.fix.city === 'New York, NY', jy);
  const cf = pf({ name: 'Clint Frazier' });
  ok('no school on file: flagged, and no fix is guessed', cf && cf.code === 'no-school' && !cf.fix, cf);
  ok('a real school is not flagged; neither is a nickname a school could carry', pf({ name: 'A', school: 'Auburn University' }) === null && pf({ name: 'A', school: 'Cardinals' }) === null);
  ok('a pro with a team but no city: the team names the city', (pf({ name: 'B', athleteType: 'pro', team: 'Denver Broncos' }) || {}).fix?.city === 'Denver, CO');
  ok('a pro with a city is fine', pf({ name: 'B', athleteType: 'pro', team: 'Denver Broncos', city: 'Denver, CO' }) === null);
  ok('a school last night\'s run could not find: unresolved', (pf({ name: 'C', school: 'Nowhere Tech' }, { noMarketLastNight: true }) || {}).code === 'unresolved');

  // ── 3. THE AGENT'S LIST AND THE ONE-CLICK FIX, IN THE DATABASE ─────────
  OUT.push('', '-- the list and the fix --');
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id IN ($1,$2)`, [AG, AG2]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id IN ($1,$2)`, [AG, AG2]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id IN ($1,$2)`, [AG, AG2]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,last_login) VALUES ($1,'Rex Kaplan','nc-a@x.test','x','agent',NOW()), ($2,'Dora Mant','nc-d@x.test','x','agent',NOW() - INTERVAL '30 days')`, [AG, AG2]);
  const ath = (id, agent, d) => P.query(`INSERT INTO athletes (id, agent_id, data, created_at) VALUES ($1,$2,$3::jsonb, NOW() - INTERVAL '30 days')`, [id, agent, JSON.stringify(d)]);
  await ath('nc-jy', AG, { name: 'Jared Young', sport: 'Baseball', school: 'New York Mets' });
  await ath('nc-cf', AG, { name: 'Clint Frazier', sport: 'Baseball' });
  await ath('nc-ok', AG, { name: 'Ok Athlete', sport: 'Soccer', school: 'Auburn University' });
  await ath('nc-nf', AG, { name: 'Nina Far', sport: 'Soccer', school: 'Nowhere Tech' });
  await ath('nc-dm', AG2, { name: 'Dee Dormant', sport: 'Soccer', school: 'Auburn University' });
  const today = Job.today();
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, finished_at) VALUES ($1, $2::date, 5, $3::jsonb, NOW())`,
    [AG, today, JSON.stringify([{ athleteId: 'nc-ok', loop: { held: 5 }, filled: 5 }, { athleteId: 'nc-nf', noMarket: true, loop: { held: 2 }, filled: 2 },
      { athleteId: 'nc-jy', emptyReason: 'slots-full', note: 'all 5 slots already hold work you have not actioned' }])]);
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, note, details, finished_at) VALUES ($1, $2::date, 0, 'skipped: dormant, last login 30 days ago', '[]'::jsonb, NOW())`, [AG2, today]);
  const list = await SC.forAgent(P, AG);
  const codes = Object.fromEntries(list.map((x) => [x.name, x.code]));
  ok('the agent\'s list: Jared Young (team-in-school), Clint Frazier (no-school), Nina Far (unresolved, from last night); not the athlete who is fine',
    codes['Jared Young'] === 'team-in-school' && codes['Clint Frazier'] === 'no-school' && codes['Nina Far'] === 'unresolved' && !codes['Ok Athlete'], codes);
  const r1 = await SC.applyFix(P, AG, 'nc-jy');
  const jyRow = (await P.query(`SELECT data FROM athletes WHERE id = 'nc-jy'`)).rows[0].data;
  ok('the one-click fix makes Jared Young a pro on the New York Mets in New York, NY, and clears the school',
    r1.ok && jyRow.athleteType === 'pro' && jyRow.team === 'New York Mets' && jyRow.city === 'New York, NY' && !jyRow.school, jyRow);
  const AR = require(REPO + 'server/services/athleteRecord.js');
  ok('  and the local lane now has a market: New York, NY', AR.resolveAthlete({ data: jyRow }, {}).market === 'New York, NY', AR.resolveAthlete({ data: jyRow }, {}).market);
  ok('no fix is applied where the record does not say (Clint Frazier: the agent must type it)', (await SC.applyFix(P, AG, 'nc-cf')).status === 409);
  ok('another agent cannot apply a fix to this roster', (await SC.applyFix(P, AG2, 'nc-cf')).status === 404);

  // ── 4. THE SCRIPT OVER THE FIXTURE ──────────────────────────────────────
  OUT.push('', '-- the coverage script --');
  const out = execFileSync(process.execPath, [REPO + 'scripts/nightly-coverage.js', '--days', '2'], { env: { ...process.env, INIT_WAIT_MS: '2500' }, encoding: 'utf8' });
  const line = (n) => (out.split('\n').find((l) => l.includes(n)) || '');
  ok('per athlete: Ok Athlete ran tonight (R), Jared Young was full (F), Clint Frazier not reached (N)',
    /R\s+Ok Athlete/.test(line('Ok Athlete')) && /F\s+Jared Young/.test(line('Jared Young')) && /N\s+Clint Frazier/.test(line('Clint Frazier')), [line('Ok Athlete'), line('Jared Young'), line('Clint Frazier')]);
  ok('  the dormant agent\'s athlete reads S, and the agent is listed as DORMANT with the reason',
    /S\s+Dee Dormant/.test(line('Dee Dormant')) && /Dora Mant.*DORMANT: last login 30 days ago/.test(out), line('Dora Mant'));
  ok('  the school problem is named on the athlete\'s line', /Clint Frazier.*\[no-school\]/.test(line('Clint Frazier')));
  const one = execFileSync(process.execPath, [REPO + 'scripts/nightly-coverage.js', '--days', '1', '--athlete', 'frazier'], { env: { ...process.env, INIT_WAIT_MS: '2500' }, encoding: 'utf8' });
  ok('--athlete narrows to one and prints the reason for each night', /Clint Frazier/.test(one) && /NOT-REACHED\s+not in the finished run/.test(one) && !/Ok Athlete/.test(one), one.slice(-400));

  // ── 5. WIRED ────────────────────────────────────────────────────────────
  OUT.push('', '-- wired --');
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8'), html = fs.readFileSync(REPO + 'public/index.html', 'utf8'), job = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('routes: the agent\'s list and the one-click fix, both behind the agent\'s session',
    /app\.get\('\/api\/agent\/athletes\/needs-fix', requireAuth/.test(idx) && /app\.post\('\/api\/agent\/athletes\/:id\/apply-fix', requireAuth/.test(idx));
  ok('Home loads it, with the fix button and Edit', /loadPinnedDeliverables\(\); loadNeedsFix\(\);/.test(html) && /id="home-needs-fix"/.test(html) && /applyNeedsFix\(/.test(html));
  ok('the nightly detail names the school problem', /schoolProblem: \(require\('\.\.\/services\/schoolCheck'\)\.problemFor\(ath/.test(job));
  ok('both scripts are on the admin script list', /'nightly-coverage': \{ file: 'scripts\/nightly-coverage\.js'/.test(idx) && /'school-problems': \{ file: 'scripts\/school-problems\.js'/.test(idx));

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
