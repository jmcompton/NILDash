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
// Two claims under test.
//   1. DOB already goes in at creation and at edit, and a blank still holds.
//   2. MOVING is gone from every surface that renders it.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Home = require(ROOT + 'server/services/homeQueue.js');
const SR = require(ROOT + 'server/services/shiftReport.js');
const SE = require(ROOT + 'server/services/shiftEmail.js');
const compliance = require(ROOT + 'server/services/compliance.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

// _validDob is not exported; lift it from index.js so the test runs the real one.
function liftFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('could not lift ' + name);
}
const _validDob = eval('(' + liftFn(fs.readFileSync(ROOT + 'server/index.js', 'utf8'), '_validDob') + ')');

const AG = 'dob-agent', A1 = 'dob-with', A2 = 'dob-without';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  console.log('\n1. _validDob — the rule a blank must obey');
  check('blank stays blank',            _validDob('') === '');
  check('undefined stays blank',        _validDob(undefined) === '');
  check('null stays blank',             _validDob(null) === '');
  check('junk stays blank',             _validDob('not a date') === '');
  check('a future date is refused',     _validDob('2099-01-01') === '');
  check('a 150-year-old date refused',  _validDob('1875-01-01') === '');
  check('a real date is kept verbatim', _validDob('2005-04-11') === '2005-04-11');
  check('a blank NEVER becomes a date', ['', null, undefined, 'x', '2099-01-01'].every((v) => _validDob(v) === ''));

  console.log('\n2. A blank holds restricted categories; it never reads as an adult');
  const restricted = { brandName: 'Cahaba Brewing', evidence: { categories: ['alcohol'] } };
  const noDob   = compliance.ageFrom('', new Date());
  const badDob  = compliance.ageFrom('garbage', new Date());
  const realDob = compliance.ageFrom('2005-04-11', new Date());
  check('no dob is "not known", not "adult"', noDob.known === false, JSON.stringify(noDob));
  check('an unparseable dob is also not known', badDob.known === false);
  check('a real dob resolves an age', realDob.known === true && realDob.years >= 20 && realDob.minor === false, JSON.stringify(realDob));

  console.log('\n3. The value survives a save and clears the Home blocker');
  for (const t of ['outreach_logs', 'outreach_queue', 'brand_match_scores', 'athletes'])
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'J','dob@x.com','x','agent')`, [AG]);

  // Exactly what the route builds: dob passes through _validDob and nothing else.
  const mk = async (id, name, rawDob) => {
    await store.saveAthlete(id, {
      id, agentId: AG, name, sport: 'basketball', school: 'Maryland',
      dob: _validDob(rawDob),
    });
  };
  await mk(A1, 'Kaden House', '2005-04-11');   // typed into the form
  await mk(A2, 'Amber Bretton', '');           // left blank, as allowed

  const readBack = (await P.query(`SELECT data->>'dob' AS dob FROM athletes WHERE id=$1`, [A1])).rows[0].dob;
  check('the date typed in the form is what lands in the row', readBack === '2005-04-11', readBack);
  const blankBack = (await P.query(`SELECT data->>'dob' AS dob FROM athletes WHERE id=$1`, [A2])).rows[0].dob;
  check('a blank lands as blank, not as a guess', !blankBack, JSON.stringify(blankBack));

  // The edit path is the same form and the same validator: PUT patches dob.
  await store.saveAthlete(A2, { id: A2, agentId: AG, name: 'Amber Bretton', sport: 'basketball',
    school: 'UConn', dob: _validDob('2004-02-29') });
  const edited = (await P.query(`SELECT data->>'dob' AS dob FROM athletes WHERE id=$1`, [A2])).rows[0].dob;
  check('editing an existing athlete fills the date in', edited === '2004-02-29', edited);

  await store.saveAthlete(A2, { id: A2, agentId: AG, name: 'Amber Bretton', sport: 'basketball',
    school: 'UConn', dob: _validDob('') });

  const withDob = await Home.buildHome(P, AG, { athleteId: A1 });
  const without = await Home.buildHome(P, AG, { athleteId: A2 });
  check('an athlete with a date is not blocked', !withDob.blocker, JSON.stringify(withDob.blocker));
  check('an athlete without one still is', !!without.blocker, without.blocker && without.blocker.text);
  check('the block is ONE line, not a panel',
    without.blocker && typeof without.blocker.text === 'string'
      && !/\n/.test(without.blocker.text) && without.blocker.text.length < 120,
    without.blocker && without.blocker.text);

  console.log('\n4. MOVING is off everywhere');
  check('the flag is off by default', SR.MOVING_ENABLED === false);
  const mv = await SR.buildMoving(P, AG, async (l, s, p) => (await P.query(s, p)).rows);
  check('buildMoving returns nothing to render', mv === null, JSON.stringify(mv));

  // A report carrying figures must still render no MOVING, because the block is
  // driven off report.moving and that is now null.
  const rep = { run: { ran: true }, sentence: 'Your team worked last night.',
    needsYou: { items: [], overflow: 0 }, moving: null, closer: null, roles: [] };
  const r1 = SE.renderShiftEmail(rep, { agentName: 'Jordan' });
  check('no MOVING block in the HTML', !/MOVING/.test(r1.html));
  check('no MOVING line in the plain text', !/MOVING/.test(r1.text));
  check('no dollar figures anywhere in the email', !/\$\d/.test(r1.html + r1.text),
    (r1.html + r1.text).match(/\$\d[\d.,KM]*/g) || '(none)');

  // And the belt-and-braces case: if something upstream ever hands the renderer
  // figures again, that is a deliberate act, not an accident of this change.
  const r2 = SE.renderShiftEmail({ ...rep, moving: { earned: 4000, inFlight: 5500, inFlightCount: 3 } },
    { agentName: 'Jordan' });
  check('the renderer still honours an explicit moving object (flag is the gate, not a deletion)',
    /MOVING/.test(r2.html));

  const dead = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  check('the dates-of-birth panel is gone from the page',
    !/sr-dobgap|srRenderDobGap|srSaveDobs|sr-dob-/.test(dead));
  // ── AND NOW THE FIELD ITSELF IS GONE ──────────────────────────────────────
  // This suite removed the shift report's "fill in these birthdays" panel and
  // kept the form field, on the reasoning that collecting a date was still worth
  // doing where an agent happened to have one. The 18-or-over checkbox is the
  // only age input now: a stored date still WINS wherever one exists, we just
  // stop asking. So the panel staying gone is still asserted above, and the
  // field joining it is asserted here.
  check('the Add Client form no longer has the date field', !/id="a_dob"/.test(dead));
  check('and neither form submits a dob key',
    (dead.match(/dob: \(document\.getElementById\('a_dob'\)/g) || []).length === 0
      && !/name, sport, school, dob,/.test(dead));
  // A stored date is KEPT, which is only true if the key is omitted rather than
  // sent empty -- the server merges {...existing, ...patch} and _validDob('')
  // is '', so sending it at all would clear the value.
  check('the omission is deliberate and says why',
    /would WIPE a date already/.test(dead));

  const bad = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - bad.length) + '/' + out.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
