'use strict';
// Runs against the local test Postgres. No network: research, the writer and
// the mail provider are stubs; the demo night is the engine's own dry run with
// its two outermost calls (the Places context and fillAthlete) recorded.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/coldagent.js      just this one
//
// ── THE COLD AGENT: OUR OWN PIPELINE ──────────────────────────────────────
// The definition of done, as a test:
//   someone who logged in this week is never picked
//   someone at 3 touches is never picked again
//   a suppressed person is never picked
//   a paying customer is never picked
//   the businesses in the email are real rows from a real run, not placeholders
//   an empty run still records why
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.BUSINESS_MAILING_ADDRESS = process.env.BUSINESS_MAILING_ADDRESS || '1 Main St, Auburn, AL 36830';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ca-admin@ca-admin.test';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const CA = require(REPO + 'server/services/coldAgent.js');
const sendRules = require(REPO + 'server/services/sendRules.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY);
const P = () => store.pool;
const S = CA.clampSettings({ ...CA.DEFAULTS, holdEmails: ['cal@fordsports.com'] });

// The people. Each is one rule.
const U = {
  g1old:    { name: 'Dana Fields',   email: 'dana@fieldsagency.com',  created: ago(180), login: ago(170) },
  // Never logged in, but a set-password link is out there and unexpired.
  g1new:    { name: 'Ray Ortiz',     email: 'ray@ortizsports.com',    created: ago(40),  login: null, link: 'valid' },
  // CANNOT LOG IN, three ways.
  lockedRandom:  { name: 'Lamar Wills',  email: 'lamar@willsreps.com',  created: ago(100), login: null, resetRequired: true },
  lockedExpired: { name: 'Nia Brooks',   email: 'nia@brooksnil.com',    created: ago(100), login: null, resetRequired: true, link: 'expired' },
  lockedForm:    { name: 'Omar Diaz',    email: 'omar@diazsports.com',  created: ago(100), login: null },
  // Held for the admin personally.
  greg:     { name: 'Tia Moss',      email: 'tia@mossagency.com',     created: ago(100), login: ago(60), referredBy: 'pliable' },
  handHeld: { name: 'Cal Ford',      email: 'cal@fordsports.com',     created: ago(100), login: ago(60) },
  g2:       { name: 'Kim Lowe',      email: 'kim@lowemgmt.com',       created: ago(120), login: ago(30), athletes: 2 },
  g3:       { name: 'Pat Greer',     email: 'pat@greernil.com',       created: ago(60),  login: ago(10), athletes: 1 },
  active:   { name: 'Lee Young',     email: 'lee@youngreps.com',      created: ago(90),  login: ago(2) },
  paying:   { name: 'Max Hale',      email: 'max@halesports.com',     created: ago(90),  login: ago(40), sub: 'active' },
  trialing: { name: 'Bo Tran',       email: 'bo@tranagency.com',      created: ago(20),  login: ago(15), sub: 'trialing' },
  touched3: { name: 'Sky Park',      email: 'sky@parkreps.com',       created: ago(200), login: ago(100), touches: 3, lastTouch: ago(40) },
  recent:   { name: 'Ann Cole',      email: 'ann@colesports.com',     created: ago(200), login: ago(100), touches: 1, lastTouch: ago(5) },
  gapOk:    { name: 'Joe Pike',      email: 'joe@pikemgmt.com',       created: ago(200), login: ago(100), touches: 1, lastTouch: ago(11) },
  suppressed: { name: 'Val Ruiz',    email: 'val@ruizagency.com',     created: ago(150), login: ago(60) },
  internal: { name: 'Keith Compton', email: 'keith@somewhere.com',    created: ago(150), login: ago(60) },
  testy:    { name: 'Card Test',     email: 'cardtest@gmail.com',     created: ago(150), login: ago(60) },
  comped:   { name: 'Gus Bell',      email: 'gus@bellsports.com',     created: ago(150), login: ago(60), comped: true },
  using:    { name: 'Eve Shaw',      email: 'eve@shawagency.com',     created: ago(150), login: ago(9), athletes: 1, approved: true },
};
const ID = (k) => 'ca-' + k;
const IDS = Object.keys(U).map(ID);

async function seed() {
  const p = P();
  await p.query(`INSERT INTO users (id,name,email,password,role) VALUES ('ca-admin','John Mark Compton',$1,'x','admin') ON CONFLICT (id) DO NOTHING`, [process.env.ADMIN_EMAIL]);
  for (const [k, u] of Object.entries(U)) {
    await p.query(`INSERT INTO users (id,name,email,password,role,created_at,last_login,subscription_status,comped,password_reset_required,referred_by)
                   VALUES ($1,$2,$3,'x','agent',$4,$5,$6,$7,$8,$9)`, [ID(k), u.name, u.email, u.created, u.login, u.sub || null, !!u.comped, !!u.resetRequired, u.referredBy || null]);
    if (u.link) {
      await p.query(`INSERT INTO password_resets (email, token_hash, expires_at, used) VALUES ($1, $2, $3, FALSE)`,
        [u.email, 'ca-hash-' + k, u.link === 'valid' ? new Date(Date.now() + 5 * DAY) : ago(30)]);
    }
    for (let i = 0; i < (u.athletes || 0); i++) {
      await p.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
        [ID(k) + '-ath' + i, ID(k), JSON.stringify({ name: 'Tess Court ' + i, school: 'Auburn University', sport: 'Tennis' })]);
    }
    if (u.touches) {
      await p.query(`INSERT INTO cold_prospects (user_id,email,touches,first_touch_at,last_touch_at) VALUES ($1,$2,$3,$4,$4)`, [ID(k), u.email, u.touches, u.lastTouch]);
    }
    if (u.approved) {
      await p.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,approved_at)
                     VALUES ($1,$2,$3,'Some Biz','s','<p>x</p>','approved',NOW() - INTERVAL '20 days')`, [ID(k) + '-log', ID(k), ID(k) + '-ath0']);
    }
  }
  await sendRules.suppressManually(p, U.suppressed.email, { reason: 'test: said no', kind: 'unsubscribe' });
}
async function clean() {
  const p = P();
  await p.query(`DELETE FROM cold_demo_cards WHERE draft_id IN (SELECT id FROM cold_drafts WHERE user_id = ANY($1))`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM cold_drafts WHERE user_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM cold_prospects WHERE user_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM outreach_logs WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM email_suppression WHERE email = ANY($1)`, [Object.values(U).map((u) => u.email)]).catch(() => {});
  await p.query(`DELETE FROM email_sends WHERE email = ANY($1)`, [Object.values(U).map((u) => u.email)]).catch(() => {});
  await p.query(`DELETE FROM password_resets WHERE email = ANY($1)`, [Object.values(U).map((u) => u.email)]).catch(() => {});
  await p.query(`DELETE FROM users WHERE id = ANY($1) OR id = 'ca-admin'`, [IDS]).catch(() => {});
  await p.query(`DELETE FROM cold_runs WHERE trigger LIKE 'test%'`).catch(() => {});
}

