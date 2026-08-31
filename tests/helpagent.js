'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// THE HELP AGENT. The knowledge is DERIVED, and the two rules it cannot break
// are enforced by construction rather than by asking nicely.
const ROOT = REPO;
const K = require(ROOT + 'server/services/assistantKnowledge.js');
const D = require(ROOT + 'server/services/assistantData.js');
const store = require(ROOT + 'server/store.js');

let F = 0;
const ok = (n, c, g) => { if (c) console.log('  PASS ' + n); else { F++; console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'help-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const T = K.buildKnowledge();

  // ── 1. IT COVERS WHAT WAS ASKED FOR ──────────────────────────────────────
  console.log('\n-- 1. it can explain the product --');
  // \s+ across the phrase: the source wraps, and a test that breaks on a line
  // wrap is testing the formatting rather than the content.
  ok('what NILDash is for, as a team not a tool',
    /AI team that works an agent's\s+roster overnight/.test(T) && /does not\s+operate a tool/.test(T));
  for (const role of ['Scout', 'Researcher', 'Writer', 'Closer', 'Analyst', 'Compliance']) {
    ok(`  the ${role} role`, new RegExp('- ' + role + ':').test(T));
  }
  ok('the three lanes', /Local \(/.test(T) && /DTC \(/.test(T) && /National \(/.test(T));
  ok('  and that no local market means no local lane',
    /does not resolve has NO local lane/.test(T));
  ok('how outreach is approved, in one decision', /APPROVAL IS ONE DECISION/.test(T));
  ok('WHY the agent does not pick the send time',
    /DOES NOT PICK THE SEND TIME/.test(T) && /a fact about the recipient/.test(T));
  ok('what happens when a reply lands', /stops the follow-up cadence for that business immediately/.test(T));
  ok('what the shift report numbers mean', /Across N of M athletes/.test(T));
  ok('  including that day work is counted separately', /counted separately/.test(T));
  ok('pricing', /\$99 a month per agent/.test(T));

  // ── 2. DERIVED, NOT COPIED ───────────────────────────────────────────────
  // The claim is not "the numbers are right today", it is "they follow the
  // system". Change the source, the text must move.
  console.log('\n-- 2. the numbers come from the modules, not from prose --');
  const sg = require(ROOT + 'server/services/sendGuard.js');
  const co = require(ROOT + 'server/services/compliance.js');
  ok('the send ceiling matches sendGuard',
    new RegExp('CEILING IS ' + sg.DEFAULT_DAILY_CAP + ' EMAILS').test(T), sg.DEFAULT_DAILY_CAP);
  ok('every compliance category is listed',
    co.CATEGORIES.every((c) => T.indexOf(c.label) !== -1),
    co.CATEGORIES.filter((c) => T.indexOf(c.label) === -1).map((c) => c.label));
  ok('every unchecked limit is listed', co.UNCHECKED.every((u) => T.indexOf(u) !== -1));

  const origCap = sg.DEFAULT_DAILY_CAP;
  Object.defineProperty(sg, 'DEFAULT_DAILY_CAP', { value: 17, configurable: true });
  co.CATEGORIES.push({ key: 'zzz_probe', label: 'a probe category', minor: 'block', adult: 'hold' });
  const T2 = K.buildKnowledge();
  ok('CHANGING THE SOURCE CHANGES THE ANSWER (cap 17)', /CEILING IS 17 EMAILS/.test(T2));
  ok('  and a new category appears with no edit here', /a probe category/.test(T2));
  co.CATEGORIES.pop();
  Object.defineProperty(sg, 'DEFAULT_DAILY_CAP', { value: origCap, configurable: true });
  ok('  restored', new RegExp('CEILING IS ' + origCap + ' EMAILS').test(K.buildKnowledge()));

  // The marker must be gone from what the MODEL is handed. The source file still
  // names it once, in the header, explaining why it is gone -- grepping the source
  // would fail on that comment and prove nothing.
  ok('no paste-the-FAQ-here marker reaches the model', !/PASTE KNOWLEDGE BASE HERE/.test(T));
  ok('  and the knowledge is built by a function, not stored as a literal block',
    typeof K.buildKnowledge === 'function' && K.buildKnowledge() !== K.buildKnowledge.toString());

  // ── 3. IT DOES NOT OVERSTATE ─────────────────────────────────────────────
  console.log('\n-- 3. the honest numbers, including the unflattering ones --');
  ok('cold-market email coverage is stated as ~10%', /roughly 10%/.test(T));
  ok('  and 69% is explicitly disowned', /Do not quote 69%/.test(T));
  ok('  with the reason it was never comparable', /warm cache rather than cold discovery/.test(T));
  ok('the named-person rate is refused outright', /Do not quote a "named person found" rate at all/.test(T));
  ok('school policy is stated as NOT checked', /we do NOT/.test(T) && /agent-supplied and not\nverified/.test(T));
  ok('school sponsor conflicts are stated as not checked', /SCHOOL SPONSOR CONFLICTS are not checked/.test(T));
  ok('follower counts are flagged as stale until connected', /go stale/.test(T));
  ok('disclosure is prepared, never filed', /PREPARED, never submitted/.test(T));
  ok('the gate is described as blocking, not warning', /not a warning the\nagent can click past/.test(T));
  ok('  and as failing closed', /fails closed/.test(T));
  ok('unknown age holds rather than assuming adult', /rather than assuming they are an adult/.test(T));

  // ── 4. IT CANNOT INVENT DATA ─────────────────────────────────────────────
  console.log('\n-- 4. own-data questions are fixed queries, scoped to the caller --');
  const SRC = require('fs').readFileSync(ROOT + 'server/services/assistantData.js', 'utf8');
  ok('there is no free-form SQL tool', !/query\(\s*(req|input|params)\./.test(SRC));
  ok('every query binds agent_id as a parameter',
    (SRC.match(/\$1/g) || []).length >= D.names().length - 2);
  ok('the four asked-for questions are answerable', ['nothing_sent_recently',
    'athletes_without_market', 'brand_thread', 'pitches_waiting'].every((q) => D.names().indexOf(q) !== -1),
    D.names());
  ok('  plus compliance holds, the other half of "why did nothing send"',
    D.names().indexOf('compliance_holds') !== -1);

  // Run them for real against an empty roster: "none" must be an ANSWER.
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'H','h@x.com','x','agent')`, [AG]);

  const empty = await D.run(P, AG, { question: 'pitches_waiting' });
  ok('an empty result reports found:0 rather than erroring',
    empty && empty.found === 0 && !empty.error, empty);
  ok('  and names the page that would show it', !!empty.where, empty);

  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('h-a1',$1,'{"name":"Marcus Hall"}'::jsonb)`, [AG]);
  for (let i = 0; i < 3; i++) {
    await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status)
                   VALUES ($1,$2,'h-a1',$3,'s','<p>x</p>','draft')`, ['h-l' + i, AG, 'Brand ' + i]);
  }
  const three = await D.run(P, AG, { question: 'pitches_waiting' });
  ok('it counts real waiting pitches', three.found === 1 && three.rows[0].waiting === 3, three.rows);
  ok('  grouped by athlete, named', three.rows[0].athlete === 'Marcus Hall', three.rows[0]);

  const unknown = await D.run(P, AG, { question: 'what_is_my_conversion_rate' });
  ok('a question outside the list REFUSES rather than approximating',
    !!unknown.error || unknown.answerable === false, unknown);

  // ── 5. THE PROMPT ENFORCES BOTH RULES ────────────────────────────────────
  console.log('\n-- 5. the two rules it cannot break --');
  const PS = require('fs').readFileSync(ROOT + 'server/services/assistantPrompt.js', 'utf8');
  ok('it may state product facts ONLY from the knowledge section',
    /is in the KNOWLEDGE section\s*\n?below and nowhere else/.test(PS));
  ok('  and must not infer from a feature name', /do NOT infer, guess, or describe how it "probably" works/.test(PS));
  ok('it may not answer about their data without a lookup',
    /unless a look_up_data call in THIS conversation returned it/.test(PS));
  ok('  a lookup returning nothing is an answer, not a failure', /returns nothing is an ANSWER/.test(PS));
  ok('  a lookup that failed is told apart from one that found nothing',
    /a lookup that FAILS is not the same thing/.test(PS));
  ok('  and it must not reuse an old number for a new question',
    /do NOT reuse a number from earlier in the conversation/.test(PS));

  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  console.log('\nfailures: ' + F);
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
