'use strict';
// ── "SEE IT FOR YOUR ATHLETE" (services/nilTry, /pitches) ───────────────────
// Local test Postgres; the card engine, the email and the alert are stand-ins.
//
//   - the agent types in one athlete; bad input, bots, repeats and floods are
//     turned away in plain words; an agent on the cold list stops getting it;
//   - nothing is built while NIL_TRY_ON is off; on, one at a time, oldest
//     first, never past NIL_TRY_PER_DAY a day;
//   - up to 5 businesses; fewer than 2 is a failed run; the hidden athlete and
//     its cards are deleted afterwards;
//   - the agent gets the link by email and JohnMark gets an alert;
//   - the page never shows an email address; its button carries their email
//     and the token, and the trial when it is on;
//   - after signup the athlete goes on their roster once;
//   - with NIL_TRY_ON the agent cold emails point at /pitches and pass their
//     checks; a school's email keeps the 15-minute ask;
//   - the routes and the signup hooks are wired.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('niltrytest', { schema: true });
process.env.APP_URL = 'https://mynildash.com';
process.env.SALES_SENDER_PHONE = '470-306-3835';
delete process.env.NIL_TRY_ON;
delete process.env.NIL_TRY_PER_DAY;
delete process.env.SALES_TRIAL_ON;
require('./helpers/offlineDns').install();

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const T = require(REPO + 'server/services/nilTry.js');
const SA = require(REPO + 'server/services/salesAutopilot.js');
const W = require(REPO + 'server/services/salesWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;
const NOW = new Date('2026-11-03T16:00:00Z');

function filler(n) {
  return async ({ pool, agentId, athleteId }) => {
    for (let i = 0; i < n; i++) {
      const logId = `oq-try-${athleteId}-${i}`;
      await pool.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, source, sent_to_email, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'draft','nightly-queue',$8,NOW(),NOW())`,
        [logId, agentId, athleteId, `Biz <${i}>`, `biz-${i}`, `Idea for Biz ${i}`, `<p>Hi Owner ${i},</p><p>A pitch &amp; a plan.</p>`, `owner${i}@biz${i}.test`]);
      await pool.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title, channel, state, email, outreach_log_id, identity_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'email','queued',$9,$10,$11)`,
        [agentId, athleteId, i + 1, `biz-${i}`, `Biz <${i}>`, `Near campus ${i}.`, `Owner ${i}`, 'Owner', `owner${i}@biz${i}.test`, logId, `biz-${i}-${athleteId}`]);
    }
    return { filled: n, note: n ? null : 'nothing found' };
  };
}
const mails = [], alerts = [];
const deps = (n) => ({ fill: filler(n), sendAgent: async (to, m) => mails.push({ to, ...m }), alert: async (m) => alerts.push(m) });
const GOOD = { name: 'Kelly Agent', email: 'Kelly@AgencyOne.test', agency: 'Agency One', athlete: 'Jalen Smith', school: 'Samford University', sport: 'football', level: 'd1', position: 'WR' };

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await T.ensureTables(P());
  await SA.ensureTables(P());

  OUT.push('-- asking --');
  const bad = async (input, opts) => T.request(P(), input, opts).then(() => null, (e) => e);
  ok('no email: asks for it', /email/i.test((await bad({ ...GOOD, email: 'nope' })).message));
  ok('one name only: asks for first and last', (await bad({ ...GOOD, athlete: 'Jalen' })).field === 'athlete');
  ok('no school: asks for it', (await bad({ ...GOOD, school: '' })).field === 'school');
  ok('an unknown sport: asks to pick one', (await bad({ ...GOOD, sport: 'quidditch' })).field === 'sport');
  ok('the hidden field catches a bot', (await bad({ ...GOOD, website: 'http://spam.test' })) instanceof Error);
  await P().query(`INSERT INTO sales_prospects (id, lane, org, person, email, status) VALUES ('sp-k', 'agency', 'Agency One', 'Kelly Agent', 'kelly@agencyone.test', 'active')`).catch((e) => OUT.push('note: ' + e.message));
  const r1 = await T.request(P(), GOOD, { ip: '1.1.1.1' });
  ok('a good request gets a private token', /^[A-Za-z0-9_-]{20,}$/.test(r1.token), r1);
  const row = (await P().query(`SELECT * FROM nil_tries WHERE token = $1`, [r1.token])).rows[0];
  ok('saved as typed, email lowercased, sport matched, waiting', row.email === 'kelly@agencyone.test' && row.sport === 'Football' && row.status === 'pending' && row.level === 'd1', row);
  const sp = (await P().query(`SELECT status, tag FROM sales_prospects WHERE id = 'sp-k'`)).rows[0];
  ok('an agent on the cold list stops getting cold emails once they ask', sp && sp.status === 'replied', sp);
  const again = await T.request(P(), { ...GOOD, athlete: 'Other Kid' }, { ip: '1.1.1.1' });
  ok('the same email this week gets the same page back', again.token === r1.token && again.existing === true);
  await T.request(P(), { ...GOOD, email: 'b@two.test' }, { ip: '2.2.2.2' });
  await T.request(P(), { ...GOOD, email: 'c@three.test' }, { ip: '2.2.2.2' });
  const flood = await bad({ ...GOOD, email: 'd@four.test' }, { ip: '2.2.2.2' });
  ok('a third request from one IP in a day is refused', flood && flood.status === 429, flood && flood.message);

  OUT.push('-- building --');
  ok('off: nothing is built', (await T.tick(P(), { now: NOW, deps: deps(5) })).skipped === 'NIL_TRY_ON is off');
  process.env.NIL_TRY_ON = 'true';
  process.env.NIL_TRY_PER_DAY = '2';
  let t = await T.tick(P(), { now: NOW, deps: deps(6) });
  ok('on: the oldest request is built first', t.token === r1.token && t.status === 'ready' && t.cards === 5, t);
  const built = (await P().query(`SELECT * FROM nil_tries WHERE token = $1`, [r1.token])).rows[0];
  ok('up to 5 businesses kept, with the person and the pitch as text', built.cards.length === 5 && built.cards[0].contactName === 'Owner 0'
    && /A pitch & a plan/.test(built.cards[0].pitch) && !/<p>/.test(built.cards[0].pitch), built.cards[0]);
  const left = (await P().query(`SELECT (SELECT COUNT(*) FROM athletes WHERE agent_id = $1)::int AS a, (SELECT COUNT(*) FROM outreach_queue WHERE agent_id = $1)::int AS q,
    (SELECT COUNT(*) FROM outreach_logs WHERE agent_id = $1)::int AS l`, [T.TRIES_ID])).rows[0];
  ok('the hidden athlete and its cards are deleted afterwards', left.a === 0 && left.q === 0 && left.l === 0, left);
  const tries = (await P().query(`SELECT archived FROM users WHERE id = $1`, [T.TRIES_ID])).rows[0];
  ok('built under a hidden, archived account', tries && tries.archived === true);
  ok('the agent gets the link by email', mails.length === 1 && mails[0].to === 'kelly@agencyone.test' && mails[0].text.includes('https://mynildash.com/pitches/' + r1.token)
    && /5 businesses ready to pitch for Jalen Smith/.test(mails[0].subject), mails[0]);
  ok('JohnMark is alerted that this agent raised their hand', alerts.some((a) => /sample ready: Kelly Agent/.test(a.subject) && /raised their hand/.test(a.text)), alerts.map((a) => a.subject));
  t = await T.tick(P(), { now: new Date(NOW.getTime() + 60000), deps: deps(1) });
  ok('fewer than 2 businesses: a failed run, and the agent is told', t.status === 'failed' && mails.length === 2 && /couldn't find enough/.test(mails[1].text), t);
  t = await T.tick(P(), { now: new Date(NOW.getTime() + 120000), deps: deps(5) });
  ok('never past the day\'s cap', /today's 2 are done/.test(t.skipped || ''), t);
  t = await T.tick(P(), { now: new Date(NOW.getTime() + 86400000), deps: deps(5) });
  ok('the next day the queue moves again', t.status === 'ready', t);

  OUT.push('-- the page --');
  let v = await T.view(P(), r1.token, { countView: true });
  ok('the page shows the athlete, the businesses and the people', v.status === 'ready' && v.athlete === 'Jalen Smith' && v.cards.length === 5 && v.agentFirst === 'Kelly');
  ok('never an email address on the page', !JSON.stringify(v).includes('@biz'), v.cards[0]);
  ok('the button carries their email and the token; no trial while it is off', v.signupUrl.includes('email=kelly%40agencyone.test') && v.signupUrl.includes('try=' + r1.token)
    && !/trial=/.test(v.signupUrl) && v.trialOn === false, v.signupUrl);
  process.env.SALES_TRIAL_ON = 'true';
  v = await T.view(P(), r1.token);
  ok('with the trial on, the button starts the 14-day trial', /trial=14/.test(v.signupUrl) && v.trialDays === 14, v.signupUrl);
  ok('a wrong token shows nothing', (await T.view(P(), 'not-a-real-token-at-all')) === null);
  ok('views are counted', (await P().query(`SELECT views FROM nil_tries WHERE token = $1`, [r1.token])).rows[0].views === 1);

  OUT.push('-- after signup --');
  ok('the signup links the request to the new account', await T.link(P(), r1.token, 'user-k'));
  const created = [];
  const fakeCreate = async (user, body) => { created.push({ user: user.id, body }); return { ok: true, created: true, athlete: { id: 'ath-k1', name: body.name } }; };
  const a = await T.claimFor(P(), { id: 'user-k', email: 'kelly@agencyone.test' }, { createAthlete: fakeCreate });
  ok('their athlete goes on the roster, as typed', a && a.id === 'ath-k1' && created[0].body.name === 'Jalen Smith' && created[0].body.school === 'Samford University'
    && created[0].body.sport === 'Football' && created[0].body.schoolTier === 'mid-mid', created[0]);
  ok('only once', (await T.claimFor(P(), { id: 'user-k', email: 'kelly@agencyone.test' }, { createAthlete: fakeCreate })) === null && created.length === 1);
  const refused = await T.request(P(), { ...GOOD, email: 'e@five.test', athlete: 'Hs Kid', level: 'hs' }, { ip: '3.3.3.3' });
  await T.link(P(), refused.token, 'user-e');
  const failing = async () => ({ ok: false, status: 402, error: 'plan full' });
  ok('a refused add is not marked done, so it can try again', (await T.claimFor(P(), { id: 'user-e', email: 'e@five.test' }, { createAthlete: failing })) === null
    && (await P().query(`SELECT claimed_at FROM nil_tries WHERE token = $1`, [refused.token])).rows[0].claimed_at === null);

  OUT.push('-- the cold emails point here --');
  const agentP = { id: 'sp-x', lane: 'agency', org: 'Agency Two', person: 'Pat Lee', email: 'pat@agencytwo.test' };
  const schoolP = { id: 'sp-y', lane: 'school', org: 'State U Athletics', person: 'Sam Dir', email: 'sam@stateu.test' };
  const ctxA = SA.ctxFor(agentP), ctxS = SA.ctxFor(schoolP);
  ok('with NIL_TRY_ON an agent email links to /pitches; a school keeps the call', ctxA.link === 'https://mynildash.com/pitches' && ctxA.pitches === true && !ctxS.pitches && /\/try$/.test(ctxS.link), [ctxA.link, ctxS.link]);
  const mailA = W.templateEmail(agentP, ctxA);
  ok('the agent email offers it free on one of their athletes, with no call', /one of your athletes/.test(mailA.body) && /free, no call/.test(mailA.body) && !/15 minutes/.test(mailA.body), mailA.body);
  ok('and passes every check', W.checkEmail(mailA, agentP, ctxA, 1).length === 0, W.checkEmail(mailA, agentP, ctxA, 1));
  ok('the school email still passes with its 15 minutes', W.checkEmail(W.templateEmail(schoolP, ctxS), schoolP, ctxS, 1).length === 0);
  const fu2 = W.followUp(agentP, 2, SA.followCtx(agentP)), fu3 = W.followUp(agentP, 3, SA.followCtx(agentP));
  ok('the follow-ups point at /pitches too and pass', fu2.body.includes('/pitches') && fu3.body.includes('/pitches')
    && W.checkEmail({ subject: 'x', body: fu2.body }, agentP, SA.followCtx(agentP), 2).length === 0, fu2.body);
  delete process.env.NIL_TRY_ON;
  ok('off again: the agent email asks for 15 minutes like before', !SA.ctxFor(agentP).pitches && /\/try$/.test(SA.ctxFor(agentP).link));

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  for (const r of ["app.get('/pitches'", "app.get('/pitches/:token'", "app.post('/api/nil-try', _nilTryLimiter", "app.get('/api/nil-try/:token'"]) ok('route ' + r, IX.includes(r));
  ok('the admin routes check admin', /app\.get\('\/api\/admin\/nil-tries', _coldAdmin/.test(IX) && /app\.post\('\/api\/admin\/nil-tries\/tick', _coldAdmin/.test(IX));
  ok('the signup links the token', /tryToken/.test(IX) && /nilTry'\)\.link\(store\.pool, tryToken, id\)/.test(IX));
  ok('the roster adds it only with access', /!athletes\.length && user\.role === 'agent' && agentHasAccess\(user\)/.test(IX));
  ok('the clock starts with the server', IX.includes("require('./services/nilTry').start(store.pool)"));
  const HTML = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the signup form sends the token and fills in the email', /get\('try'\)/.test(HTML) && /qs\.get\('email'\)/.test(HTML));
  const PAGE = fs.readFileSync(REPO + 'server/views/nil-try.html', 'utf8');
  ok('the page escapes what it shows and has the hidden field', /const esc = /.test(PAGE) && /name="website"/.test(PAGE));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
