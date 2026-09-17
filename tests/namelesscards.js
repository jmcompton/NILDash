'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/namelesscards.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── NO NAMED PERSON, NO CARD: ONE RULE, ONE PLACE, EVERY PATH ──────────────
//
// A card for Legion Hair Studio reached an agent saying "Hi," to nobody, with
// no contact on it. The nightly job had a name check before the writer and
// one after it; the seed script had none; an edited DM had none. Now the rule
// is services/outreachQueue.cardNameProblem and it is enforced in the one
// function every path saves through, jobs/outreachQueue.insertCard: no real
// named person, or a message that does not open "Hi <first name>,", and the
// card is not written, whatever the caller believed and whatever the
// environment says. The writer is linted for the same greeting. The audits
// (retire script, admin endpoint, spend report) read the same rule back over
// the live queue.

const store = require(REPO + 'server/store.js');
const Q = require(REPO + 'server/services/outreachQueue.js');
const JOB = require(REPO + 'server/jobs/outreachQueue.js');
const QA = require(REPO + 'server/services/queueAudit.js');
const PW = require(REPO + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const P = () => store.pool;
const AG = 'nl-agent-1', ATH = 'nl-ath-1';

const good = (over) => Object.assign({
  brandKey: 'name:legion hair studio', brandName: 'Legion Hair Studio', why: 'a salon two blocks from campus',
  contactName: 'Dana Roberts', contactTitle: 'Owner', sourceNote: null, affiliationScope: null,
  instagram: 'legionhair', instagramScope: 'business', phone: '205-555-0100', phoneAskFor: 'Dana',
  dmText: 'Hi Dana, I work with Messiah Mickens and had an idea for Legion Hair Studio. Worth a quick conversation?\n\nJohn',
  channel: 'dm', angle: null, angleKey: null, categoryKey: null, ask: null, lane: 'local',
  email: null, emailKind: null, emailBody: null, subject: null, emailNote: null, athleteName: 'Messiah Mickens',
}, over || {});

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    await P().query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Nl Agent','nl@x.com','x','agent')`, [AG]);
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`, [ATH, AG, JSON.stringify({ name: 'Messiah Mickens', school: 'Auburn University', sport: 'football' })]);
  const rows = async () => (await P().query(`SELECT * FROM outreach_queue WHERE agent_id = $1 ORDER BY slot`, [AG])).rows;
  const drafts = async () => (await P().query(`SELECT * FROM outreach_logs WHERE agent_id = $1`, [AG])).rows;

  // ── 1. THE RULE ───────────────────────────────────────────────────────────
  OUT.push('-- the rule: a real person, greeted by name --');
  ok('a named person greeted by first name passes', Q.cardNameProblem(good()) === null, Q.cardNameProblem(good()));
  ok('  an honorific name is greeted with the surname', Q.cardNameProblem(good({ contactName: 'Dr. Lee Park', dmText: 'Hi Dr. Park, an idea.' })) === null);
  ok('no contact name fails', /no contact name/.test(Q.cardNameProblem(good({ contactName: null }))) && /no contact name/.test(Q.cardNameProblem(good({ contactName: '' }))));
  ok('a role is not a person: "Owner", "Marketing Director", "Team", "Front Desk", "Hiring Manager"',
    ['Owner', 'Marketing Director', 'Team', 'Front Desk', 'Hiring Manager', 'The Owner', 'Staff', 'General Manager', 'info'].every((n) => /role, not a person|not a person/.test(Q.cardNameProblem(good({ contactName: n, dmText: `Hi ${n},` })) || '')),
    ['Owner', 'Marketing Director', 'Team', 'Front Desk'].map((n) => Q.cardNameProblem(good({ contactName: n }))));
  ok('  "Legion Hair Studio Team" and "Legion Hair Studio" are not people', /not a person|business name/.test(Q.cardNameProblem(good({ contactName: 'Legion Hair Studio Team' }))) && /business name|not a person/.test(Q.cardNameProblem(good({ contactName: 'Legion Hair Studio' }))));
  ok('  an honorific alone is not a name', /honorific/.test(Q.cardNameProblem(good({ contactName: 'Dr.' }))));
  ok('the message must open to that person: "Hi," fails', /greets nobody/.test(Q.cardNameProblem(good({ dmText: 'Hi, I work with Messiah.' }))));
  ok('  "Hi there," fails', /greets nobody/.test(Q.cardNameProblem(good({ dmText: 'Hi there, I work with Messiah.' }))));
  ok('  "Hello," fails', /greets nobody/.test(Q.cardNameProblem(good({ dmText: 'Hello, I work with Messiah.' }))));
  ok('  no greeting line at all fails', /no greeting line/.test(Q.cardNameProblem(good({ dmText: 'I work with Messiah Mickens and had an idea.' }))));
  ok('  greeting someone else fails', /greets "Sam", not the contact/.test(Q.cardNameProblem(good({ dmText: 'Hi Sam, an idea.' }))));
  ok('  an empty message fails', /no message/.test(Q.cardNameProblem(good({ dmText: '' }))));
  ok('an email card is judged on its email body', Q.cardNameProblem(good({ channel: 'email', email: 'legionhair@legionhairstudio.com', emailBody: 'Hi Dana, an idea.', dmText: null })) === null
    && /greets nobody/.test(Q.cardNameProblem(good({ channel: 'email', email: 'legionhair@legionhairstudio.com', emailBody: 'Hi, an idea.', dmText: null }))));
  ok('a call card carries no message, so only the name is checked', Q.cardNameProblem(good({ channel: 'call', dmText: null })) === null && /no contact name/.test(Q.cardNameProblem(good({ channel: 'call', dmText: null, contactName: null }))));
  ok('a database row is read the same way (contact_name, dm_text, body_html)',
    Q.cardNameProblem({ contact_name: 'Dana Roberts', brand_name: 'Legion Hair Studio', channel: 'dm', dm_text: 'Hi Dana, x' }) === null
    && /greets nobody/.test(Q.cardNameProblem({ contact_name: 'Dana Roberts', brand_name: 'Legion Hair Studio', channel: 'email', body_html: '<p>Hi,</p><p>x</p>' }))
    && /no contact name/.test(Q.cardNameProblem({ contact_name: null, brand_name: 'Legion Hair Studio', channel: 'email', body_html: '<p>Hi,</p>' })));

  // ── 2. THE ONE PLACE: insertCard, FOR EVERY PATH ──────────────────────────
  OUT.push('', '-- insertCard refuses, for every path --');
  const ins = (card, slot) => JOB.insertCard(P(), { agentId: AG, athleteId: ATH, slot: slot || 1, card });
  ok('the nightly/on-demand path: a card with no contact is refused and nothing is written', (await ins(good({ contactName: null }))) === false && (await rows()).length === 0);
  ok('  a card whose contact is a role is refused', (await ins(good({ contactName: 'Owner', dmText: 'Hi Owner,' }))) === false && (await rows()).length === 0);
  ok('  a DM card that opens "Hi," is refused', (await ins(good({ dmText: 'Hi, an idea.' }))) === false && (await rows()).length === 0);
  ok('  an email card that opens "Hi," is refused AND no email draft is left behind',
    (await ins(good({ channel: 'email', email: 'legionhair@legionhairstudio.com', emailBody: 'Hi, an idea.', subject: 'Quick idea', dmText: null }))) === false
    && (await rows()).length === 0 && (await drafts()).length === 0);
  ok('  an email card with no contact is refused, no draft', (await ins(good({ channel: 'email', email: 'legionhair@legionhairstudio.com', emailBody: 'Hi Dana, an idea.', dmText: null, contactName: null }))) === false && (await drafts()).length === 0);
  ok('  a program-lane card (built by buildProgramCard with no person) is refused',
    (await ins(Object.assign(Q.buildProgramCard({ brand_name: 'Auburn Athletics', why: 'x', program_url: 'https://x' }, { message: 'Hi, an idea for the program.' }, 'Messiah Mickens', null, null), { lane: 'program' }), 2)) === false && (await rows()).length === 0);
  ok('  a program-lane card WITH a person and their name in the greeting is written',
    (await ins(Object.assign(Q.buildProgramCard({ brand_name: 'Auburn Athletics', why: 'x', program_url: 'https://x' }, { message: 'Hi Pat, an idea for the program.' }, 'Messiah Mickens', null, { name: 'Pat Dye', title: 'Marketing Director' }), { lane: 'program' }), 2)) === true && (await rows()).length === 1);
  ok('a good local card is written', (await ins(good(), 1)) === true && (await rows()).length === 2);
  const written = (await rows()).find((r) => r.slot === 1);
  ok('  with the person and the greeting on it', written && written.contact_name === 'Dana Roberts' && /^Hi Dana,/.test(written.dm_text));
  ok('  a good email card is written with its draft', (await ins(good({ brandKey: 'name:cuts by k', brandName: 'Cuts by K', contactName: 'Kim Ito', channel: 'email', email: 'kim@cutsbyk.com', emailBody: 'Hi Kim, an idea.', subject: 'Quick idea', dmText: null }), 3)) === true && (await drafts()).length === 1);

  OUT.push('', '-- there is no other door --');
  const job = src('server/jobs/outreachQueue.js');
  ok('insertCard checks the rule first, before the placeholder gate and before the email draft', (() => { const i = job.indexOf('async function insertCard('); const s = job.slice(i); return s.indexOf('Q.cardNameProblem(card)') < s.indexOf('store.placeholderReason') && s.indexOf('Q.cardNameProblem(card)') < s.indexOf('INSERT INTO outreach_logs'); })());
  ok('  no environment switch turns it off', /const NAME_REQUIRED = true;/.test(job) && !/OUTREACH_NAME_REQUIRED/.test(job.replace(/\/\/.*$/gm, '')));
  ok('  both nightly call sites (local, program) save through insertCard', (job.match(/await insertCard\(pool, \{ agentId, athleteId, slot, card/g) || []).length >= 2);
  const grep = (dir) => fs.readdirSync(REPO + dir).filter((f) => f.endsWith('.js')).map((f) => [dir + '/' + f, src(dir + '/' + f)]);
  const inserters = [...grep('server'), ...grep('server/services'), ...grep('server/jobs'), ...grep('server/routes'), ...grep('scripts')]
    .filter(([f, s]) => /INSERT INTO outreach_queue(?![_a-z])/.test(s.replace(/\/\/.*$/gm, '')))
    .map(([f]) => f);
  ok('the only INSERT INTO outreach_queue in the codebase is insertCard', inserters.length === 1 && inserters[0] === 'server/jobs/outreachQueue.js', inserters);
  ok('  the seed script saves through insertCard, not its own INSERT', /require\('\.\.\/server\/jobs\/outreachQueue'\)\.insertCard\(pool/.test(src('scripts/seed-queue.js')) && !/INSERT INTO outreach_queue\b(?!_)/.test(src('scripts/seed-queue.js').replace(/\/\/.*$/gm, '')));
  const idx = src('server/index.js');
  ok('  the DM edit route keeps the rule: an edit that greets nobody is a 400', /app\.patch\('\/api\/agent\/outreach-queue\/:id'[\s\S]{0,900}cardNameProblem\(\{ \.\.\.cur, dm_text: dmText \}\)[\s\S]{0,200}status\(400\)/.test(idx));
  ok('  the closer, the outcome route and the retire routes only move state; none writes a contact or a message', !/UPDATE outreach_queue\s+SET[^;]*contact_name/.test(src('server/services/closer.js') + idx));

  // ── 3. THE WRITER OPENS WITH THE FIRST NAME ───────────────────────────────
  OUT.push('', '-- the writer --');
  const pw = src('server/services/pitchWriter.js');
  ok('the prompt never tells the model to open "Hi," any more', !/Open with "Hi,"/.test(pw) && !/Open with "Hi," exactly/.test(pw) && /Never open "Hi," or "Hi there,"/.test(pw));
  ok('  and the lint rejects a draft that does not open with the first name', /does not open with "Hi ' \+ opts\.greetFirstName \+ ',"/.test(pw) && /greetFirstName/.test(pw.slice(pw.indexOf('const lintOpts'), pw.indexOf('const lintOpts') + 400)));
  const lint = (m) => PW.lintMessage(m, { signOff: 'John', greetFirstName: 'Dana' });
  ok('  "Hi Dana," passes the greeting check', !lint('Hi Dana, I work with Messiah. He could do a signing. Worth a chat? It would be easy.\n\nJohn').problems.some((p) => /open with/.test(p)));
  ok('  "Hi," is rejected', lint('Hi, I work with Messiah. He could do a signing. Worth a chat? It would be easy.\n\nJohn').problems.some((p) => /does not open with "Hi Dana,"/.test(p)));
  ok('  "Hi there," is rejected', lint('Hi there, I work with Messiah. He could do a signing. Worth a chat? It would be easy.\n\nJohn').problems.some((p) => /does not open with "Hi Dana,"/.test(p)));
  ok('  no greeting is rejected', lint('I work with Messiah. He could do a signing. Worth a chat? It would be easy.\n\nJohn').problems.some((p) => /does not open with/.test(p)));
  ok('  the model is unchanged (the writer stays on Sonnet)', /sonnet/i.test(pw) && !/deepseek/i.test(pw));

  // ── 4. THE AUDIT OVER THE LIVE QUEUE ──────────────────────────────────────
  OUT.push('', '-- the live queue, audited and retired --');
  // Plant a bad card the way an old build would have: straight into the table.
  await P().query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, dm_text, channel, state, lane, email, identity_key)
                   VALUES ($1,$2,4,'name:old shop','Old Shop','x',NULL,'Hi, an old card.','dm','queued','local',NULL,'name:old shop|x')`, [AG, ATH]);
  await P().query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, dm_text, channel, state, lane, email, identity_key)
                   VALUES ($1,$2,5,'name:role shop','Role Shop','x','Owner','Hi Owner, an old card.','dm','queued','local',NULL,'name:role shop|x')`, [AG, ATH]);
  const audit = await QA.namelessCards(P(), { agentId: AG });
  ok('the audit finds the nameless cards and counts them per agent', audit.total === 5 && audit.bad.length === 2 && audit.perAgent['nl@x.com'] === 2 && audit.bad.every((c) => c.problem), { total: audit.total, bad: audit.bad.map((c) => [c.brand_name, c.problem]), per: audit.perAgent });
  const cnt = await QA.namelessLiveCount(P());
  ok('  the spend report count sees them (must be 0 in production)', cnt.nameless >= 2 && cnt.live >= cnt.nameless && Array.isArray(cnt.sample) && cnt.sample.length >= 1 && cnt.sample.every((s) => s.problem), cnt);
  const ret = await QA.retireNameless(P(), audit.bad.map((c) => c.id));
  const after = await rows();
  ok('  retiring sets state retired, outcome no_name, and leaves the good cards queued', ret.retired === 2 && after.filter((r) => r.state === 'retired' && r.outcome === 'no_name').length === 2 && after.filter((r) => r.state === 'queued').length === 3);
  ok('  and the queue is clean afterwards', (await QA.namelessCards(P(), { agentId: AG })).bad.length === 0);
  ok('the retire script and the admin endpoint use the same audit', /queueAudit/.test(src('scripts/retire-nameless-cards.js')) && /QA\.namelessCards\(P, \{ agentId \}\)/.test(src('scripts/retire-nameless-cards.js')) && /app\.get\('\/api\/admin\/nameless-cards', requireAuth/.test(idx) && /QA\.retireNameless\(store\.pool, bad\.map/.test(idx));
  ok('  the spend report prints the count and says it must be 0', /LIVE CARDS WITH NO NAMED CONTACT/.test(src('scripts/spend-breakdown.js')) && /Must be 0/.test(src('scripts/spend-breakdown.js')) && /namelessLiveCount/.test(src('scripts/spend-breakdown.js')));

  // ── 4b. A NAMED CARD LINKED TO A NAMELESS PREWARM DRAFT ──────────────────
  // The twelve: each card passed the gate, then linked to the prewarm draft
  // for the same business, which said "Hi," (or "Hi Jill,") to nobody.
  OUT.push('', '-- a card that links to an existing draft rewrites a draft that greets nobody --');
  await P().query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, source, sent_to_email)
                   VALUES ('nl-pre-1', $1, $2, 'KSTATE Credit Union', 'name:kstate credit union', 'KSTATE x Messiah', '<div>Hi Jill,</div><div><br></div><div>A prewarm draft to nobody.</div>', 'draft', 'prewarm', 'info@kstate.example')`, [AG, ATH]);
  const linked = await ins(good({ brandKey: 'name:kstate credit union', brandName: 'KSTATE Credit Union', contactName: 'LaRae Kraemer', contactTitle: 'Marketing Director', channel: 'email', email: 'larae@kstate.example', subject: 'Quick idea for KSTATE Credit Union', emailBody: 'Hi LaRae, an idea for the student account drive.', dmText: null }), 6);
  const lrow = (await rows()).find((r) => r.brand_name === 'KSTATE Credit Union');
  const ldraft = (await P().query(`SELECT * FROM outreach_logs WHERE id = 'nl-pre-1'`)).rows[0];
  ok('the card is written and linked to the existing prewarm draft', linked === true && lrow && lrow.outreach_log_id === 'nl-pre-1', lrow && lrow.outreach_log_id);
  ok('  and that draft now greets LaRae, not Jill: rewritten to the card\'s own pitch', ldraft && /<p>Hi LaRae, an idea/.test(ldraft.body_html) && !/Jill/.test(ldraft.body_html) && ldraft.subject === 'Quick idea for KSTATE Credit Union', ldraft && ldraft.body_html);
  ok('  so the rule holds over the stored draft too', Q.cardNameProblem({ contact_name: 'LaRae Kraemer', brand_name: 'KSTATE Credit Union', channel: 'email', body_html: ldraft.body_html }) === null);
  ok('  the audit sees no problem on it', (await QA.namelessCards(P(), { agentId: AG })).bad.length === 0);

  // ── 5. "NOT CHECKED YET" ──────────────────────────────────────────────────
  OUT.push('', '-- the email check on unchecked cards --');
  await P().query(`DELETE FROM email_verification WHERE email IN ('kim@cutsbyk.com')`).catch(() => {});
  const dry = await QA.checkQueuedEmails(P(), { apply: false });
  ok('the audit lists every queued email card with no verification row', dry.cards >= 1 && dry.addresses >= 1 && dry.applied === false);
  ok('  the admin endpoint runs it in the background with apply=1 and returns the tally', /app\.get\('\/api\/admin\/check-card-emails', requireAuth/.test(idx) && /QA\.checkQueuedEmails\(store\.pool, \{ apply: true/.test(idx) && /tally/.test(src('server/services/queueAudit.js')));

  await clean();
  await P().query(`DELETE FROM email_verification WHERE email IN ('kim@cutsbyk.com')`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch(async (e) => { console.error('namelesscards: FAILED', e); try { await P().end(); } catch (_) {} process.exit(1); });