// A real-shaped card, as the engine hands it to onCard.
const engineCard = (i) => ({ brandName: `Court Side Grill ${i}`, contactName: `Dana Kessler ${i}`, contactTitle: 'Owner',
  email: `dana${i}@courtside${i}.com`, phone: null, instagram: null, why: 'Two blocks from the tennis center', businessCategory: 'restaurant', channel: 'email' });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await CA.ensureTables(P());
  await clean();
  await seed();

  // ── 1. WHO IS PICKED ─────────────────────────────────────────────────────
  OUT.push('-- who is picked --');
  const rows = (await CA.candidates(P())).filter((u) => IDS.includes(u.id));
  const by = Object.fromEntries(rows.map((u) => [u.id, CA.classify(u, S)]));
  const c = (k) => by[ID(k)] || {};
  ok('someone who logged in this week is never picked', !c('active').group && /logged in this week/.test(c('active').why), c('active'));
  ok('someone at 3 touches is never picked again', !c('touched3').group && /3 touches/.test(c('touched3').why), c('touched3'));
  ok('a suppressed person is never picked', !c('suppressed').group && /suppressed/.test(c('suppressed').why), c('suppressed'));
  ok('a paying customer is never picked', !c('paying').group && /paying/.test(c('paying').why), c('paying'));
  ok('  nor one on a live trial subscription', !c('trialing').group && /paying/.test(c('trialing').why), c('trialing'));
  ok('our own people and test accounts are never picked', !c('internal').group && !c('testy').group, [c('internal'), c('testy')]);
  ok('  nor a comped account', !c('comped').group && /comped/.test(c('comped').why), c('comped'));
  ok('10 days between touches: 5 days ago is not picked, 11 days ago is', !c('recent').group && /10 days/.test(c('recent').why) && c('gapOk').group === 1, [c('recent'), c('gapOk')]);
  ok('group 1: signed up, never added an athlete', c('g1old').group === 1 && c('g1new').group === 1);
  ok('group 2: athletes, no login for 14+ days', c('g2').group === 2, c('g2'));
  ok('group 3: athletes, logs in, never approved a card', c('g3').group === 3, c('g3'));
  ok('someone using it (has approved cards, logged in within 14 days) is left alone', !c('using').group, c('using'));

  // ── CANNOT LOG IN ──
  ok('CANNOT LOG IN: created for them with a random password and no link ever issued', c('lockedRandom').hold === 'login' && /no set-password link was ever issued/.test(c('lockedRandom').why), c('lockedRandom'));
  ok('  a link issued, never used, now expired', c('lockedExpired').hold === 'login' && /expired/.test(c('lockedExpired').why), c('lockedExpired'));
  ok('  signed up, never logged in, no link ever issued', c('lockedForm').hold === 'login' && /never logged in/.test(c('lockedForm').why), c('lockedForm'));
  ok('  a never-logged-in account WITH an unexpired link is eligible', c('g1new').group === 1, c('g1new'));
  // The fix lands: a working link is issued, and they are eligible by themselves.
  await P().query(`INSERT INTO password_resets (email, token_hash, expires_at, used) VALUES ($1, 'ca-hash-fixed', $2, FALSE)`, [U.lockedRandom.email, new Date(Date.now() + 7 * DAY)]);
  const fixed = CA.classify((await CA.candidates(P())).find((u) => u.id === ID('lockedRandom')), S);
  ok('  once a working set-password link exists, they become eligible again with no other change', fixed.group === 1, fixed);
  await P().query(`DELETE FROM password_resets WHERE token_hash = 'ca-hash-fixed'`);
  // ── HELD FOR THE ADMIN ──
  ok("GREG GLYNN'S REFERRALS are held out, named as his", c('greg').hold === 'referral' && /Greg Glynn/.test(c('greg').why), c('greg'));
  ok('  and so is anyone on the hand hold list', c('handHeld').hold === 'hand', c('handHeld'));

  const pk = await CA.pick(P(), { settings: S, limit: 20, onlyIds: IDS });
  ok('the page gets them in their own groups: cannot log in, held for you',
    pk.held.filter((h) => h.hold === 'login').map((h) => h.id).sort().join() === [ID('lockedExpired'), ID('lockedForm'), ID('lockedRandom')].sort().join()
    && pk.held.filter((h) => h.hold !== 'login').map((h) => h.id).sort().join() === [ID('greg'), ID('handHeld')].sort().join(), pk.held);
  ok('ONE PERSON A RUN by default, in code', CA.DEFAULTS.perRun === 1 && CA.clampSettings({}).perRun === 1);
  ok('priority order: group 1 oldest first, then 2, then 3',
    JSON.stringify(pk.picked.map((u) => u.id)) === JSON.stringify([ID('gapOk'), ID('g1old'), ID('g1new'), ID('g2'), ID('g3')]), pk.picked.map((u) => [u.id, u.group]));

  // ── 2. AN EMPTY RUN SAYS WHY ─────────────────────────────────────────────
  OUT.push('', '-- an empty run --');
  const empty = await CA.runOnce(P(), { trigger: 'test-empty', deps: { onlyIds: [ID('active'), ID('paying'), ID('touched3'), ID('lockedRandom')] } });
  const er = (await P().query(`SELECT * FROM cold_runs WHERE id = $1`, [empty.runId])).rows[0];
  ok('a run that finds nobody writes a row saying so, with every reason counted',
    er && er.finished_at && er.picked === 0 && /^Nobody to contact\./.test(er.note) && /logged in this week/.test(er.note) && /paying customer/.test(er.note) && /3 touches/.test(er.note) && /1 cannot log in/.test(er.note), er && er.note);

  // ── 3. A REAL RUN: THE DEMO IS THE ENGINE, THE EMAIL NAMES ITS ROWS ──────
  OUT.push('', '-- a run: the demo night, the draft --');
  const job = require(REPO + 'server/jobs/outreachQueue.js');
  const realFill = job.fillAthlete, realCtx = job.localContextFor;
  const engineCalls = [];
  job.localContextFor = async (ath) => ({ profile: { hasLocalMarket: true, marketKey: 'auburn, al' }, region: { city: 'Auburn', state: 'AL' }, fault: null, _ath: ath });
  job.fillAthlete = async (pool, ctx) => {
    engineCalls.push({ agentId: ctx.agentId, athleteId: ctx.athleteId, dryRun: ctx.dryRun, maxSlots: ctx.maxSlots, skipsOwn: typeof ctx.skipBrand === 'function' });
    for (let i = 1; i <= 5; i++) await ctx.onCard(engineCard(i));
    // One the engine found without a named person: never shown.
    await ctx.onCard({ ...engineCard(9), contactName: null });
    return { filled: 5, tried: new Array(12).fill({}) };
  };
  const sent = [];
  const deps = {
    onlyIds: [ID('g2')],
    research: async () => ({ agency: 'Lowe Management', role: 'Founder', rosterSize: 12, sports: ['Tennis'], rosterAthletes: [], recent: null }),
    write: async (u, ctx) => CA.templateEmail({ u, subject: ctx.subject, cards: ctx.cards, senderFirst: 'John Mark', touchNo: ctx.touchNo }),
    send: async (m) => { sent.push(m); return { providerMessageId: 'fake-1' }; },
    awaitSend: true,
  };
  let run;
  try { run = await CA.runOnce(P(), { trigger: 'test-run', deps }); }
  finally { job.fillAthlete = realFill; job.localContextFor = realCtx; }
  ok('the run drafted one email for the one person picked', run.ok && run.drafted === 1, run);
  const ec = engineCalls[0] || {};
  ok('the demo is the nightly engine\'s fillAthlete, DRY, five slots', engineCalls.length === 1 && ec.dryRun === true && ec.maxSlots === 5, engineCalls);
  ok('  under the sandbox agent and a throwaway athlete id: nothing lands in the customer\'s account',
    ec.agentId === CA.SANDBOX_AGENT && /^colddemo:/.test(ec.athleteId) && !/^ca-/.test(ec.athleteId) && ec.skipsOwn, ec);
  const d = (await P().query(`SELECT * FROM cold_drafts WHERE user_id = $1`, [ID('g2')])).rows[0];
  const demoRows = (await P().query(`SELECT * FROM cold_demo_cards WHERE draft_id = $1 ORDER BY id`, [d && d.id])).rows;
  ok('the businesses are stored as rows from the run, each with a named person and a way to reach them',
    demoRows.length === 5 && demoRows.every((r) => r.contact_name && r.email && r.demo_athlete_id === ec.athleteId), demoRows.map((r) => [r.brand_name, r.contact_name]));
  ok('  the one the engine found with no named person is not among them', !demoRows.some((r) => /Grill 9/.test(r.brand_name)));
  const named = demoRows.filter((r) => d.body_text.includes(r.brand_name));
  const anyOther = /Court Side Grill (?![1-5]\b)\d/.test(d.body_text);
  ok('THE EMAIL NAMES THE REAL ROWS: every business in it is a stored demo row, and it names them all', named.length === 5 && !anyOther, d.body_text);
  ok('  and the people', demoRows.every((r) => d.body_text.includes(r.contact_name)));
  ok('  no placeholder and no banned phrase', !require(REPO + 'server/services/placeholders.js').find(d.subject + '\n' + d.body_text).length
    && CA.checkEmail(d.subject, d.body_text, demoRows.map((r) => r.brand_name)).length === 0, CA.checkEmail(d.subject, d.body_text, demoRows.map((r) => r.brand_name)));
  ok('  the card shows who, why them, the touch number', d.grp === 2 && /14\+ days/.test(d.why) && d.touch_no === 1 && d.status === 'pending', d);
  ok('nothing was sent: it waits for approval', sent.length === 0);

  // ── 3b. FEWER THAN 3: NO DEMO, NO EMAIL ──────────────────────────────────
  OUT.push('', '-- a thin demo --');
  const thinSent = sent.length;
  const thin = await CA.runOnce(P(), { trigger: 'test-thin', deps: { ...deps, onlyIds: [ID('g1old')],
    research: async () => ({ agency: 'Fields Agency', sports: ['Tennis'], rosterAthletes: [], nearbySchool: 'Auburn University' }),
    runDemo: async () => ({ demoAthleteId: 'colddemo:thin', cards: [engineCard(1), engineCard(2), { ...engineCard(3), contactName: null }], tried: 9 }) } });
  const td = (await P().query(`SELECT * FROM cold_drafts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [ID('g1old')])).rows[0];
  ok('fewer than 3 businesses with a named person: no email is drafted, the person is shown as "no demo" with why',
    thin.drafted === 0 && td && td.status === 'no_demo' && !td.subject && !td.body_text && /found 2 businesses with a named person/.test(td.status_note) && /needs 3/.test(td.status_note), { thin: thin.note, td });
  ok('  what it did find is kept for you to see', (await P().query(`SELECT COUNT(*)::int n FROM cold_demo_cards WHERE draft_id = $1`, [td && td.id])).rows[0].n === 2);
  ok('  nothing sent, no touch counted', sent.length === thinSent && !(await P().query(`SELECT 1 FROM cold_prospects WHERE user_id = $1`, [ID('g1old')])).rowCount);
  ok('  it cannot be approved', !((await CA.approve(P(), td.id, {}, deps)).state === 'sending') && sent.length === thinSent);
  ok('  the run says so', /No demo for 1, not emailed/.test(thin.note), thin.note);
  const again = CA.classify((await CA.candidates(P())).find((u) => u.id === ID('g1old')), S);
  ok('  and they are not tried (and spent on) again for 14 days', !again.group && /no demo/.test(again.why), again);
  ok('  the "No demo" tab lists them', (await CA.listDrafts(P(), { status: 'no_demo' })).some((x) => x.id === td.id));
  await P().query(`DELETE FROM cold_demo_cards WHERE draft_id = $1`, [td.id]);
  await P().query(`DELETE FROM cold_drafts WHERE id = $1`, [td.id]);

  // ── 4. APPROVE ───────────────────────────────────────────────────────────
  OUT.push('', '-- approve --');
  const ap = await CA.approve(P(), d.id, {}, deps);
  ok('approve sends it, once', ap.ok && sent.length === 1 && sent[0].to === U.g2.email, { ap, sent: sent.length });
  ok('  with the CAN-SPAM footer: why, a working unsubscribe link, the postal address',
    /You received this because you have a NILDash account\./.test(sent[0].html) && /\/unsubscribe\?u=/.test(sent[0].html) && sent[0].html.includes(process.env.BUSINESS_MAILING_ADDRESS), sent[0].html.slice(-500));
  const ap2 = await CA.approve(P(), d.id, {}, deps);
  ok('  a second approve sends nothing', ap2.ok && ap2.already && sent.length === 1, ap2);
  const pr = (await P().query(`SELECT * FROM cold_prospects WHERE user_id = $1`, [ID('g2')])).rows[0];
  ok('the touch is counted only once it left, with the time', pr && pr.touches === 1 && pr.last_touch_at, pr);
  ok('  and recorded with every other sender (email_sends)', (await P().query(`SELECT 1 FROM email_sends WHERE email = $1 AND system = 'cold-agent'`, [U.g2.email])).rowCount === 1);
  const after = CA.classify((await CA.candidates(P())).find((u) => u.id === ID('g2')), S);
  ok('  so they are not picked again for 10 days', !after.group && /10 days/.test(after.why), after);

  // ── 5. EVERY RULE AGAIN AT THE CLICK ────────────────────────────────────
  OUT.push('', '-- re-checked at approval --');
  await P().query(`INSERT INTO cold_drafts (id,user_id,email,name,grp,why,subject,body_text,touch_no) VALUES ('ca-late',$1,$2,'Dana Fields',1,'x','s','b',1)`, [ID('g1old'), U.g1old.email]);
  await P().query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [ID('g1old')]);
  const late = await CA.approve(P(), 'ca-late', {}, deps);
  const lateRow = (await P().query(`SELECT status, status_note FROM cold_drafts WHERE id = 'ca-late'`)).rows[0];
  ok('a draft for someone who logged in after it was written is not sent at the click', !late.ok && /logged in this week/.test(late.error) && lateRow.status === 'skipped' && sent.length === 1, { late, lateRow });
  await P().query(`UPDATE users SET last_login = $2 WHERE id = $1`, [ID('g1old'), U.g1old.login]);

  // ── 6. NO, BOUNCED, REPLIED ──────────────────────────────────────────────
  OUT.push('', '-- stops --');
  await CA.mark(P(), ID('g3'), 'no');
  const g3 = CA.classify((await CA.candidates(P())).find((u) => u.id === ID('g3')), S);
  const anySender = await sendRules.check(P(), { email: U.g3.email, subject: 'anything', system: 'closer' });
  ok('"they said no" suppresses them for this agent and every other sender', !g3.group && !anySender.ok && anySender.kind === 'suppressed', { g3, anySender });
  await CA.mark(P(), ID('g1new'), 'replied');
  const g1n = CA.classify((await CA.candidates(P())).find((u) => u.id === ID('g1new')), S);
  ok('"they replied" stops the touches', !g1n.group && /replied/.test(g1n.why), g1n);

  // ── 7. THE EMAIL'S OWN RULES ─────────────────────────────────────────────
  OUT.push('', '-- the message --');
  const names = ['A Biz', 'B Biz', 'C Biz'];
  const good = 'Hi Kim,\n\n- A Biz: Dana\n- B Biz: Lee\n- C Biz: Jo\n\nLog in and look.\n\nJohn Mark';
  ok('a plain email with the businesses passes', CA.checkEmail('3 businesses for Tess', good, names).length === 0, CA.checkEmail('3 businesses for Tess', good, names));
  for (const bad of ['Just checking in on your account.', 'I wanted to follow up.', 'Since you signed up in April you have not added anyone.', "It's been a while!", 'We noticed you have not logged in.']) {
    ok(`  refuses: "${bad}"`, CA.checkEmail('x', good + '\n' + bad, names).length > 0);
  }
  ok('  refuses an email that does not name the businesses', CA.checkEmail('x', 'Hi Kim, log in and look. John Mark', names).length > 0);
  ok('  refuses a placeholder', CA.checkEmail('x', good + ' [athlete_name]', names).length > 0);

  // ── 8. IT READS ONLY ITS OWN ROW OF EACH CUSTOMER TABLE ─────────────────
  OUT.push('', '-- isolation --');
  const src = fs.readFileSync(REPO + 'server/services/coldAgent.js', 'utf8');
  const sqls = src.match(/`[^`]*\b(FROM|JOIN|INTO|UPDATE)\s+(athletes|outreach_logs|outreach_queue|pitch_actions|market_business_seen|company_enrichment)\b[^`]*`/g) || [];
  const unscoped = sqls.filter((q) => !/agent_id = (u\.id|d\.user_id|\$1)/.test(q));
  ok('every query on a customer table is scoped to the one person (agent_id = their id)', sqls.length >= 4 && unscoped.length === 0, unscoped);
  ok('  and it writes to none of them', !/(INSERT INTO|UPDATE|DELETE FROM)\s+(athletes|outreach_logs|outreach_queue|pitch_actions)\b/.test(src));

  // The engine's two hooks, in the engine itself: a dry run hands its cards
  // to onCard in both lanes, and skipBrand is asked before any research.
  const eng = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the engine hands a dry run\'s card to onCard in both lanes', (eng.match(/if \(ctx\.onCard\) \{ try \{ await ctx\.onCard\(\{ \.\.\.(p?card), slot \}\)/g) || []).length === 2);
  ok('  and asks skipBrand before each research claim', (eng.match(/if \(ctx\.skipBrand && ctx\.skipBrand\(cand\.brand_name\)\) \{[\s\S]{0,300}?continue;\s*\}\s*(\/\/[^\n]*\n\s*)*if \(!\(await Claims\.claimResearch/g) || []).length === 2);

  // ── 9. THE SCHEDULE ──────────────────────────────────────────────────────
  OUT.push('', '-- the schedule --');
  const ct = (iso) => new Date(iso);   // October: Central is UTC-5
  ok('due on a weekday at 5:10 Central', CA.dueAt(S, ct('2026-10-05T10:10:00Z')) === true);
  ok('  not on a Saturday', CA.dueAt(S, ct('2026-10-03T10:10:00Z')) === false);
  ok('  not after the deadline, and never at 7am or later', CA.dueAt(S, ct('2026-10-05T12:00:00Z')) === false
    && CA.clampSettings({ ...S, deadlineHour: 9, deadlineMinute: 0 }).deadlineHour === 6);
  ok('the count and the times are settings (no deploy), clamped', CA.clampSettings({ perRun: 50 }).perRun === 10 && CA.clampSettings({ perRun: 3 }).perRun === 3);
  ok('the guardrails are not settings', !('maxTouches' in CA.DEFAULTS) && !('gapDays' in CA.DEFAULTS) && CA.MAX_TOUCHES === 3 && CA.GAP_DAYS === 10);

  await clean();
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}

main().catch(async (e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); try { await clean(); } catch (_) {} process.exit(1); });
