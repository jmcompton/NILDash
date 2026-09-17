'use strict';
// Runs from a checkout on any machine, offline: the model and the store are
// stubbed the way tests/prewarm.js stubs them.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/prewarmgreet.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';

// ── THE PREWARM DRAFT GREETS THE PERSON ON THE CARD, AND NOBODY ELSE ────────
//
// Twelve nameless cards traced to drafts with source "prewarm": each card
// carried a contact name, the prewarm draft opened "Hi,", and one greeted
// "Jill" on a card naming LaRae Kraemer. Now the prewarm path passes the
// card's contact first name to the writer, runs the same greeting lint the
// nightly writer runs, and rejects (then rewrites once) any draft that does
// not open "Hi <first name>,". The prompt reads ONE card, so the only names
// the writer can see are that card's own.

const aiPath = require.resolve(REPO + 'server/ai.js');
let _calls = [];
let _replies = [];
const reply = (body) => JSON.stringify({ subject: 'KSTATE Credit Union x Fixture Alvarez', body });
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  oneShot: async (prompt, system, maxTokens, model) => { _calls.push({ prompt, system, maxTokens, model }); const r = _replies.shift(); return typeof r === 'function' ? r(prompt) : r; },
  withTimeout: (p) => p, withDeadline: (p) => p,
  resolveBrandKey: (o) => (o && o.brand ? 'name:' + String(o.brand).toLowerCase().replace(/\W+/g, '') : null),
  MODEL_FAST: 'haiku',
} };
const storePath = require.resolve(REPO + 'server/store.js');
let _sql = [];
let _rows = [];
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
  pool: { query: async (text, params) => { _sql.push({ text, params }); const r = _rows.shift(); return r || { rows: [], rowCount: 0 }; } },
} };
const draftAddressPath = require.resolve(REPO + 'server/services/draftAddress.js');
require.cache[draftAddressPath] = { id: draftAddressPath, filename: draftAddressPath, loaded: true, exports: { lookupOne: async () => null } };

const pw = require(REPO + 'server/services/draftPrewarm.js');
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const ATHLETE = { id: 'ath_1', name: 'Fixture Alvarez', sport: 'Track', school: 'K-State', instagram: 41000 };
const KSTATE = { brand: 'KSTATE Credit Union', category: 'finance', region: 'Manhattan, KS', contactName: 'LaRae Kraemer', contactTitle: 'Marketing Director',
  rationale: 'Student members are the same people who follow her training content. A reviewer, Jill, wrote that the branch staff know every student by name.',
  evidence: 'Reviews mention Jill at the front desk', matchedTags: ['students'], campaign: 'Student account drive', fitScore: 80 };
const NONAME = { brand: 'Aurora Fitness', category: 'gym', region: 'Manhattan, KS', rationale: 'Her training content reaches the same lifters.', fitScore: 84 };
const ROLE = { ...NONAME, brand: 'Role Gym', contactName: 'Owner' };
const BODY = (greet) => `${greet}\n\nFixture Alvarez runs distance at K-State and posts her training blocks twice a week. KSTATE Credit Union's student members are the same people who watch those posts. She would front a student account drive across two feed posts and a branch appearance.\n\nWould a short call next week work?`;

OUT.push('-- the prompt: the card\'s first name, and no other --');
const p = pw.buildPrompt(ATHLETE, KSTATE, 'Sample Agent');
ok('the greeting instruction names the contact\'s first name', /GREETING: exactly "Hi LaRae," on its own line/.test(p) && /LaRae is the person this card is to/.test(p), p.match(/GREETING:[^\n]*/) && p.match(/GREETING:[^\n]*/)[0]);
ok('  and no longer says "Hi," when a person is known', !/exactly "Hi," on its own line/.test(p));
ok('  and tells the model a name in the facts (the reviewer) is not the recipient', /Any other name that appears in the facts above[^\n]*NOT the recipient/.test(p));
ok('a card with nobody on it is still written "Hi,"', /GREETING: exactly "Hi," on its own line/.test(pw.buildPrompt(ATHLETE, NONAME, 'A')) && /Do NOT invent a name/.test(pw.buildPrompt(ATHLETE, NONAME, 'A')));
ok('  a role on the card ("Owner") is nobody: written "Hi,"', pw.greetNameFor(ROLE) === '' && /exactly "Hi," on its own line/.test(pw.buildPrompt(ATHLETE, ROLE, 'A')));
ok('greetNameFor: first name, or the honorific with the surname', pw.greetNameFor(KSTATE) === 'LaRae' && pw.greetNameFor({ contactName: 'Dr. Lee Park' }) === 'Dr. Park' && pw.greetNameFor({}) === '');

