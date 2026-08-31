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
// THE ANALYST: composes from stored fields only, refuses to invent, keeps kits
// current on its own, and never touches the athlete's photo.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const A = require(ROOT + 'server/services/analyst.js');
const shiftReport = require(ROOT + 'server/services/shiftReport.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'an-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM media_kits WHERE athlete_id LIKE 'an-%'`).catch(() => {});
    await P.query(`DELETE FROM athlete_activity_log WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','an@x.com','x','agent')`, [AG]);

  // ── EVERY NUMBER TRACES TO A STORED FIELD ────────────────────────────────
  const full = { id: 'an-a1', name: 'Marcus Hall', school: 'Auburn University',
    sport: 'Football', position: 'Linebacker', year: 'Junior',
    instagram: 24000, tiktok: 6000, engagement: '4.2%' };
  const kit = A.composeKit(full);
  ok('a full record produces a full kit', kit.facts.length === 6, kit.facts.map((f) => f.key));
  ok('  reach sums every platform', kit.reach === 30000, kit.reach);
  // DATED, NOT BARE. This record has counts and no recorded date, which is every
  // athlete on the roster until they enter their own. "30K" alone reads as
  // current on a document that gets forwarded and read weeks later; the caveat is
  // the difference between a number a reader can judge and one they must trust.
  ok('  and is shown readably, with its provenance',
    kit.facts.find((f) => f.key === 'reach').value === '30K (date and source not recorded)',
    kit.facts.find((f) => f.key === 'reach').value);
  ok('  engagement is a real rate, not a follower count', kit.engagement === 4.2, kit.engagement);
  ok('  every fact names the field it came from',
    kit.facts.every((f) => !!f.source), kit.facts);

  // THIN DATA MAKES A SHORTER KIT, NEVER A PADDED ONE.
  const thin = { id: 'an-a2', name: 'No Numbers', school: 'Auburn University' };
  const thinKit = A.composeKit(thin);
  ok('THIN DATA GIVES A SHORTER KIT', thinKit.facts.length === 1, thinKit.facts.map((f) => f.key));
  ok('  no follower count is invented', thinKit.reach === null, thinKit.reach);
  ok('  no engagement is invented', thinKit.engagement === null, thinKit.engagement);
  ok('  and there is NO placeholder row', !thinKit.facts.some((f) => /N\/A|--|unknown/i.test(String(f.value))),
    thinKit.facts);
  ok('  it is flagged thin so the agent can fix the data', thinKit.thin === true, thinKit);

  // Zero is not a number worth printing.
  const zero = A.composeKit({ id: 'an-a3', name: 'Zero', instagram: 0, engagement: '0%' });
  ok('a zero follower count is ABSENT, not shown as 0',
    !zero.facts.some((f) => f.key === 'reach'), zero.facts);
  ok('  and 0% engagement is absent too, because it is a claim',
    zero.engagement === null, zero.engagement);

  // ── THE HONESTY LINT ENFORCES IT ─────────────────────────────────────────
  ok('a clean kit passes the lint', A.lintKit(kit, full).ok === true, A.lintKit(kit, full));
  const forged = JSON.parse(JSON.stringify(kit));
  const badLint = A.lintKit(forged, { id: 'x', name: 'x' });   // no stored numbers
  ok('A KIT SHOWING REACH WITH NOTHING STORED IS REJECTED', badLint.ok === false, badLint);
  ok('  naming the problem', /no follower count is stored/.test(badLint.problems.join('; ')), badLint.problems);

  const priced = { facts: [{ key: 'x', label: 'Package', value: '$500 per post', source: 'made up' }],
    location: { show: false } };
  const priceLint = A.lintKit(priced, full);
  ok('A KIT THAT NAMES A PRICE IS REJECTED', priceLint.ok === false, priceLint);
  ok('  because pricing is the agent\'s negotiation',
    /negotiation/.test(priceLint.problems.join('; ')), priceLint.problems);

  // ── LOCATION IS OMITTED, AND IT SAYS WHY ─────────────────────────────────
  const loc = A.decideLocation(full, null, {});
  ok('LOCATION IS OMITTED because we hold no audience data', loc.show === false, loc);
  ok('  and it refuses to infer it from the school',
    /inventing a statistic/.test(loc.reason), loc.reason);
  ok('  so no local figure reaches the kit',
    !kit.facts.some((f) => f.key === 'local'), kit.facts.map((f) => f.key));

  // A social or national reader does not care where the audience lives.
  const social = A.decideLocation(full, null, { reader: 'social' });
  ok('for a social brand, location is not the point', social.show === false, social);
  ok('  and the reason says so', /not the point/.test(social.reason), social.reason);

  // THE SHAPE IS READY for real data, and the branches behave.
  const nearby = { total: 20000, nearby: { count: 12000, radiusMiles: 30 } };
  const withData = A.decideLocation(full, nearby, { reader: 'local' });
  ok('WITH REAL DATA, a genuinely local audience leads', withData.show === true, withData);
  ok('  worded the way the brief asked',
    withData.lead === '12K followers within 30 miles', withData.lead);
  const scattered = { total: 20000, nearby: { count: 900, radiusMiles: 30 } };
  const spread = A.decideLocation(full, scattered, { reader: 'local' });
  ok('  a SCATTERED audience leaves location out', spread.show === false, spread);
  ok('  and says the share, not a guess', /only 5% of the audience/.test(spread.reason), spread.reason);

  // ── STALENESS: WHAT MAKES A KIT WRONG ────────────────────────────────────
  ok('no kit at all is stale, and it is the first build',
    A.stalenessOf(null, full).first === true, A.stalenessOf(null, full));

  const current = { instagram_followers: 24000, tiktok_followers: 6000,
    instagram_engagement: '4.2%', updated_at: new Date(),
    year_at_build: 'Junior', position_at_build: 'Linebacker',
    school_at_build: 'Auburn University', photoHash: 'abc', photo_hash_at_build: 'abc' };
  ok('an accurate kit is NOT rebuilt', A.stalenessOf(current, full).stale === false,
    A.stalenessOf(current, full).reasons);

  const grown = { ...full, instagram: 31000 };
  const g = A.stalenessOf(current, grown);
  ok('a real follower change makes it stale', g.stale === true, g.reasons);
  ok('  and the reason names both numbers', /24K to 31K/.test(g.reasons.join(';')), g.reasons);

  const noise = { ...full, instagram: 24050 };
  ok('NOISE DOES NOT TRIGGER A REBUILD', A.stalenessOf(current, noise).stale === false,
    A.stalenessOf(current, noise).reasons);

  const promoted = { ...full, year: 'Senior' };
  ok('a new season makes it stale', A.stalenessOf(current, promoted).stale === true);
  ok('  saying which field moved',
    /year changed to Senior/.test(A.stalenessOf(current, promoted).reasons.join(';')),
    A.stalenessOf(current, promoted).reasons);

  const newPhoto = { ...current, photoHash: 'zzz' };
  ok('A NEW PHOTO ALWAYS REBUILDS', A.stalenessOf(newPhoto, full).stale === true,
    A.stalenessOf(newPhoto, full).reasons);
  ok('  and says so', /new photo/.test(A.stalenessOf(newPhoto, full).reasons.join(';')),
    A.stalenessOf(newPhoto, full).reasons);

  const old = { ...current, updated_at: new Date(Date.now() - 120 * 86400000) };
  ok('a kit that has sat a season is stale on age alone',
    A.stalenessOf(old, full).stale === true, A.stalenessOf(old, full).reasons);

  // ── THE NIGHTLY PASS, FOR REAL ───────────────────────────────────────────
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    ['an-a1', AG, JSON.stringify({ name: 'Marcus Hall', school: 'Auburn University',
      sport: 'Football', position: 'Linebacker', year: 'Junior',
      instagram: 24000, tiktok: 6000, engagement: '4.2%' })]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    ['an-a2', AG, JSON.stringify({ name: 'No Numbers', school: 'Auburn University' })]);

  const first = await A.refreshAll(P, AG);
  ok('THE PASS BUILDS A KIT FOR AN ATHLETE WHO HAS NONE', first.built === 2, first);
  ok('  and says why for each', first.details.every((d) => !!d.why), first.details);
  const kits = (await P.query(
    `SELECT athlete_id, slug, instagram_followers, built_by FROM media_kits
      WHERE athlete_id LIKE 'an-%' ORDER BY athlete_id`)).rows;
  ok('  the kits are in the table', kits.length === 2, kits.length);
  ok('  one per athlete', new Set(kits.map((k) => k.athlete_id)).size === 2);
  ok('  each with a shareable slug', kits.every((k) => !!k.slug), kits);
  ok('  marked as the Analyst\'s work', kits.every((k) => k.built_by === 'analyst'), kits);
  ok('  the thin athlete still got one, just shorter',
    kits.find((k) => k.athlete_id === 'an-a2').instagram_followers === null,
    kits.find((k) => k.athlete_id === 'an-a2'));
  ok('  and the thin one is reported, not padded', first.thin.length === 1, first.thin);

  // NOTHING CHANGED: the second pass does nothing at all.
  const second = await A.refreshAll(P, AG);
  ok('A SECOND PASS WITH NOTHING CHANGED REBUILDS NOTHING',
    second.refreshed === 0 && second.built === 0, second);
  ok('  and reports them as unchanged', second.skipped === 2, second);

  // Change one number; only that athlete is rebuilt.
  await P.query(`UPDATE athletes SET data = jsonb_set(data,'{instagram}','31000') WHERE id='an-a1'`);
  const third = await A.refreshAll(P, AG);
  ok('a changed follower count rebuilds ONLY that athlete',
    third.refreshed === 1 && third.skipped === 1, third);
  ok('  with the reason recorded', /24K to 31K/.test(third.details[0].why), third.details[0]);

  // ── THE PHOTO IS THE ATHLETE'S AND IS NEVER OVERWRITTEN ──────────────────
  await P.query(`UPDATE media_kits SET headshot_url = 'data:image/png;base64,AAAA'
                  WHERE athlete_id = 'an-a1'`);
  await P.query(`UPDATE athletes SET data = jsonb_set(data,'{instagram}','44000') WHERE id='an-a1'`);
  const fourth = await A.refreshAll(P, AG);
  const after = (await P.query(
    `SELECT headshot_url, photo_hash_at_build FROM media_kits WHERE athlete_id='an-a1'`)).rows[0];
  ok('A REFRESH NEVER WIPES THE ATHLETE\'S PHOTO',
    after.headshot_url === 'data:image/png;base64,AAAA', after.headshot_url);
  ok('  and it records the hash so the next change is noticed',
    !!after.photo_hash_at_build, after.photo_hash_at_build);
  void fourth;

  // ── IT REPORTS WHAT IT REFRESHED ─────────────────────────────────────────
  const logged = (await P.query(
    `SELECT activity_type, metadata FROM athlete_activity_log
      WHERE agent_id=$1 AND activity_type='media_kit_built'`, [AG])).rows;
  ok('THE ROW THE SHIFT REPORT COUNTS IS FINALLY WRITTEN', logged.length > 0, logged.length);
  ok('  carrying the reasons', logged.every((l) => Array.isArray(l.metadata.reasons)), logged[0]);
  ok('  marked automatic, not a manual build', logged.every((l) => l.metadata.auto === true), logged[0]);

  const block = await shiftReport.buildAnalystBlock(P, AG,
    new Date(Date.now() - 86400000), new Date(Date.now() + 86400000));
  ok('the shift report can say what it refreshed', block.refreshed.length > 0, block.refreshed.length);
  ok('  by name', block.refreshed.every((r) => !!r.name), block.refreshed[0]);
  ok('  with the reason in words', block.refreshed.some((r) => !!r.why), block.refreshed[0]);
  ok('  and a line for the page', /media kit/.test(block.line || ''), block.line);
  ok('  naming the thin kits rather than padding them',
    block.thin.length === 1 && /no follower count/.test(block.thinLine || ''), block);

  // ── THE PUBLIC KIT NAMES NO PRICE ────────────────────────────────────────
  const MK = fs.readFileSync(ROOT + 'public/media-kit.html', 'utf8');
  ok('THE PUBLIC KIT RENDERS NO RATE CARD',
    !/mk-rate-price">'\s*\+\s*fmtCurrency/.test(MK), null);
  ok('  the rates section is hidden outright',
    /ratesSection\) ratesSection\.style\.display = 'none'/.test(MK), null);
  ok('  and it says why pricing is not the kit\'s job',
    /agent's negotiation/.test(MK), null);
  ok('  the rate ROWS are not deleted, so the agent loses no work',
    /rows are untouched|survives in the table/.test(MK), null);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
