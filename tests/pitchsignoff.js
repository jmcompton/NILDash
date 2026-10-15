'use strict';
// Runs against the local test Postgres. No network: the model is a stub.
//
//   node tests/pitchsignoff.js
//
// ── AGENTS' OWN PITCHES SIGN WITH THEIR "FIRST NAME FOR SIGN-OFFS" ──────────
// Under AGENT_SETUP_ON, when the agent has set it in Settings, exactly as
// typed ("JohnMark" stays "JohnMark"): the nightly cards (and the on-demand
// and proof fills, which use the same writer), follow-ups, and the outreach
// pitch. Off, or not set: the first word of their name, as before. A
// greeting TO the agent is not a pitch and is unchanged. The model is not.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
delete process.env.AGENT_SETUP_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const fs = require('fs');
// The model, stubbed before anything reads it: the outreach pitch's prompt is
// captured, never sent.
const ai = require(REPO + 'server/ai');
const prompts = [];
ai.oneShot = async (prompt) => { prompts.push(String(prompt)); return JSON.stringify({ subject_line: 'Tess Court x Fernbrook Pizza', email_body: 'Hi Dana,\n\nTwo posts.\n\nJohnMark', body: 'x' }); };
const store = require(REPO + 'server/store.js');
const AN = require(REPO + 'server/services/agentName.js');
const FU = require(REPO + 'server/services/followUps.js');
const PG = require(REPO + 'server/services/pitchGeneration.js');
const job = require(REPO + 'server/jobs/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const on = () => { process.env.AGENT_SETUP_ON = '1'; };
const off = () => { delete process.env.AGENT_SETUP_ON; };
const AG = 'ps-agent', AG2 = 'ps-plain';
const read = (f) => fs.readFileSync(REPO + f, 'utf8');

async function main() {
  // ── 1. THE RULE ──────────────────────────────────────────────────────────
  OUT.push('-- the name a pitch is signed with --');
  const u = { name: 'John Mark Compton', email: 'jm@ps-test.test', sign_first_name: 'JohnMark' };
  off();
  ok('off: the first word of their name, as before', AN.pitchSignOffName(u) === 'John');
  on();
  ok('on, and set: exactly as typed', AN.pitchSignOffName(u) === 'JohnMark');
  ok('  not set, or cleared: the first word of their name', AN.pitchSignOffName({ ...u, sign_first_name: null }) === 'John' && AN.pitchSignOffName({ ...u, sign_first_name: '' }) === 'John');
  ok('  something that is not a name ("Agent", an address) is not used', AN.pitchSignOffName({ ...u, sign_first_name: 'Agent' }) === 'John' && AN.pitchSignOffName({ ...u, sign_first_name: 'jm@x.com' }) === 'John');
  ok('  a greeting TO the agent is not a pitch: agentFirstName is unchanged', AN.agentFirstName(u) === 'John');
  off();

  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id IN ($1, $2)`, [AG, AG2]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id IN ($1, $2)`, [AG, AG2]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id IN ($1, $2)`, [AG, AG2]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role, sign_first_name) VALUES ($1, 'John Mark Compton', 'jm@ps-test.test', 'x', 'agent', 'JohnMark'),
    ($2, 'Dana Fields', 'dana@ps-test.test', 'x', 'agent', NULL)`, [AG, AG2]);
  for (const a of [AG, AG2]) {
    await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, $3::jsonb)`, [a + '-ath', a, JSON.stringify({ name: 'Tess Court', school: 'Auburn University', sport: 'Tennis' })]);
    await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_at, sent_to_email)
      VALUES ($1, $2, $3, 'Fernbrook Pizza', 'Tess Court x Fernbrook Pizza', '<p>Hi Dana</p>', 'sent', NOW() - INTERVAL '6 days', 'dana@fernbrook.com')`, [a + '-log', a, a + '-ath']);
  }

  // ── 2. THE NIGHTLY CARDS ────────────────────────────────────────────────
  OUT.push('', '-- the nightly cards (and the on-demand and proof fills) --');
  const rows = (await job.loadAthletesForQueue(P, AG)).filter((x) => x.id === AG + '-ath');
  const ath = rows[0] || {};
  ok('the roster query carries the setting to the fill', ath.agent_sign_first_name === 'JohnMark', ath);
  on();
  ok('  on: the on-demand fill signs "JohnMark"', AN.pitchSignOffName({ name: ath.agent_name, email: ath.agent_email, sign_first_name: ath.agent_sign_first_name }) === 'JohnMark');
  off();
  const J = read('server/jobs/outreachQueue.js');
  ok('  the nightly signs with it: fillAgent reads the setting with the agent row and passes pitchSignOffName to the writer',
    /const agentFirst = AgentName\.pitchSignOffName\(agent\);/.test(J) && (J.match(/SELECT id, name, email, sign_first_name, signature_text, scheduling_url, last_login FROM users/g) || []).length === 2
    && /AgentName\.pitchSignOffName\(\{ name: ath\.agent_name, email: ath\.agent_email, sign_first_name: ath\.agent_sign_first_name \}\)/.test(J));
  ok('  and the proof fill', /pitchSignOffName\(\{ name: ath\.agent_name, email: ath\.agent_email, sign_first_name: ath\.agent_sign_first_name \}\)/.test(read('server/services/engineProof.js'))
    && /u\.sign_first_name AS agent_sign_first_name/.test(read('server/services/engineProof.js')));
  ok('  the writer itself is untouched: it signs with whatever first name it is handed', !/sign_first_name|signOffSetting|pitchSignOffName/.test(read('server/services/pitchWriter.js')));

  // ── 3. FOLLOW-UPS ────────────────────────────────────────────────────────
  OUT.push('', '-- follow-ups --');
  const root = (await P.query(`SELECT * FROM outreach_logs WHERE id = $1`, [AG + '-log'])).rows[0];
  off();
  const m0 = await FU.materialFor(P, root);
  ok('off: a follow-up signs with the first word of their name', m0.agentFirst === 'John', m0.agentFirst);
  on();
  const m1 = await FU.materialFor(P, root);
  const c1 = FU.compose(m1, 2, []);
  ok('on: "JohnMark"', m1.agentFirst === 'JohnMark' && /JohnMark\s*$/.test(String(c1.body || c1.text || c1).trim()), { first: m1.agentFirst, body: String(c1.body || c1.text || c1).slice(-80) });
  const m2 = await FU.materialFor(P, (await P.query(`SELECT * FROM outreach_logs WHERE id = $1`, [AG2 + '-log'])).rows[0]);
  ok('  an agent who never set it: their first name, as before', m2.agentFirst === 'Dana', m2.agentFirst);
  off();

  // ── 4. THE OUTREACH PITCH ────────────────────────────────────────────────
  OUT.push('', '-- the outreach pitch --');
  const inputs = { athlete: { id: AG + '-ath', data: { name: 'Tess Court', school: 'Auburn University', sport: 'Tennis' } },
    enrichment: { brand_name: 'Fernbrook Pizza', industry: 'restaurant' }, matchScore: { compatibility_score: 80 },
    contact: { name: 'Dana Reed', title: 'Owner', email: 'dana@fernbrook.com' }, dealScanData: {}, agentName: 'John Mark Compton', agentEmail: 'jm@ps-test.test' };
  prompts.length = 0;
  await PG.generatePitch({ ...inputs, agentSignOff: 'JohnMark' }).catch((e) => OUT.push('NOTE generatePitch: ' + e.message));
  ok('with the setting: the prompt tells it to sign off "JohnMark", exactly as written', prompts.some((p) => p.includes('Sign off with this first name, exactly as written: JohnMark')), prompts.map((p) => p.slice(-400)));
  prompts.length = 0;
  await PG.generatePitch({ ...inputs, agentSignOff: null }).catch(() => {});
  ok('  without it: the prompt is as before (no sign-off line)', prompts.length > 0 && !prompts.some((p) => p.includes('Sign off with this first name')));
  ok('  the outreach route and the workflow pass the setting (agents only, never an athlete pitching for herself)',
    /const agentSignOff = req\.principal\.kind === 'athlete' \? null : require\('\.\.\/services\/agentName'\)\.signOffSetting/.test(read('server/routes/outreach.js'))
    && /agentSignOff: require\('\.\/agentName'\)\.signOffSetting\(r\.rows\[0\] \|\| null\)/.test(read('server/services/workflowOrchestrator.js')));

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  off();
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass}/${pass + F} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
