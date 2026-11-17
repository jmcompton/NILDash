'use strict';
// node tests/nightreport.js  (local test Postgres)
// ── LAST NIGHT, ATHLETE BY ATHLETE (services/nightReport) ────────────────────
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('nightreporttest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const NR = require(REPO + 'server/services/nightReport.js');
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('nr-a','Avery Stone','avery@nr.test','x','agent')`);
  const details = [
    { athleteId: 'a1', athleteName: 'Jordan Lake', filled: 3, emptyReason: null, nightFaults: [] },
    { athleteId: 'a2', athleteName: 'Riley Moss', filled: 0, emptyReason: 'our-fault', note: 'nothing tonight because of our failure, not this market: hunter: HTTP 429', nightFaults: [{ service: 'hunter', reason: 'HTTP 429 <rate limited>' }] },
    { athleteId: 'a3', athleteName: 'Sam Vale', filled: 0, emptyReason: 'slots-full', nightFaults: [] },
  ];
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details) VALUES ('nr-a', CURRENT_DATE, 3, $1)`, [JSON.stringify(details)]);
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details) VALUES ('nr-a', CURRENT_DATE - 10, 1, '[]')`);
  const list = await NR.nights(P, { days: 3 });
  ok('recent nights only, with the agent and each athlete', list.length === 1 && list[0].agent === 'Avery Stone' && list[0].athletes.length === 3, list);
  const riley = list[0].athletes.find((x) => x.name === 'Riley Moss');
  ok('an empty athlete carries the reason and our failure with the provider\'s words', riley.reason === 'our-fault' && riley.faults[0] === 'hunter: HTTP 429 <rate limited>', riley);
  const t = NR.tally(list);
  ok('the tally counts empty athletes by cause', JSON.stringify(t) === JSON.stringify([['our failure: hunter', 1], ['slots-full', 1]]), t);
  const html = NR.renderHtml(list);
  ok('the page names the athlete, the cause, and escapes provider text', /Riley Moss/.test(html) && /our failure, not the market/.test(html) && /&lt;rate limited&gt;/.test(html) && !/<rate limited>/.test(html));
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('admin only, page and JSON', /app\.get\('\/admin\/night-report', async \(req, res\) => \{\n  if \(!\(await _statusAdminOk\(req\)\)\)/.test(idx) && /app\.get\('\/api\/admin\/night-report'/.test(idx));
  console.log(OUT.join('\n')); console.log(`\n${OUT.length - F}/${OUT.length} passed`); process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
