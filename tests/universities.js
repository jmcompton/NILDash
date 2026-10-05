'use strict';
// Runs against the local test Postgres. No network: the athletics site, Places
// and the contact ladder are stand-ins.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/universities.js    just this one
//
// ── A UNIVERSITY FROM NOTHING TO CARDS ──────────────────────────────────────
//   create-university: the record, the campus address as its location, the
//     campus geocoded and stored; an existing one (Samford) is corrected
//   create-university-user: role university on users.university_id (what
//     /api/university/market/me reads), comped, a set-password link RETURNED,
//     nothing emailed; an agent's address is never converted
//   roster import: PrestoSports and Sidearm pages, coaches left out, teams and
//     athletes written once, kept by the Cypress seed
//   the business list: local within driving distance with a named person,
//     social brands that sign at this level, and NEVER Nike, Oregon Ducks,
//     Texas Tech, Miami Collective, On3 NIL Valuation, a cover-star ranking,
//     a national chain or a school; the cap holds and the spend is printed
//   the nightly runs a university with teams and a business list
//   status: the numbers, and what an empty university still needs
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const UA = require(REPO + 'server/services/universityAdmin.js');
const RI = require(REPO + 'server/services/universityRosterImport.js');
const CB = require(REPO + 'server/services/campusBuild.js');
const TS = require(REPO + 'server/services/teamScan.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const UID = 'univ-ut-cypress';
const CENTER = { lat: 33.8466, lng: -118.0189 };

// ── THE ATHLETICS SITE (a PrestoSports home and rosters, one Sidearm roster) ─
const HOME = `<html><body><nav>
  <a href="/sports/mbkb/index">Men's Basketball</a><a href="/sports/mbkb/2025-26/schedule">Schedule</a>
  <a href="/sports/bsb/2025-26/roster">Baseball</a>
  <a href="/sports/wvball/index">Women's Volleyball</a>
  <a href="/sports/wsoc/index">Women's Soccer</a>
  <a href="/sports/news/index">News</a><a href="https://other.example/sports/x">Elsewhere</a>
</nav></body></html>`;
const PRESTO = (rows) => `<html><body><h2>Roster</h2><table class="roster"><thead><tr><th>No.</th><th>Name</th><th>Pos.</th><th>Yr.</th><th>Ht.</th><th>Hometown/High School</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${r[0]}</td><td><a href="/x">${r[1]}</a></td><td>${r[2]}</td><td>${r[3]}</td><td>6-1</td><td>Cypress, Calif. / Pacifica HS</td></tr>`).join('')}
  </tbody></table>
  <h2>Coaching Staff</h2><table><thead><tr><th>Name</th><th>Title</th></tr></thead><tbody><tr><td>Coach Carter</td><td>Head Coach</td></tr></tbody></table></body></html>`;
const SIDEARM = `<html><body><ul>
  <li class="sidearm-roster-player"><div class="sidearm-roster-player-jersey-number">7</div><div class="sidearm-roster-player-name"><h3><a>Maya Torres</a></h3></div><div class="sidearm-roster-player-position"><span class="text-bold">OH</span></div><span class="sidearm-roster-player-academic-year">So.</span><span class="sidearm-roster-player-hometown">Anaheim, Calif.</span></li>
  <li class="sidearm-roster-player"><div class="sidearm-roster-player-jersey-number">12</div><div class="sidearm-roster-player-name"><h3><a>Lena Park</a></h3></div><div class="sidearm-roster-player-position"><span class="text-bold">S</span></div><span class="sidearm-roster-player-academic-year">Fr.</span></li>
