'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/schoolaudit.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── A SCHOOL RESOLVES THE SAME WAY EVERYWHERE, AND THE ONES THAT DO NOT ARE
//    LISTED WITH A CORRECTION ──────────────────────────────────────────────
//
// The resolver already ignored case and fixed one-letter typos, but three
// callers still used the bare map (the compliance gate's state code, the
// state-rules route, two scripts) and "UNIVERSITY OF PITTSBURGH" got no state
// there. Now the bare map folds case and spacing too, those callers go
// through the resolver, the Add Client form warns at the keyboard, and
// scripts/audit-schools.js lists every athlete whose stored school is not an
// exact hit, with the correction the resolver would make.

const store = require(REPO + 'server/store.js');
const ai = require(REPO + 'server/ai.js');
const Audit = require(REPO + 'scripts/audit-schools.js');
const { resolveSchool } = require(REPO + 'server/services/schoolResolver.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'sa-agent';
const IDS = ['sa-pitt', 'sa-vt', 'sa-asu', 'sa-typo', 'sa-none', 'sa-ok', 'sa-pro'];

async function main() {
  // ── 1. THE BARE MAP: CASE AND SPACING ────────────────────────────────────
  OUT.push('-- the exact lookup --');
  const pitt = ai.lookupSchoolLocation('University of Pittsburgh');
  ok('the map holds Pittsburgh', !!(pitt && pitt.city === 'Pittsburgh'), pitt);
  ok('ALL CAPS is the same key', JSON.stringify(ai.lookupSchoolLocation('UNIVERSITY OF PITTSBURGH')) === JSON.stringify(pitt));
  ok('extra spaces are the same key', JSON.stringify(ai.lookupSchoolLocation('  university   of  pittsburgh ')) === JSON.stringify(pitt));
  ok('a typo is NOT fixed at this layer (that is the resolver\'s job)', ai.lookupSchoolLocation('Univrsity of Delawear') === null);
  ok('empty is null', ai.lookupSchoolLocation('') === null && ai.lookupSchoolLocation(null) === null);

  // ── 2. THE RESOLVER: TYPOS, AND NEVER A GUESS BETWEEN TWO ────────────────
  OUT.push('', '-- the resolver --');
  const vt = resolveSchool('Virgina Tech');
  ok('"Virgina Tech" resolves to Virginia Tech', !!(vt && /Virginia Tech/.test(vt.matched) && vt.city === 'Blacksburg'), vt);
  const asu = resolveSchool('Arizona State Univeristy');
  ok('"Arizona State Univeristy" resolves to Arizona State', !!(asu && /Arizona State/.test(asu.matched) && asu.city === 'Tempe'), asu);
  ok('  by case/spacing/suffix or alias, not by a coin toss', !!(asu && ['normalized', 'alias', 'exact', 'fuzzy'].includes(asu.method) && asu.confidence >= 0.86));
  ok('"msu" is ambiguous on purpose and resolves to nothing', resolveSchool('msu') === null);
  ok('a bare generic word resolves to nothing', resolveSchool('State') === null);

  // ── 3. EVERY CALLER GOES THROUGH THE RESOLVER ────────────────────────────
  OUT.push('', '-- the callers --');
  const comp = fs.readFileSync(REPO + 'server/services/compliance.js', 'utf8');
  ok('the compliance gate\'s state code uses the resolver', !/ai\.lookupSchoolLocation/.test(comp) && (comp.match(/resolveSchool\(/g) || []).length >= 2);
  const C = require(REPO + 'server/services/compliance.js');
  ok('  so an all-caps school gets its state', C.stateCodeForSchool('UNIVERSITY OF PITTSBURGH') === 'PA', C.stateCodeForSchool('UNIVERSITY OF PITTSBURGH'));
  ok('  and a typo does too', C.stateCodeForSchool('Virgina Tech') === 'VA', C.stateCodeForSchool('Virgina Tech'));
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the state-rules route uses the resolver', /const loc = require\('\.\/services\/schoolResolver'\)\.resolveSchool\(athlete\.school \|\| ''\);/.test(idx));
  ok('why-zero and the importer use the resolver', /schoolResolver'\)\.resolveSchool/.test(fs.readFileSync(REPO + 'scripts/why-zero.js', 'utf8')) && /schoolResolver'\)\.resolveSchool/.test(fs.readFileSync(REPO + 'scripts/import-roster.js', 'utf8')));

  // ── 4. THE FORM WARNS AT THE KEYBOARD ────────────────────────────────────
  OUT.push('', '-- the form --');
  const html = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the school input checks as it is typed and on blur', /id="a_school"[^>]*oninput="aSchoolTyped\(\)" onblur="aCheckSchool\(\)"/.test(html));
  ok('  with a status line and a suggestions row under it', /id="a_school_status"/.test(html) && /id="a_school_suggest"/.test(html));
  ok('  calling the same check onboarding uses', /async function aCheckSchool\(\)[\s\S]*?\/api\/onboarding\/check-school\?q=/.test(html));
  ok('  a suggestion click fills the field and re-checks', /function aPickSchool\(name\)[\s\S]*?el\.value = name;[\s\S]*?aCheckSchool\(\);/.test(html));
  ok('  and the edit form runs the check when it opens', /document\.getElementById\('a_school'\)\.value = a\.school \|\| '';\s*aCheckSchool\(\);/.test(html));
  ok('  it never blocks: no return-false on the school in addAthlete', !/a_school_status[\s\S]{0,200}return;/.test(html.slice(html.indexOf('async function addAthlete'), html.indexOf('async function addAthlete') + 4000)));

  // ── 5. THE AUDIT ─────────────────────────────────────────────────────────
  OUT.push('', '-- the audit --');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    await P().query(`DELETE FROM athletes WHERE id = ANY($1)`, [IDS]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Audit Agent','sa-agent@x.com','x','agent')`, [AG]);
  const mk = (id, name, school, extra) => P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3)`, [id, AG, { name, school, sport: 'football', ...(extra || {}) }]);
  await mk('sa-pitt', 'Cap Lock', 'UNIVERSITY OF PITTSBURGH');
  await mk('sa-vt', 'Tye Po', 'Virgina Tech');
  await mk('sa-asu', 'Sun Devil', 'Arizona State Univeristy');
  await mk('sa-typo', 'Aub Urn', 'Auburm');
  await mk('sa-none', 'No Where', 'Zzzqx Institute of Nothing');
  await mk('sa-ok', 'Fine Here', 'Auburn University');
  await mk('sa-pro', 'Pro Guy', '', { athleteType: 'pro', city: 'Denver, CO', team: 'Broncos' });

  const rows = await Audit.loadRows(P(), 'sa-agent@x.com');
  ok('the audit loads this agent\'s college athletes only', rows.length === 6 && !rows.some((r) => r.id === 'sa-pro'), rows.map((r) => r.id));
  const A = {}; for (const r of rows) A[r.id] = Audit.auditRow(r);
  ok('an exact school is ok', A['sa-ok'].verdict === 'ok' && A['sa-ok'].exact === true, A['sa-ok']);
  ok('ALL CAPS is an exact match by case (ok, not flagged)', A['sa-pitt'].verdict === 'ok', A['sa-pitt']);
  ok('"Virgina Tech" is a FIX to Virginia Tech', A['sa-vt'].verdict === 'fix' && /Virginia Tech/.test(A['sa-vt'].fix.name), A['sa-vt']);
  ok('"Arizona State Univeristy" is a FIX or ok, never none', ['fix', 'ok'].includes(A['sa-asu'].verdict), A['sa-asu']);
  ok('"Auburm" is a FIX to Auburn University', A['sa-typo'].verdict === 'fix' && /Auburn/.test(A['sa-typo'].fix.name), A['sa-typo']);
  ok('nonsense has no match and no fix', A['sa-none'].verdict === 'none' && !A['sa-none'].fix, A['sa-none']);
  ok('each line carries the agent, the athlete and the stored name', A['sa-vt'].agent === 'sa-agent@x.com' && A['sa-vt'].name === 'Tye Po' && A['sa-vt'].school === 'Virgina Tech');
  ok('describe() reads as a correction', /^FIX -> Virginia Tech/.test(Audit.describe(A['sa-vt'])), Audit.describe(A['sa-vt']));
  // Two candidates close together: never a guess.
  const amb = Audit.auditRow({ id: 'x', school: 'Miami Univ', agent_email: 'a' }, {
    resolve: () => null,
    suggest: () => [{ name: 'Miami University', score: 0.9, city: 'Oxford', state: 'OH' }, { name: 'University of Miami', score: 0.88, city: 'Coral Gables', state: 'FL' }],
  });
  ok('two close candidates are listed as ambiguous, with no fix', amb.verdict === 'ambiguous' && !amb.fix && amb.candidates.length === 2, amb);
  ok('  and described with both names', /^\? Miami University \| University of Miami/.test(Audit.describe(amb)));

  // Apply: only the approved one, only when it has a single fix, old name kept.
  const r1 = await Audit.applyFix(P(), A['sa-vt']);
  const after = (await P().query(`SELECT data FROM athletes WHERE id = 'sa-vt'`)).rows[0].data;
  ok('applying a FIX rewrites data.school', r1.ok && /Virginia Tech/.test(after.school), { r1, after });
  ok('  and keeps the old name beside it', after.schoolCorrectedFrom === 'Virgina Tech' && !!after.schoolCorrectedAt, after);
  ok('  and the other fields survive', after.name === 'Tye Po' && after.sport === 'football');
  const r2 = await Audit.applyFix(P(), A['sa-vt']);
  ok('applying again refuses: the stored school no longer matches the audit', r2.ok === false && /changed since the audit/.test(r2.why), r2);
  const untouched = (await P().query(`SELECT data->>'school' s FROM athletes WHERE id = 'sa-typo'`)).rows[0].s;
  ok('an unapproved row is untouched', untouched === 'Auburm');
  const src = fs.readFileSync(REPO + 'scripts/audit-schools.js', 'utf8');
  ok('the script is a dry run unless --commit, and --commit needs --approve', /const commit = flag\('commit'\)/.test(src) && /--commit needs --approve/.test(src) && /if \(!commit\) \{/.test(src));
  ok('  and applies only approved ids with a single fix', /if \(a\.verdict !== 'fix'\)[\s\S]*?skipped/.test(src) && /for \(const id of approve\)/.test(src));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
