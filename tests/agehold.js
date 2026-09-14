'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/agehold.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── "I TICKED 18 OR OVER THREE TIMES AND IT COMES BACK BLOCKED" ──────────────
//
// Two athletes were blocked with "no age on file" after the agent had ticked
// the box on each of them. The checkbox, the PUT, the merge, the jsonb write
// and Home's read were each run here with the exact payload the form sends,
// and every one of them holds the value. What does NOT follow the value:
//
//   1. A COMPLIANCE HOLD FILED WHILE THE AGE WAS UNKNOWN. The gate stops at
//      any open hold before it re-reads the athlete, so a draft held on "we do
//      not hold a date of birth" stayed held after the birthday question was
//      answered -- every tick, forever. Now a hold whose recorded age fact was
//      "not known" is auto-cleared the moment the age is known, and the gate
//      runs again on the current record.
//   2. A FAILED SAVE THAT SAID "UPDATED". updateAthlete swapped whatever came
//      back into the roster and toasted success on a 403 or a 500. Now a
//      failure stays on the form in words and changes nothing.
//   3. TWO ROWS, ONE NAME. Home blocks on the row holding the cards; the agent
//      edits the row the roster shows first. Home now says there are two, and
//      its "Fix it" opens the edit form for the blocked row by id instead of
//      linking to /?view=athletes, which no router reads.
//   4. scripts/why-blocked.js prints, for a name, every row and every reader's
//      verdict, so the next report of this comes with the data.

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const C = require(REPO + 'server/services/compliance.js');
const Closer = require(REPO + 'server/services/closer.js');
const Home = require(REPO + 'server/services/homeQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'ah-agent';
const P = () => store.pool;
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const WHEN = new Date('2026-08-25T15:00:00Z');   // Tuesday 10am Central: the window is open
const release = (opts = {}) => Closer.releaseDue(P(), Object.assign({ sleep: async () => {}, now: WHEN }, opts));
function recorder() {
  const sent = [];
  return { sent, fn: async (log) => { sent.push(log.brand_name); return { providerMessageId: 'm' + sent.length }; } };
}
async function draft(id, brand, athleteId) {
  await P().query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,
       status,sent_to_email,touch_no,scheduled_send_at)
     VALUES ($1,$2,$3,$4,$5,'Hi','<p>x</p>','approved','x@ah.example',1,$6)`,
    [id, AG, athleteId, brand, brand.toLowerCase(), new Date(WHEN.getTime() - 60000)]);
}
async function places(brand, types) {
  await P().query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
     VALUES ($1,'places',$2,$3::jsonb,'OK',NOW())
     ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, refreshed_at = NOW()`,
    ['ah:' + brand.toLowerCase(), brand, JSON.stringify({ found: true, types, name: brand })]);
}
const holds = async (logId) => (await P().query(
  `SELECT id, rule_key, severity, resolved_at, resolution, resolved_by, facts FROM compliance_holds
    WHERE outreach_log_id = $1 ORDER BY id`, [logId])).rows;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const G = require(REPO + 'server/services/sendGuard.js');
  await G.ensureTable(P());
  const clean = async () => {
    await P().query(`DELETE FROM compliance_holds WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P().query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'ah:%'`).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role,report_tz)
                   VALUES ($1,'Age Agent','ah@x.com','x','agent','America/Chicago')`, [AG]);
  // Exactly what POST /api/athletes stores for a freshman with the box left
  // unticked: no dob, no over18 answer at all.
  await store.saveAthlete('ah-a1', { id: 'ah-a1', agentId: AG, name: 'Noah Carpenter', sport: 'football',
    school: 'Auburn University', year: 'Freshman', dob: '' });
  await places('Kessler Liquor', ['liquor_store']);
  await places('Amsterdam Cafe', ['cafe']);
  await draft('ah-1', 'Kessler Liquor', 'ah-a1');
  await draft('ah-2', 'Amsterdam Cafe', 'ah-a1');

  // ── 1. THE HOLD FILED ON AN UNKNOWN AGE ──────────────────────────────────
  OUT.push('-- a hold filed on an unknown age does not outlive the answer --');
  const r1 = recorder();
  await release({ send: r1.fn });
  ok('with no age on file, the liquor pitch is held', r1.sent.indexOf('Kessler Liquor') === -1, r1.sent);
  ok('  and the cafe pitch sends (an unknown age is only a note on a clean business)', r1.sent.indexOf('Amsterdam Cafe') !== -1, r1.sent);
  let h = await holds('ah-1');
  const first = h.find((x) => x.rule_key === 'category-alcohol');
  ok('  the hold records that the age was NOT known', first && first.facts.age && first.facts.age.known === false, first && first.facts.age);

  // The agent ticks the box. This is what PUT /api/athletes/:id does with the
  // form's payload: validate, merge over the existing row, write.
  const existing = await store.getAthlete('ah-a1');
  await store.saveAthlete('ah-a1', { ...existing, over18: true });
  const stored = (await P().query(`SELECT data->>'over18' AS o FROM athletes WHERE id='ah-a1'`)).rows[0].o;
  ok('the checkbox is stored, as text "true" for every jsonb reader', stored === 'true', stored);

  const r2 = recorder();
  await release({ send: r2.fn });
  h = await holds('ah-1');
  const cleared = h.find((x) => x.id === first.id);
  ok('THE OLD HOLD IS RESOLVED AS AUTO-CLEARED on the next tick', cleared && cleared.resolved_at && cleared.resolution === 'auto-cleared', cleared);
  ok('  by the system, with the reason on the record', cleared && cleared.resolved_by === 'system', cleared && cleared.resolved_by);
  const refiled = h.find((x) => x.id !== first.id && x.rule_key === 'category-alcohol' && !x.resolved_at);
  ok('  and alcohol is RE-FILED as a hold for an attested adult -- the category still holds', !!refiled, h.map((x) => [x.rule_key, x.resolution]));
  ok('  with the true age fact this time', refiled && refiled.facts.age.known === true && refiled.facts.age.source === 'attested', refiled && refiled.facts.age);
  ok('  the liquor pitch still did not send', r2.sent.indexOf('Kessler Liquor') === -1, r2.sent);
  ok('  and the reason on the new hold no longer says we hold no date of birth',
    refiled && !/do not hold a date of birth/.test((await P().query(`SELECT reason FROM compliance_holds WHERE id=$1`, [refiled.id])).rows[0].reason));

  // A third tick changes nothing more: the re-filed hold was made on a known age.
  const r3 = recorder();
  await release({ send: r3.fn });
  const h3 = await holds('ah-1');
  ok('a further tick does not churn: one open hold, filed on a known age', h3.filter((x) => !x.resolved_at).length === 1, h3.map((x) => [x.id, x.resolution]));

  // A hold the agent already decided is not touched by the checkbox.
  await draft('ah-3', 'Kessler Liquor', 'ah-a1');
  const r4 = recorder();
  await release({ send: r4.fn });
  const h4 = (await holds('ah-3')).find((x) => x.rule_key === 'category-alcohol');
  const ov = await C.overrideHold(P(), h4.id, { agentId: AG, reason: 'the athlete is a brand ambassador for this store already' });
  ok('an agent can override the attested-adult hold', ov.ok === true, ov);
  const r5 = recorder();
  await release({ send: r5.fn });
  ok('  and the override sends', r5.sent.indexOf('Kessler Liquor') !== -1, r5.sent);
  const after = (await holds('ah-3')).find((x) => x.id === h4.id);
  ok('  the overridden hold keeps ITS resolution; auto-clear never rewrites a decision', after.resolution === 'overridden', after.resolution);

  // The clearer itself: only age-unknown, only open.
  const ids = await C.autoClearAgeHolds(P(), 'ah-1');
  ok('autoClearAgeHolds returns nothing when nothing qualifies', Array.isArray(ids) && ids.length === 0, ids);
  ok('  and a missing argument is a no-op, not a throw', (await C.autoClearAgeHolds(P(), null)).length === 0);

  // ── 2. TWO ROWS, ONE NAME, ON HOME ───────────────────────────────────────
  OUT.push('', '-- Home names the duplicate and opens the blocked row --');
  await store.saveAthlete('ah-a2', { id: 'ah-a2', agentId: AG, name: 'Noah Carpenter', sport: 'football', school: 'Auburn University', dob: '' });
  const home = await Home.buildHome(P(), AG, { athleteId: 'ah-a2' });
  ok('the copy with no age is blocked', !!home.blocker, home.blocker);
  ok('  the blocker carries THE ROW IT IS ABOUT', home.blocker && home.blocker.athleteId === 'ah-a2', home.blocker && home.blocker.athleteId);
  ok('  and says two athletes share the name', home.blocker && /2 athletes named Noah Carpenter/.test(home.blocker.text), home.blocker && home.blocker.text);
  const home1 = await Home.buildHome(P(), AG, { athleteId: 'ah-a1' });
  ok('the copy with the box ticked is NOT blocked', !home1.blocker, home1.blocker);
  await store.saveAthlete('ah-a2', { ...(await store.getAthlete('ah-a2')), name: 'Kaden House' });
  const home2 = await Home.buildHome(P(), AG, { athleteId: 'ah-a2' });
  ok('a unique name gets no duplicate note', home2.blocker && !/athletes named/.test(home2.blocker.text), home2.blocker && home2.blocker.text);

  // ── 3. THE SOURCE ────────────────────────────────────────────────────────
  OUT.push('', '-- the form, the page, the gate, the script --');
  const html = src('public/index.html');
  ok('updateAthlete refuses to call a non-OK response a save', /if \(!r\.ok \|\| !updated \|\| !updated\.id\) \{/.test(html));
  ok('  and says so on the form', /Could not save: ' \+ why \+ '\. Nothing was changed\./.test(html));
  ok('  and never swaps an error body into the roster',
    html.indexOf("if (!r.ok || !updated || !updated.id) {") < html.indexOf("athletes = athletes.map(a => a.id === id ? updated : a);"));
  ok('Home\'s Fix it opens the edit form for the blocked row by id', /hqFixAthlete\('" \+ hqEscape\(String\(d\.blocker\.athleteId\)\)/.test(html) && /async function hqFixAthlete\(id\)/.test(html));
  ok('  and no longer links to a view that does not exist', !/href="' \+ hqEscape\(d\.blocker\.href/.test(html));
  const cl = src('server/services/closer.js');
  ok('the gate clears age-unknown holds BEFORE it stops at open holds',
    cl.indexOf('await compliance.autoClearAgeHolds(pool, log.id)') < cl.indexOf('const open = await compliance.openHoldsFor(pool, log.id);'));
  ok('  and only when the age is known now', /if \(ageNow\.known\) await compliance\.autoClearAgeHolds/.test(cl));
  const co = src('server/services/compliance.js');
  ok('the clearer touches only open, age-unknown holds', /resolved_at IS NULL\s*AND facts->'age'->>'known' = 'false'/.test(co) && /resolution = 'auto-cleared'/.test(co));
  const sc = src('scripts/why-blocked.js');
  ok('why-blocked lists EVERY row with the name', /LOWER\(TRIM\(a\.data->>'name'\)\) = LOWER\(TRIM\(\$1\)\)/.test(sc) && /ROWS SHARE THIS NAME/.test(sc));
  ok('  applies the same age test Home does', /row\.over18 === 'true' \|\| row\.over18 === 'false'/.test(sc));
  ok('  shows holds with the age fact they were filed on', /facts->'age'->>'known' AS age_known/.test(sc));
  ok('  finds user rows that differ only by email case', /LOWER\(TRIM\(email\)\) = LOWER\(TRIM\(\$1\)\) AND id <> \$2/.test(sc));
  ok('  connects through server/store, never a bare pool, and starts with exit code 1',
    /require\('\.\.\/server\/store'\)/.test(sc) && !/new Pool\(/.test(sc) && /process\.exitCode = 1/.test(sc));
  ok('  counts queued cards on the column the queue actually uses', /q\.state = 'queued'/.test(sc) && !/q\.status/.test(sc));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