</ul></body></html>`;
const PAGES = {
  'https://chargers.example/': HOME,
  'https://chargers.example/sports/mbkb/2025-26/roster': PRESTO([['1', 'Jalen Brooks', 'G', 'So.'], ['22', 'Smith, Marcus', 'F', 'Fr.'], ['3', 'Andre Lee', 'G', 'So.']]),
  'https://chargers.example/sports/bsb/2025-26/roster': PRESTO([['4', 'Diego Ramirez', 'P', 'Fr.'], ['9', 'Tyler Nguyen', 'C', 'So.']]),
  'https://chargers.example/sports/wvball/roster': SIDEARM,
};
const fetchStub = async (url) => (PAGES[url] ? { ok: true, status: 200, url, text: PAGES[url] } : { ok: false, status: 404, url, text: '' });

// ── PLACES AROUND CAMPUS: real-looking locals, and every kind of wrong one ─
const near = (dLat, dLng) => ({ lat: CENTER.lat + dLat, lng: CENTER.lng + dLng });
const PLACE = (name, cat, d, extra = {}) => ({ name, place_id: 'p-' + name.replace(/\W+/g, ''), category: cat, types: [cat], address: '1 Main St, Cypress, CA', rating: 4.6, user_ratings_total: 120, ...near(...d), ...extra });
const PLACES = [
  PLACE("Joe's Pizza", 'restaurant', [0.01, 0.01]), PLACE('Valley View Dental', 'dentist', [0.02, -0.01]), PLACE('Cypress Lanes', 'bowling_alley', [0.015, 0.0]),
  PLACE('Iron Works Gym', 'gym', [0.03, 0.02]),
  PLACE('Far Away Bakery', 'bakery', [0.4, 0.4]),                                  // ~57 km: not driving distance
  PLACE('Nike', 'clothing_store', [0.01, 0.0]), PLACE('Subway', 'restaurant', [0.01, 0.0]), PLACE('Starbucks', 'cafe', [0.01, 0.0]),
  PLACE('Oregon Ducks', 'store', [0.01, 0.0]), PLACE('Texas Tech', 'university', [0.01, 0.0]), PLACE('Miami Collective', 'store', [0.01, 0.0]),
  PLACE('On3 NIL Valuation', 'store', [0.01, 0.0]), PLACE('College Football 2026 Cover Star', 'store', [0.01, 0.0]),
  PLACE('Cypress College Athletics', 'university', [0.0, 0.0]), PLACE('Cypress High School', 'school', [0.01, 0.0]),
];
let placesCalls = 0;
const placesStub = { buildMarketPoolFromPlaces: async (q, o) => { placesCalls += 30; return { ok: true, candidates: PLACES, placesCalls: 30, geocoded: CENTER }; } };
const aiStub = {
  deepContactCtx: () => ({}),
  getBrandContacts: async (brand) => (brand === 'Cypress Lanes' ? { contacts: [] } : { contacts: [{ name: 'Pat Kowalski', title: 'Owner', email: 'pat@' + brand.replace(/\W+/g, '').toLowerCase() + '.example', source: 'site', confidence: 'high' }] }),
  webSearchJson: async () => ({ text: '{}' }),
};

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM university_athletes WHERE university_id = $1`, [UID]).catch(() => {});
    await P.query(`DELETE FROM university_drafts WHERE university_id = $1`, [UID]).catch(() => {});
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [UID]).catch(() => {});
    await P.query(`DELETE FROM university_contacts WHERE university_id = $1`, [UID]).catch(() => {});
    await P.query(`DELETE FROM university_market_seen WHERE market_key = 'cypress, ca' AND brand = ANY($1)`, [PLACES.map((p) => p.name)]).catch(() => {});
    await P.query(`DELETE FROM university_market_runs WHERE university_id = $1`, [UID]).catch(() => {});
    await P.query(`DELETE FROM university_social_brands WHERE university_id = $1`, [UID]).catch(() => {});
    await P.query(`DELETE FROM university_staff WHERE university_id = $1`, [UID]).catch(() => {});
    await P.query(`DELETE FROM users WHERE email IN ('xavier.ut@cypress.example', 'agent.ut@agency.example')`).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id IN ($1, 'univ-ut-empty')`, [UID]).catch(() => {});
    await P.query(`DELETE FROM social_brands WHERE brand LIKE 'UT Social %'`).catch(() => {});
  };
  await clean();
  await require(REPO + 'server/services/campusPool.js').ensureTables(P);
  await TS.ensureTables(P);

  // ── 1. THE UNIVERSITY ────────────────────────────────────────────────────
  OUT.push('-- create-university --');
  const bad = await UA.createUniversity(P, { name: 'X College', city: 'Cypress', state: 'CA' });
  ok('the campus street address is required (the local lane needs a real centre)', !bad.ok && /street address/.test(bad.error));
  const u = await UA.createUniversity(P, { id: UID, name: 'UT Cypress College', shortName: 'Cypress', street: '9200 Valley View St', city: 'Cypress', state: 'CA' },
    { geocode: async () => ({ coords: CENTER, calls: 1 }) });
  const urow = (await P.query(`SELECT * FROM universities WHERE id = $1`, [UID])).rows[0];
  ok('created, with the campus address as its location and the centre geocoded and stored', u.ok && u.created && urow.location === '9200 Valley View St, Cypress, CA'
    && Math.abs(urow.lat - CENTER.lat) < 1e-6 && Math.abs(urow.lng - CENTER.lng) < 1e-6, { u, urow });
  const u2 = await UA.createUniversity(P, { id: UID, name: 'UT Cypress College', street: '9200 Valley View Street', city: 'Cypress', state: 'CA' }, { geocode: async () => ({ coords: CENTER }) });
  ok('  running it again updates the same row (how Samford\'s city-only location gets its campus address)', u2.ok && !u2.created && u2.id === UID
    && (await P.query(`SELECT COUNT(*)::int n FROM universities WHERE id = $1`, [UID])).rows[0].n === 1);

  // ── 2. THE PERSON ────────────────────────────────────────────────────────
  OUT.push('', '-- create-university-user --');
  const x = await UA.createUniversityUser(P, { email: 'Xavier.UT@cypress.example', name: 'Xavier Brown', title: 'Athletic Director', universityId: UID });
  const xu = (await P.query(`SELECT * FROM users WHERE email = 'xavier.ut@cypress.example'`)).rows[0];
  ok('a university login on users.university_id, comped (full free access, no card)', x.ok && x.created && xu.role === 'university' && xu.university_id === UID && xu.comped === true, { x, xu });
  ok('  a set-password link is RETURNED, and nothing was emailed', /\/reset\?token=[a-f0-9]{20,}/.test(x.resetUrl) && x.emailed === false, x);
  const tok = x.resetUrl.split('token=')[1];
  const PR = require(REPO + 'server/services/passwordReset.js');
  const crypto = require('crypto');
  const pr = (await P.query(`SELECT * FROM password_resets WHERE token_hash = $1`, [crypto.createHash('sha256').update(tok).digest('hex')])).rows[0];
  ok('  the link is a real, unused, 7-day reset token for that address', pr && pr.email === 'xavier.ut@cypress.example' && !pr.used && new Date(pr.expires_at) > new Date(Date.now() + 6 * 86400000), pr);
  ok('  the title is kept on the staff record', (await P.query(`SELECT title FROM university_staff WHERE user_id = $1`, [xu.id])).rows[0].title === 'Athletic Director');
  const x2 = await UA.createUniversityUser(P, { email: 'xavier.ut@cypress.example', name: 'Xavier Brown', universityId: UID });
  ok('  again for the same person: a fresh link, the same account', x2.ok && !x2.created && x2.userId === xu.id && x2.resetUrl !== x.resetUrl);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('ut-agent', 'An Agent', 'agent.ut@agency.example', 'x', 'agent') ON CONFLICT DO NOTHING`);
  const ag = await UA.createUniversityUser(P, { email: 'agent.ut@agency.example', name: 'An Agent', universityId: UID });
  ok('  an existing agent\'s address is refused, never converted', !ag.ok && /already has a NILDash account/.test(ag.error) && (await P.query(`SELECT role FROM users WHERE id = 'ut-agent'`)).rows[0].role === 'agent');
  const campusSrc = fs.readFileSync(REPO + 'server/routes/campus.js', 'utf8');
  ok('  and it is what the portal reads: market/me resolves the university off users.university_id', /SELECT id, name, email, role, university_id FROM users WHERE id = \$1/.test(campusSrc));
  const uaSrc = fs.readFileSync(REPO + 'server/services/universityAdmin.js', 'utf8');
  ok('  no email is sent from provisioning (no mailer anywhere in it)', !/resend|sendEmail|nodemailer|emails\.send/i.test(uaSrc));
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('  the old /api/admin/university-users no longer returns a plaintext password', !/password: r\.created \? password : undefined/.test(idx)
    && /app\.post\('\/api\/admin\/university-users', requireAuth, requireCampusAdmin, async \(req, res\) => \{\n  try \{\n    const r = await require\('\.\/services\/universityAdmin'\)\.createUniversityUser/.test(idx));

  // ── 3. ROSTERS ───────────────────────────────────────────────────────────
  OUT.push('', '-- roster import --');
  const teamsFound = RI.discoverTeams(HOME, 'https://chargers.example/');
  ok('the site\'s sports, from its /sports/<code> links (not news, not other hosts)', teamsFound.map((t) => t.code).sort().join() === 'bsb,mbkb,wsoc,wvball'
    && teamsFound.find((t) => t.code === 'mbkb').name === "Men's Basketball", teamsFound);
  ok('  a PrestoSports roster table: players, "Last, First" turned round, the coaching staff left out', (() => {
    const p = RI.parseRoster(PAGES['https://chargers.example/sports/mbkb/2025-26/roster']);
    return p.length === 3 && p.some((x) => x.name === 'Marcus Smith') && !p.some((x) => /Carter/.test(x.name)) && p[0].hometown === 'Cypress, Calif.' && p[0].highSchool === 'Pacifica HS';
  })());
  ok('  a Sidearm roster', RI.parseRoster(SIDEARM).map((x) => x.name).join() === 'Maya Torres,Lena Park');
  const imp = await RI.importRosters(P, { universityId: UID, siteUrl: 'chargers.example', now: new Date('2026-10-05T12:00:00Z') }, { fetch: fetchStub });
  ok('import: three teams with rosters, 7 athletes; the sport with no roster page is reported, not created', imp.ok && imp.teamCount === 3 && imp.athletes === 7
    && imp.skipped.length === 1 && imp.skipped[0].code === 'wsoc', imp);
  const tRows = (await P.query(`SELECT * FROM university_teams WHERE university_id = $1 ORDER BY name`, [UID])).rows;
  ok('  teams carry the season, the roster size and the market', tRows.length === 3 && tRows.find((t) => t.name === "Men's Basketball").season === 'Winter'
    && tRows.find((t) => t.name === 'Baseball').roster_size === 2 && tRows.every((t) => t.market_key === 'cypress, ca' && t.source === 'roster-import'), tRows);
  await RI.importRosters(P, { universityId: UID, siteUrl: 'chargers.example', now: new Date('2026-10-05T12:00:00Z') }, { fetch: fetchStub });
  ok('  a second import duplicates nothing', (await P.query(`SELECT COUNT(*)::int n FROM university_athletes WHERE university_id = $1`, [UID])).rows[0].n === 7
    && (await P.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [UID])).rows[0].n === 3);
  const seedSrc = fs.readFileSync(REPO + 'scripts/seed-cypress.js', 'utf8');
  ok('  the Cypress boot seed never removes an imported team', /COALESCE\(source, ''\) <> 'roster-import'/.test(seedSrc));

  // ── 4. THE BUSINESS LIST ─────────────────────────────────────────────────
  OUT.push('', '-- the business list: local and social only --');
  const NAMED = ['Nike', 'Oregon Ducks', 'Texas Tech', 'Miami Collective', 'On3 NIL Valuation', 'College Football 2026 Cover Star', 'Subway', 'Starbucks', 'Cypress College Athletics', 'Cypress High School'];
  const notBlocked = NAMED.filter((n) => !TS.blockedFor({ name: n }));
  ok('NEVER: Nike, Oregon Ducks, Texas Tech, Miami Collective, On3, a cover-star ranking, national chains, the college, a high school', !notBlocked.length, notBlocked);
  ok('  a real local business is not blocked', ["Joe's Pizza", 'Valley View Dental', 'Iron Works Gym'].every((n) => !TS.blockedFor({ name: n, types: ['restaurant'] })));
  // The social index: one that signs at this level, one too big, one stale, one incumbent.
  const sb = (brand, min, months, extra = {}) => P.query(`INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, proof_url, proof_date, tier_stated, active, offer_summary, deal_structure)
    VALUES ($1,'apparel','https://x.example',$2,$3,$4,'https://x.example/ambassadors',(NOW() - ($5 || ' months')::interval)::date,TRUE,TRUE,'Free gear and a code','cash_code')`,
  [brand, extra.sports || [], min, min * 20, String(months)]);
  await sb('UT Social Ambassador', 500, 2);
  await sb('UT Social Only Stars', 50000, 2);
  await sb('UT Social Stale', 500, 18);
  await P.query(`INSERT INTO social_brands (brand, category, sports, tier_min, tier_max, proof_url, proof_date, tier_stated, active, deal_structure) VALUES ('Nike', 'apparel', '{}', 0, 100000, 'https://n.example', CURRENT_DATE, TRUE, TRUE, 'cash_code')`).catch(() => {});
  placesCalls = 0;
  const b = await CB.build(P, UID, { budgetUsd: 12, places: placesStub, ai: aiStub });
  ok('the build runs and PRINTS what it spent against the $12 cap', b.ok && typeof b.spentUsd === 'number' && b.spentUsd <= 12 && b.budgetUsd === 12 && b.placesCalls === placesCalls, b);
  const seen = (await P.query(`SELECT brand, blocked_reason, distance_m FROM university_market_seen WHERE market_key = 'cypress, ca' AND brand = ANY($1)`, [PLACES.map((p) => p.name)])).rows;
  const usable = seen.filter((r) => !r.blocked_reason).map((r) => r.brand).sort();
  ok('  found locally: only real local businesses; every named wrong one is withdrawn', usable.join() === ["Cypress Lanes", 'Far Away Bakery', 'Iron Works Gym', "Joe's Pizza", 'Valley View Dental'].sort().join(), seen);
  const named = (await P.query(`SELECT brand FROM university_contacts WHERE university_id = $1 AND reachable`, [UID])).rows.map((r) => r.brand).sort();
  ok('  named decision makers, inside driving distance only (the bakery 57 km out is never looked up)', named.join() === ['Iron Works Gym', "Joe's Pizza", 'Valley View Dental'].sort().join()
    && !(await P.query(`SELECT 1 FROM university_contacts WHERE university_id = $1 AND brand = 'Far Away Bakery' AND status <> 'pending'`, [UID])).rowCount, named);
  const soc = (await P.query(`SELECT brand FROM university_social_brands WHERE university_id = $1`, [UID])).rows.map((r) => r.brand);
  ok('  social: the brand that signs athletes at this level; not the stars-only one, not the stale one, never Nike', soc.includes('UT Social Ambassador') && !soc.some((x) => /Only Stars|Stale|^Nike$/.test(x)), soc);
  const tiny = await CB.build(P, UID, { budgetUsd: 0.01, places: placesStub, ai: aiStub });
  ok('  THE CAP HOLDS: with too little left, no ring is bought and no lookup started', tiny.ok && tiny.spentUsd === 0 && tiny.placesCalls === 0 && tiny.contactsTried === 0, tiny);

  // ── 5. THE NIGHT, AND THE NUMBERS ────────────────────────────────────────
  OUT.push('', '-- the nightly and the numbers --');
  const CN = require(REPO + 'server/services/campusNightly.js');
  await P.query(`INSERT INTO universities (id, name, location) VALUES ('univ-ut-empty', 'UT Empty University', 'Birmingham, AL') ON CONFLICT (id) DO NOTHING`);
  const due = await CN.universitiesDue(P);
  ok('the nightly runs a university with teams and a business list (no staff sign-in needed)', due.includes(UID) && !due.includes('univ-ut-empty'), due);
  const v = await CB.verify(P, UID);
  ok('status prints teams, athletes, businesses found, with a named contact, social, cards', v.ok && v.teams === 3 && v.athletes === 7 && v.businessesFound === 5
    && v.businessesWithNamedContact === 3 && v.socialBrands >= 1 && v.cardsLatestNight === 0 && v.staff === 1 && v.nightlyReady && !v.needs.length, v);
  const txt = CB.formatVerify(v);
  ok('  as text', /teams\s+3/.test(txt) && /athletes\s+7/.test(txt) && /with a named contact\s+3/.test(txt) && /last build spent\s+\$/.test(txt), txt);
  const e = await CB.verify(P, 'univ-ut-empty');
  ok('an empty university (Samford\'s shape: "Birmingham, AL", no teams) says exactly what it still needs', e.ok && !e.nightlyReady
    && e.needs.some((n) => /campus street address/.test(n)) && e.needs.some((n) => /roster-import/.test(n)) && e.needs.some((n) => /business-build/.test(n)) && e.needs.some((n) => /create-university-user/.test(n)), e.needs);

  // ── 6. THE ADMIN PAGE ────────────────────────────────────────────────────
  OUT.push('', '-- the admin page --');
  const adm = fs.readFileSync(REPO + 'public/admin.html', 'utf8');
  ok('/admin has the Universities section: create university, create user (link shown, not emailed), rosters / business list / nightly, status',
    />Universities</.test(adm) && /createUniversity\(\)/.test(adm) && /createUniversityUser\(\)/.test(adm) && /university-roster-import/.test(adm)
    && /university-business-build/.test(adm) && /university-nightly/.test(adm) && /uniStatus\(\)/.test(adm) && /Not emailed/.test(adm));
  const scripts = [...adm.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const broken = scripts.filter((x) => { try { new Function(x[2]); return false; } catch (_) { return true; } });
  ok('  every script on /admin parses (the email-history and suppression panels were swallowed by a broken string)', !broken.length, broken.map((x) => x[2].slice(0, 60)));
  ok('  every route is admin-only', ['create-university', 'create-university-user', 'university-roster-import', 'university-business-build', 'university-nightly', 'university-bootstrap']
    .every((r) => new RegExp(`app\\.post\\('/api/admin/${r}', requireAuth, requireCampusAdmin`).test(idx)) && /app\.get\('\/api\/admin\/university-status\/:universityId', requireAuth, requireCampusAdmin/.test(idx));

  await clean();
  await P.query(`DELETE FROM users WHERE id = 'ut-agent'`).catch(() => {});
  await P.query(`DELETE FROM social_brands WHERE brand = 'Nike' AND proof_url = 'https://n.example'`).catch(() => {});
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
