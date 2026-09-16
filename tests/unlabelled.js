'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/unlabelled.js       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── AN UNLABELLED LEDGER ROW NAMES ITS CALLER ───────────────────────────────
//
// "unlabelled" was the second biggest line on the spend breakdown two nights
// running, with no agent and no site. Now such a row carries the first stack
// frame outside the AI plumbing, so the breakdown can print the file and line
// that made the call instead of a shrug.

const store = require(REPO + 'server/store.js');
const ai = require(REPO + 'server/ai.js');
const Ledger = require(REPO + 'server/services/aiLedger.js');
const meter = require(REPO + 'server/scanMeter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;

function stubClient(usage) {
  return { messages: { create: async (req) => ({ model: req.model, content: [{ type: 'text', text: '{"ok":true}' }], usage }) } };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await P().query(`DELETE FROM ai_call_ledger WHERE site = 'unlabelled' AND caller LIKE '%tests/unlabelled.js%'`).catch(() => {});

  OUT.push('-- the caller --');
  const here = Ledger.callerOf();
  ok('callerOf names the calling file and line, repo-relative', /^tests\/unlabelled\.js:\d+$|unlabelled\.js:\d+$/.test(String(here)), here);
  ok('  never the AI plumbing itself', !/aiLedger|scanMeter|[\\/]ai\.js/.test(String(here)));

  // An unlabelled call from THIS file, through the real entry point.
  ai._setClientForTests(stubClient({ input_tokens: 120, output_tokens: 20 }));
  await ai.oneShot('unlabelled from the test', 'sys', 100, 'claude-sonnet-4-6');
  // A labelled call, for contrast.
  await meter.label({ site: 'unlabelled-test.labelled', agentId: 'unl-ag' }, () => ai.oneShot('labelled', 'sys', 100, 'claude-sonnet-4-6'));
  await Ledger.drain();
  const rows = (await P().query(
    `SELECT site, caller, model FROM ai_call_ledger WHERE (site = 'unlabelled' AND caller LIKE '%unlabelled.js%') OR site = 'unlabelled-test.labelled' ORDER BY id DESC LIMIT 4`)).rows;
  const un = rows.find((r) => r.site === 'unlabelled');
  const lab = rows.find((r) => r.site === 'unlabelled-test.labelled');
  ok('the unlabelled row carries the caller', un && /unlabelled\.js:\d+/.test(un.caller || ''), un);
  ok('  a labelled row carries none (the site says who asked)', lab && lab.caller === null, lab);

  OUT.push('', '-- the wiring --');
  ok('the column is created', /ALTER TABLE ai_call_ledger ADD COLUMN IF NOT EXISTS caller TEXT/.test(fs.readFileSync(REPO + 'server/store.js', 'utf8')));
  const sb = fs.readFileSync(REPO + 'scripts/spend-breakdown.js', 'utf8');
  ok('spend-breakdown lists unlabelled calls by caller', /unlabelled calls, by caller/.test(sb) && /GROUP BY 1, 2 ORDER BY usd DESC/.test(sb));

  await P().query(`DELETE FROM ai_call_ledger WHERE site = 'unlabelled-test.labelled' OR (site = 'unlabelled' AND caller LIKE '%unlabelled.js%')`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
