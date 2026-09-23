'use strict';
// Runs against the local test Postgres like the other job suites. Makes no
// network or model call: every model entry point is a stub that counts.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/noagentname.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
delete process.env.DEEPSEEK_API_KEY;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── NO NAME, NO CARD ────────────────────────────────────────────────────────
//
// An agent with no name on file had every pitch signed "JohnMark": the writer
// read ctx.agentFirstName || 'JohnMark'. The older writers did the same with
// "Your Agent", "NIL Agent" and "an agent", and saveUser stored "Agent" or the
// email's local part for a nameless signup, which then signed pitches too.
//
// The rule is now the one a missing recipient name already had: without the
// sender's real name the card is not written, and nothing is spent finding out.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const AN = require(REPO + 'server/services/agentName.js');
const PW = require(REPO + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/[^'"`\n]*$/gm, '$1');

const AG = 'nan-agent', ATH = 'nan-ath', RUN_DATE = '2099-03-04';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. WHAT COUNTS AS A NAME ──────────────────────────────────────────────
  OUT.push('-- what counts as a name --');
  ok('a real name is kept', AN.agentFullName({ name: '  Dana   Roberts ', email: 'dana@x.com' }) === 'Dana Roberts');
  ok('  and its first name is the sign-off', AN.agentFirstName({ name: 'Dana Roberts', email: 'd@x.com' }) === 'Dana');
  for (const bad of ['', '   ', null, 'Agent', 'your agent', 'NIL Agent', 'an agent', 'there']) {
    ok(`not a name: ${JSON.stringify(bad)}`, AN.agentFirstName({ name: bad, email: 'x@y.com' }) === null);
  }
  ok('not a name: the email local part saveUser used to store',
    AN.agentFirstName({ name: 'jmcompton04', email: 'jmcompton04@gmail.com' }) === null);
  ok('not a name: anything with an @ or a digit', AN.firstNameOrNull('dana@x.com') === null && AN.firstNameOrNull('dana2') === null);
  ok('no user at all is no name', AN.agentFirstName(null) === null && AN.agentFullName(undefined) === null);

  // ── 2. THE PITCH WRITER REFUSES, AND CALLS NOTHING ────────────────────────
  OUT.push('', '-- the pitch writer --');
  let calls = 0;
  const oneShot = async () => { calls++; return JSON.stringify({ angle: 'a', angleKey: 'a', ask: 'a', confidence: 'strong',
    message: 'Hi Dana,\n\nI work with Jo Doe, who plays basketball at Alabama. She is building her following one game at a time. '
      + 'Her feed is training days and game days. She would be a natural fit for a local shop like yours. '
      + 'Would you like to learn more about this NIL opportunity with Jo?\n\nSam' }); };
  const ctx = (agentFirstName) => ({
    business: { name: 'Trak Shak', category: 'store', greetFirstName: 'Dana', ownerName: 'Dana Roberts' },
    athlete: { name: 'Jo Doe', sport: 'basketball', school: 'Alabama' }, agentFirstName, channel: 'email',
  });
  for (const blank of [null, undefined, '', '  ', 'Agent', 'Your Agent']) {
    calls = 0;
    const r = await PW.writePitch(ctx(blank), { oneShot });
    ok(`writePitch with agent name ${JSON.stringify(blank)} is refused before the model`,
      r.skipped === true && r.noAgentName === true && calls === 0, { r, calls });
  }
  calls = 0;
  const signed = await PW.writePitch(ctx('Sam'), { oneShot });
  ok('with a real name it writes, signed by that name', signed.skipped === false && /\nSam\s*$/.test(signed.message) && calls === 1, signed);
  ok('  and never by JohnMark', !/JohnMark/.test(signed.message || ''));
  let threw = null;
  try { PW.buildPrompt(ctx(null)); } catch (e) { threw = e.message; }
  ok('buildPrompt itself throws without a sender name, so no other caller can skip the check',
    /no agent name/.test(threw || ''), threw);
  ok('  and names the real one when it has it', /first name, for the sign-off: Sam\n/.test(PW.buildPrompt(ctx('Sam'))));
  calls = 0;
  const noAth = await PW.writePitch({ ...ctx('Sam'), athlete: { sport: 'basketball' } }, { oneShot });
  ok('an athlete with no name is refused too, before the model', noAth.skipped === true && calls === 0, noAth);

  // ── 3. THE OTHER WRITERS ──────────────────────────────────────────────────
  OUT.push('', '-- the other writers refuse --');
  const PG = require(REPO + 'server/services/pitchGeneration.js');
  const refused = await PG.generatePitch({ athlete: { data: { name: 'Jo Doe' } }, enrichment: { brand_name: 'Trak Shak' },
    matchScore: null, contact: null, dealScanData: {}, agentName: null, agentEmail: 'a@b.com' });
  ok('the manual generator refuses a nameless sender, with the reason', refused && refused.refused === true
    && refused.reasons[0] === AN.NO_AGENT_NAME_REASON, refused);

  const DP = require(REPO + 'server/services/draftPrewarm.js');
  const pre = await DP.prewarmScan({ agentId: AG, athleteId: ATH, athlete: { name: 'Jo Doe' },
    cards: [{ brand: 'Trak Shak', rank: 1 }], agentName: '', lane: 'local' });
  ok('the draft prewarm refuses the whole batch', pre.drafted === 0 && pre.reason === AN.NO_AGENT_NAME_REASON, pre);
  ok('  and one draft on its own', (await DP.draftOne({ agentId: AG, athleteId: ATH, athlete: {}, card: { brand: 'X' }, agentName: 'Agent' })).skipped === 'no agent name');

  const WD = require(REPO + 'server/services/weeklyDigest.js');
  let aiCalls = 0;
  const fakeAi = { oneShot: async () => { aiCalls++; return '{"subject":"s","body":"b"}'; } };
  const noContact = await WD.draftFollowUp({ brand_name: 'Trak Shak', athlete_name: 'Jo Doe', contact_name: null, days_since: 9 }, fakeAi);
  ok('the digest follow-up is not drafted to "Hi there"', noContact === null && aiCalls === 0, noContact);
  const noAthlete = await WD.draftFollowUp({ brand_name: 'Trak Shak', athlete_name: null, contact_name: 'Dana Roberts', days_since: 9 }, fakeAi);
  ok('  nor about "one of our athletes"', noAthlete === null && aiCalls === 0, noAthlete);
  const html = WD.renderHtml({ agent: { name: null }, counts: {}, action: { brand_name: 'Trak Shak', contact_name: null, days_since: 9, followUpBody: null } }, {});
  ok('  and the digest says there is no draft instead of an empty box', /No draft: we do not have a name/.test(html) && !/Morning, there/.test(html));

  // ── 4. NOTHING STORES A STAND-IN ──────────────────────────────────────────
  OUT.push('', '-- saveUser stores no stand-in --');
  for (const t of ['outreach_queue_runs', 'outreach_queue_ondemand']) {
    await P.query(`DELETE FROM ${t} WHERE ${t === 'outreach_queue_ondemand' ? 'athlete_id' : 'agent_id'} = $1`, [t === 'outreach_queue_ondemand' ? ATH : AG]).catch(() => {});
  }
  await P.query('DELETE FROM athletes WHERE agent_id = $1', [AG]).catch(() => {});
  await P.query('DELETE FROM users WHERE id = $1', [AG]).catch(() => {});
  await store.saveUser(AG, { id: AG, name: '', email: 'nanagent@example.com', password: 'x', role: 'agent' });
  const u = (await P.query('SELECT name FROM users WHERE id = $1', [AG])).rows[0];
  ok('A NAMELESS SIGNUP IS STORED NAMELESS, not "Agent" and not "nanagent"', u && u.name === null, u);

  // ── 5. THE QUEUE REFUSES BEFORE IT SPENDS ─────────────────────────────────
  OUT.push('', '-- the nightly run and the on-demand fill --');
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, $3)`,
    [ATH, AG, JSON.stringify({ name: 'Jo Doe', school: 'Alabama', sport: 'basketball' })]);
  const job = require(REPO + 'server/jobs/outreachQueue.js');
  const res = await job.run({ agentId: AG, runDate: RUN_DATE, force: true });
  ok('a forced run for a nameless agent fills nothing', res.filled === 0 && res.skipped === 1, res);
  const row = (await P.query('SELECT filled, note, finished_at FROM outreach_queue_runs WHERE agent_id = $1 AND run_date = $2', [AG, RUN_DATE])).rows[0];
  ok('  and the night is recorded with the reason, so Home can say why',
    row && row.filled === 0 && row.note === AN.NO_AGENT_NAME_REASON && row.finished_at, row);

  const aths = await job.loadAthletesForQueue(P, AG, ATH);
  ok('the on-demand loader carries the raw name and email, not a split first word',
    aths.length === 1 && aths[0].agent_name === null && aths[0].agent_email === 'nanagent@example.com', aths[0]);
  const od = await job.fillOnDemand(P, aths[0], { runDate: RUN_DATE });
  ok('the on-demand fill refuses', od.filled === 0 && od.claimed === false && od.reason === AN.NO_AGENT_NAME_REASON, od);
  const claim = (await P.query('SELECT 1 FROM outreach_queue_ondemand WHERE athlete_id = $1 AND run_date = $2', [ATH, RUN_DATE])).rows;
  ok('  BEFORE its daily claim, so adding a name later today still gets a fill', claim.length === 0);
  const fa = await job.fillAthlete(P, { agentId: AG, athleteId: ATH, athleteName: 'Jo Doe', agentFirstName: null, runDate: RUN_DATE });
  ok('fillAthlete refuses too, for any other caller', fa.filled === 0 && fa.noAgentName === true, fa);

  // ── 6. NO STAND-IN LEFT IN THE CODE THAT WRITES TO A BUSINESS ────────────
  // Comments are stripped first: the history of the bug is described in them.
  OUT.push('', '-- no stand-in name is left in code that writes to a business --');
  const files = ['server/services/pitchWriter.js', 'server/jobs/outreachQueue.js', 'server/services/pitchGeneration.js',
    'server/services/draftPrewarm.js', 'server/services/workflowOrchestrator.js', 'server/services/weeklyDigest.js',
    'server/services/outreachQueue.js', 'server/services/deckGeneration.js', 'server/services/athleteReport.js',
    'server/store.js', 'server/index.js'];
  const STANDINS = /\|\|\s*['"`](JohnMark|Your Agent|Your agent|NIL Agent|an agent|Agent|Your athlete|our client|one of our athletes|a college athlete I work with|Decision Maker|handle)['"`]/;
  for (const f of files) {
    const hit = stripComments(read(f)).split('\n').find((l) => STANDINS.test(l));
    ok(`${f.split('/').pop()}: no stand-in name`, !hit, hit);
  }
  ok('"JohnMark" appears nowhere in server code outside comments',
    files.every((f) => !/JohnMark/.test(stripComments(read(f)))));
  const idx = read('server/index.js');
  ok('the contract names a real agent party or refuses', /Add your name in Settings before generating a contract/.test(idx)
    && /- Agent\/Manager: \$\{partyAgentName\} \(\$\{partyAgentEmail\}\)/.test(idx));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.query('DELETE FROM outreach_queue_runs WHERE agent_id = $1', [AG]).catch(() => {});
  await P.query('DELETE FROM athletes WHERE agent_id = $1', [AG]).catch(() => {});
  await P.query('DELETE FROM users WHERE id = $1', [AG]).catch(() => {});
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('noagentname: FAILED', e); process.exit(1); });
