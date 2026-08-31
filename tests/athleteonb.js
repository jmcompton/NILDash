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
// Athlete onboarding: profile, photo, reach — and the DATE that travels with the
// reach number all the way to the media kit and the pitch lint.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const RP = require(ROOT + 'server/services/reachProvenance.js');
const analyst = require(ROOT + 'server/services/analyst.js');
const PW = require(ROOT + 'server/services/pitchWriter.js');
const AR = require(ROOT + 'server/services/athleteRecord.js');
const { resolveSchool } = require(ROOT + 'server/services/schoolResolver.js');

let F = 0;
const ok = (n, c, g) => { if (c) console.log('  PASS ' + n); else { F++; console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
const PAGE = fs.readFileSync(ROOT + 'public/athlete-signup.html', 'utf8');
const NOW = new Date('2026-08-24T00:00:00Z');

function handlerFor(marker, endMarker) {
  const start = SRC.indexOf(marker);
  const end = SRC.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  const body = SRC.slice(SRC.indexOf('{', SRC.indexOf('async (req, res)', start)), end);
  // The handler requires services inline, exactly as the module scope does.
  const fn = new Function('store', 'require', 'req', 'res',
    'return (async (req,res)=>' + body.slice(0, body.lastIndexOf('}') + 1) + ')(req,res);');
  return (st, rq, rs) => fn(st, (m) => require(m.replace(/^\.\//, ROOT + 'server/')), rq, rs);
}
const mkRes = () => { const r = { code: 200, body: null,
  status(c) { r.code = c; return r; }, json(v) { r.body = v; return r; } }; return r; };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const A = 'ao-athlete';
  const clean = async () => {
    await P.query(`DELETE FROM athletes WHERE id=$1`, [A]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,'ao-agent',$2::jsonb)`,
    [A, JSON.stringify({ name: 'Kaden House', school: 'Maryland (incoming; Class of 2026 recruit)', sport: 'football' })]);
  const req = (body) => ({ athlete: { id: A }, body });

  // ── 1. KADEN HOUSE ───────────────────────────────────────────────────────
  console.log('\n-- 1. the parenthetical school resolves --');
  const rec = AR.resolveAthlete({ id: A, data: { name: 'Kaden House',
    school: 'Maryland (incoming; Class of 2026 recruit)' } }, { schoolLocation: resolveSchool });
  ok('"Maryland (incoming; Class of 2026 recruit)" resolves', rec.schoolCity === 'College Park', rec.schoolCity);
  ok('  to College Park, MD', rec.schoolState === 'MD', rec.schoolState);
  ok('  so he HAS a local market', rec.hasLocalMarket === true, rec.hasLocalMarket);
  ok('  with no "no market" note on him', !rec.localLaneNote, rec.localLaneNote);

  // ── 2. DATE OF BIRTH ─────────────────────────────────────────────────────
  console.log('\n-- 2. the athlete supplies their own date of birth --');
  const profileH = handlerFor("app.post('/api/athlete/onboarding/profile'", "\n// POST /api/athlete/onboarding/photo");
  ok('the profile endpoint exists', !!profileH);
  let r = mkRes();
  await profileH(store, req({ dob: '2006-04-11', position: 'Linebacker', year: 'Sophomore' }), r);
  ok('  a real date of birth saves', r.code === 200 && r.body.ok, r.body);
  const saved = (await P.query(`SELECT data FROM athletes WHERE id=$1`, [A])).rows[0].data;
  ok('  and lands on the field the compliance gate reads', saved.dob === '2006-04-11', saved.dob);

  const co = require(ROOT + 'server/services/compliance.js');
  const ageBefore = co.ageFrom(null, NOW);
  const ageAfter = co.ageFrom(saved.dob, NOW);
  ok('  before it, age was UNKNOWN', ageBefore.known === false);
  ok('  after it, the gate knows the age', ageAfter.known === true && ageAfter.years === 20, ageAfter);
  ok('  and an adult + alcohol is now a hold, not an unknown-age hold',
    co.severityFor('alcohol', ageAfter) === 'hold', co.severityFor('alcohol', ageAfter));

  for (const bad of ['1899-01-01', '2099-01-01', 'not-a-date']) {
    r = mkRes();
    await profileH(store, req({ dob: bad }), r);
    ok(`  "${bad}" is refused rather than stored`, r.code === 400, { code: r.code, body: r.body });
  }
  const stillGood = (await P.query(`SELECT data->>'dob' AS d FROM athletes WHERE id=$1`, [A])).rows[0].d;
  ok('  and a refused write does not clobber the good one', stillGood === '2006-04-11', stillGood);

  // ── 3. REACH IS STAMPED SERVER-SIDE ──────────────────────────────────────
  console.log('\n-- 3. the follower number carries its date --');
  const reachH = handlerFor("app.post('/api/athlete/onboarding/reach'", "\n// GET /api/athlete/onboarding/status");
  ok('the reach endpoint exists', !!reachH);
  r = mkRes();
  // A client trying to backdate its own number must not be able to.
  await reachH(store, req({ instagram: '12,400', tiktok: '3100',
    reachAsOf: '2020-01-01', reachSource: 'instagram' }), r);
  ok('  it saves', r.code === 200 && r.body.ok, r.body);
  const after = (await P.query(`SELECT data FROM athletes WHERE id=$1`, [A])).rows[0].data;
  ok('  the count is parsed out of "12,400"', after.instagram === 12400, after.instagram);
  ok('  THE DATE IS STAMPED SERVER-SIDE, not taken from the client',
    after.reachAsOf === new Date().toISOString().slice(0, 10), after.reachAsOf);
  ok('  and so is the source — a client cannot claim "instagram"',
    after.reachSource === 'athlete', after.reachSource);

  r = mkRes();
  await reachH(store, req({ instagram: 'twelve thousand' }), r);
  ok('  a non-numeric count is refused', r.code === 400, r.body);

  // ── 4. IT REACHES THE MEDIA KIT ──────────────────────────────────────────
  console.log('\n-- 4. the media kit says when, not "live" --');
  const athlete = { id: A, name: 'Kaden House', school: 'Maryland', sport: 'football',
    instagram: 12400, tiktok: 3100, reachSource: 'athlete', reachAsOf: '2026-08-14' };
  const kit = analyst.composeKit(athlete, { now: NOW });
  const reachFact = kit.facts.find((f) => f.key === 'reach');
  ok('the kit carries a reach fact', !!reachFact, kit.facts.map((f) => f.key));
  ok('  and it is DATED', /as of 14 Aug 2026/.test(reachFact.value), reachFact.value);
  ok('  the lead line is dated too', /as of 14 Aug 2026/.test(kit.lead || ''), kit.lead);
  ok('  and the kit says who supplied it', /entered by the athlete/.test(kit.reachProvenance.note), kit.reachProvenance.note);

  const live = analyst.composeKit({ ...athlete, reachSource: 'instagram' }, { now: NOW });
  const liveFact = live.facts.find((f) => f.key === 'reach');
  ok('WHEN INSTAGRAM CONNECT SHIPS the caveat disappears on its own',
    !/as of/.test(liveFact.value), liveFact.value);
  ok('  and the note changes to say it refreshes automatically',
    /refresh automatically/.test(live.reachProvenance.note), live.reachProvenance.note);

  // ── 5. AND THE PITCH ─────────────────────────────────────────────────────
  console.log('\n-- 5. a pitch may not state it as if it were live --');
  const bare = 'Saw your sign on Route 1. Kaden House plays linebacker at Maryland and has '
    + '12,400 followers who are mostly local. He would post about you on game day. Worth a chat?';
  const dated = bare.replace('has 12,400 followers', 'had 12,400 followers as of 14 Aug 2026');
  // verifyAthleteFacts returns { ok, problems }, not a bare array.
  const probs = (t, a) => (PW.verifyAthleteFacts(t, a, { now: NOW }) || {}).problems || [];
  ok('the fact linter is reachable', typeof PW.verifyAthleteFacts === 'function', Object.keys(PW).join(','));
  if (typeof PW.verifyAthleteFacts === 'function') {
    const p1 = probs(bare, athlete) || [];
    const p2 = probs(dated, athlete) || [];
    ok('  a bare follower count is refused',
      p1.some((x) => /as if it were live/.test(x)), p1);
    ok('  a dated one passes', !p2.some((x) => /as if it were live/.test(x)), p2);
    const p3 = probs(bare, { ...athlete, reachSource: 'instagram' }) || [];
    ok('  and a connected account lifts the rule entirely',
      !p3.some((x) => /as if it were live/.test(x)), p3);
    const p4 = probs('Great spot on Route 1. He would stop by on a Saturday.', athlete) || [];
    ok('  a pitch that cites no reach is unaffected',
      !p4.some((x) => /as if it were live/.test(x)), p4);
  }

  // ── 6. THE PAGE ──────────────────────────────────────────────────────────
  console.log('\n-- 6. the three steps, and what they say --');
  ok('the wizard has three steps', /id="ob-1"/.test(PAGE) && /id="ob-2"/.test(PAGE) && /id="ob-3"/.test(PAGE));
  ok('  step 1 asks for date of birth', /id="ob-dob"/.test(PAGE));
  ok('  step 2 takes a photo', /id="ob-photo-file"/.test(PAGE));
  ok('  step 3 takes follower counts', /id="ob-ig"/.test(PAGE));
  ok('  every step can be skipped', (PAGE.match(/Skip for now/g) || []).length === 3,
    (PAGE.match(/Skip for now/g) || []).length);
  ok('  the reach step SAYS the number will be dated', /as of <span id="ob-today">/.test(PAGE));
  // Comments stripped: obSaveReach's own comment NAMES reachAsOf to explain that
  // it deliberately does not send one, and grepping raw source fails on that.
  const reachFn = PAGE.slice(PAGE.indexOf('async function obSaveReach'), PAGE.indexOf('function obFinish'))
    .replace(/\/\/[^\n]*/g, '');
  ok('  and does not send its own date', !/reachAsOf|reachSource/.test(reachFn), reachFn.slice(0, 200));
  ok('activation goes into the steps, not to an empty dashboard',
    /obStart\(\);/.test(PAGE) && PAGE.indexOf('obStart();') < PAGE.indexOf('athlete-dashboard.html'), null);
  ok('  the styling uses the page\'s own classes', /class="ob-inp"/.test(PAGE) && /\.ob-inp\{/.test(PAGE));

  await clean();
  console.log('\nfailures: ' + F);
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