OUT.push('', '-- the lint: the same rule the nightly writer runs --');
const chk = (body, card) => pw.checkDraft(body, card || KSTATE);
ok('"Hi LaRae," passes', chk(BODY('Hi LaRae,')).ok === true, chk(BODY('Hi LaRae,')));
ok('"Hi," on a card with a contact is refused', chk(BODY('Hi,')).ok === false && /greets nobody/.test(chk(BODY('Hi,')).why) && /open with exactly "Hi LaRae,"/.test(chk(BODY('Hi,')).why), chk(BODY('Hi,')));
ok('"Hi there," is refused', chk(BODY('Hi there,')).ok === false);
ok('"Hi Jill," is refused: greets someone who is not the contact on the card', /greets "Jill", not the contact on the card \(LaRae Kraemer\)/.test(chk(BODY('Hi Jill,')).why || ''), chk(BODY('Hi Jill,')));
ok('  even inline, "Hi Jill, I work with..." (the old check only read a short standalone line)', /greets "Jill"/.test(chk('Hi Jill, I work with Fixture Alvarez at K-State. KSTATE Credit Union serves the students who follow her. Two posts and an appearance. Worth a call?').why || ''));
ok('  no greeting line at all is refused', chk('Fixture Alvarez runs at K-State. KSTATE Credit Union serves students. Two posts. Worth a call?').ok === false);
ok('on a card with nobody, any name is invented and refused', /greets "Jill", who has not been discovered/.test(chk(BODY('Hi Jill,').replace(/KSTATE Credit Union/g, 'Aurora Fitness'), NONAME).why || ''));
ok('  and "Hi," passes there', chk(BODY('Hi,').replace(/KSTATE Credit Union/g, 'Aurora Fitness'), NONAME).ok === true, chk(BODY('Hi,').replace(/KSTATE Credit Union/g, 'Aurora Fitness'), NONAME));

OUT.push('', '-- the draft: rejected, rewritten once, refused twice --');
(async () => {
  _calls = []; _sql = []; _rows = [{ rows: [] }, { rows: [], rowCount: 1 }];
  _replies = [reply(BODY('Hi,')), reply(BODY('Hi LaRae,'))];
  const r = await pw.draftOne({ agentId: 'ag_1', athleteId: 'ath_1', athlete: ATHLETE, card: KSTATE, agentName: 'A', lane: 'local' });
  ok('a "Hi," draft is rejected and rewritten: two model calls, the second told why', _calls.length === 2 && /YOUR PREVIOUS ATTEMPT WAS REJECTED: the message greets nobody/.test(_calls[1].prompt) && /open with exactly "Hi LaRae,"/.test(_calls[1].prompt), _calls.map((c) => c.prompt.slice(0, 120)));
  ok('  the rewritten draft, greeting LaRae, is stored', r.drafted === true && r.retried === true && _sql.some((q) => /INSERT INTO outreach_logs/.test(q.text) && /<div>Hi LaRae,<\/div>/.test(String(q.params[6]))), r);

  _calls = []; _sql = []; _rows = [{ rows: [] }];
  _replies = [reply(BODY('Hi Jill,')), reply(BODY('Hi,'))];
  const bad = await pw.draftOne({ agentId: 'ag_1', athleteId: 'ath_1', athlete: ATHLETE, card: KSTATE, agentName: 'A', lane: 'local' });
  ok('a draft that greets Jill, then "Hi," is refused and NOT stored', !!bad.failed && /greets "Jill"|greets nobody/.test(bad.failed) && !_sql.some((q) => /INSERT INTO outreach_logs/.test(q.text)), bad);

  OUT.push('', '-- the writer only ever sees the contact for the card it is writing --');
  _calls = []; _sql = []; _rows = [];
  for (let i = 0; i < 6; i++) _rows.push({ rows: [] }, { rows: [], rowCount: 1 });
  const cards = [
    KSTATE,
    { ...NONAME, brand: 'Aurora Fitness', contactName: 'Dana Roberts', contactTitle: 'Owner' },
    { ...NONAME, brand: 'Hoover Cycles', contactName: 'Kim Ito', contactTitle: 'Owner' },
  ];
  _replies = [
    (prompt) => reply(BODY(/LaRae/.test(prompt) ? 'Hi LaRae,' : /Dana/.test(prompt) ? 'Hi Dana,' : 'Hi Kim,').replace(/KSTATE Credit Union/g, /KSTATE/.test(prompt) ? 'KSTATE Credit Union' : /Aurora/.test(prompt) ? 'Aurora Fitness' : 'Hoover Cycles')),
    (prompt) => reply(BODY(/LaRae/.test(prompt) ? 'Hi LaRae,' : /Dana/.test(prompt) ? 'Hi Dana,' : 'Hi Kim,').replace(/KSTATE Credit Union/g, /KSTATE/.test(prompt) ? 'KSTATE Credit Union' : /Aurora/.test(prompt) ? 'Aurora Fitness' : 'Hoover Cycles')),
    (prompt) => reply(BODY(/LaRae/.test(prompt) ? 'Hi LaRae,' : /Dana/.test(prompt) ? 'Hi Dana,' : 'Hi Kim,').replace(/KSTATE Credit Union/g, /KSTATE/.test(prompt) ? 'KSTATE Credit Union' : /Aurora/.test(prompt) ? 'Aurora Fitness' : 'Hoover Cycles')),
  ];
  const out = await pw.prewarmScan({ agentId: 'ag_1', athleteId: 'ath_1', athlete: ATHLETE, cards, agentName: 'A', lane: 'local' });
  ok('three cards, three prompts', out.drafted === 3 && _calls.length === 3, out);
  const promptFor = (brand) => _calls.map((c) => c.prompt).find((q) => q.includes('- Business: ' + brand)) || '';
  ok('the KSTATE prompt names LaRae and never Dana or Kim', /Hi LaRae,/.test(promptFor('KSTATE Credit Union')) && !/Dana|Kim Ito|\bKim\b/.test(promptFor('KSTATE Credit Union')));
  ok('the Aurora prompt names Dana and never LaRae, Kim or KSTATE', /Hi Dana,/.test(promptFor('Aurora Fitness')) && !/LaRae|Kraemer|Kim|KSTATE/.test(promptFor('Aurora Fitness')));
  ok('the Hoover prompt names Kim and never LaRae or Dana', /Hi Kim,/.test(promptFor('Hoover Cycles')) && !/LaRae|Dana/.test(promptFor('Hoover Cycles')));
  ok('  "Jill" (a reviewer in KSTATE\'s own facts) is the only other name the KSTATE prompt carries, and it is marked not the recipient', /Jill/.test(promptFor('KSTATE Credit Union')) && /is NOT the recipient/.test(promptFor('KSTATE Credit Union')) && !/Jill/.test(promptFor('Aurora Fitness')));
  const src = fs.readFileSync(REPO + 'server/services/draftPrewarm.js', 'utf8');
  ok('buildPrompt reads one athlete and one card; the batch never passes the list into a prompt', /function buildPrompt\(athlete, card, agentName, retryBecause\)/.test(src) && !/buildPrompt\([^)]*cards/.test(src) && /draftOne\(\{ agentId, athleteId, athlete, card: list\[i\]/.test(src));
  ok('the lint is the nightly writer\'s (services/outreachQueue.greetingProblem), not a second rule', /Q\.greetingProblem\(body/.test(src) && /Q\.greetingWho\(firstLine\)/.test(src));
  ok('the queue re-checks a draft it links a card to, and rewrites it to the card\'s pitch when it fails', /const oldProblem = Q\.cardNameProblem\(\{ \.\.\.card, channel: 'email', emailBody: null, body_html: existing\.body_html \}\)/.test(fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8')));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('prewarmgreet: FAILED', e); process.exit(1); });
