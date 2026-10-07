'use strict';
// Five cards a team here, not the night's default two: these fixtures climb
// every rung (from file, social, bought for the card, new ground), and two
// cards a team stops after the first two. tests/univperteam.js checks two.
process.env.UNIVERSITY_CARDS_PER_TEAM = '5';
// The paid night (contacts bought for the card, for tomorrow): what these
// fixtures measure. tests/freenight.js covers the free night, the default.
process.env.UNIVERSITY_NIGHT_PAID_CONTACTS = 'on';
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
const CN = require(REPO + 'server/services/campusNightly.js');

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
    await P.query(`DELETE FROM users WHERE id = 'ut-admin'`).catch(() => {});
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
    VALUES ($1,'apparel','https://x.example',$2,$3,$4,'https://x.example/ambassadors',(NOW() - ($5 || ' months')::interval)::date,$6,TRUE,'Free gear and a code','cash_code')`,
  [brand, extra.sports || [], min, min * 20, String(months), extra.stated !== false]);
  // The common real case: discovery wrote sports ['all'] and the page states
  // no follower minimum. Both used to drop it (Cypress came back with 0).
  await sb('UT Social Ambassador', 0, 2, { sports: ['all'], stated: false });
  await sb('UT Social Golf Only', 0, 2, { sports: ['golf'] });
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
  ok('  sports "all" and a program that states no minimum count (the two filters that emptied Cypress)', soc.includes('UT Social Ambassador') && !soc.includes('UT Social Golf Only'), soc);
  const fn = b.socialFunnel || {};
  ok('  the funnel says what each step removed', fn.inIndex >= 5 && fn.staleOver12Months >= 1 && fn.minimumTooHigh >= 1 && fn.noSportMatch >= 1 && fn.incumbent >= 1 && fn.kept >= 1
    && /in the social index; out: .* kept \d+/.test(CB.formatFunnel(fn)), fn);
  ok('  a build with local and social is not a failure', b.ok && Array.isArray(b.failures) && !b.failures.length, b.failures);
  const tiny = await CB.build(P, UID, { budgetUsd: 0.01, places: placesStub, ai: aiStub });
  ok('  THE CAP HOLDS: with too little left, no ring is bought and no lookup started', tiny.ok && tiny.spentUsd === 0 && tiny.placesCalls === 0 && tiny.contactsTried === 0, tiny);

  // ── 5. THE NIGHT, AND THE NUMBERS ────────────────────────────────────────
  OUT.push('', '-- the nightly and the numbers --');
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

  // ── 5a. THE LIST IS WORTH MORE THAN A PLACES SCRAPE ──────────────────────
  OUT.push('', '-- quality: categories, chains, decision makers, inboxes, duplicates --');
  const QC = require(REPO + 'server/services/campusQuality.js');
  const QU = 'univ-ut-q', QM = 'qtown, ca';
  const qclean = async () => {
    await P.query(`DELETE FROM university_contacts WHERE university_id = $1`, [QU]).catch(() => {});
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [QM]).catch(() => {});
    await P.query(`DELETE FROM university_market_runs WHERE university_id = $1`, [QU]).catch(() => {});
    await P.query(`DELETE FROM university_social_brands WHERE university_id = $1`, [QU]).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = $1`, [QU]).catch(() => {});
  };
  await qclean();
  await QC.ensureColumns(P);
  await P.query(`INSERT INTO universities (id, name, location) VALUES ($1, 'UT Quality College', '1 Main St, Qtown, CA')`, [QU]);
  const biz = async (brand, category, contact = {}, extra = {}) => {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, address, distance_m, fit)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`, [QM, brand, extra.place || ('q-' + brand.replace(/\W+/g, '')), category, JSON.stringify([category]), extra.address || (brand + ' Rd, Qtown, CA'), 1500, extra.fit || 50]);
    if (contact.name !== undefined) {
      await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, contact_name, contact_title, email, phone, website, reachable, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,'reachable')`, [QU, QM, brand, contact.name, contact.title || 'Owner', contact.email || null, contact.phone || null, contact.website || null]);
    }
  };
  for (let i = 0; i < 10; i++) await biz(`Q Smile Dental ${i}`, 'dentist', { name: `Dee Dentist${i}`, phone: '714-555-01' + String(i).padStart(2, '0') });
  for (let i = 0; i < 3; i++) await biz(`Q Iron Gym ${i}`, 'gym', { name: `Gus Gymowner${i}`, email: `gus${i}@qgym${i}.com` });
  for (let i = 0; i < 3; i++) await biz(`Q Taqueria ${i}`, 'restaurant', { name: `Rosa Cook${i}`, email: `rosa${i}@qtaco${i}.com` });
  for (let i = 0; i < 2; i++) await biz(`Q Auto Group ${i}`, 'car_dealer', { name: `Al Dealer${i}`, email: `al${i}@qauto${i}.com` });
  await biz('Q Smoothie Spot', 'cafe', { name: 'Sam Blend', email: 'sam@qsmoothie.com' });
  await biz('Big 5 Sporting Goods', 'sporting_goods_store', { name: 'Jeffrey McCargar', title: 'Store Manager', phone: '714-555-0901' });
  await biz('Corner Parts', 'store', { name: 'Bill Martin', title: 'Manager', email: 'bill.m@autozone.com' });
  await biz('Freeway Insurance', 'insurance_agency', { name: 'Daniel Suarez', title: 'NASCAR driver, sponsorship partner (state filing)', email: 'customercare@confie.com' });
  await biz('Speedy Insure', 'insurance_agency', { name: 'Dan Driver', title: 'NASCAR driver, sponsorship partner (state filing)', phone: '714-555-0902' });
  await biz('Seven Brew Cafe', 'cafe', { name: 'Christian Soriano', title: 'Director, Videographer', email: 'christian@sevenbrew.com' });
  await biz('Home Run Park', 'amusement_park', { name: 'Hal Park', title: 'Owner', email: 'info@homerunpark.com' });
  await biz('7 Leaves Cafe Qtown', 'cafe', { name: 'Tina Tran', title: 'Owner', email: 'customercare@7leavescafe.com', phone: '714-555-0903', website: 'https://www.7leavescafe.com/' }, { fit: 60 });
  await biz('7 Leaves Cafe', 'cafe', { name: 'Tina Tran', title: 'Owner', email: 'customercare@7leavescafe.com', website: '7leavescafe.com' }, { fit: 40 });
  const qb = await CB.build(P, QU, { budgetUsd: 3, places: { buildMarketPoolFromPlaces: async () => ({ ok: true, candidates: [], placesCalls: 0, geocoded: null }) }, ai: aiStub });
  const why = qb.withdrawnByWhy || {};
  const wdr = (brand) => (qb.withdrawn || []).find((w) => w.brand === brand);
  ok('NATIONAL CHAINS: Big 5 and Freeway Insurance withdrawn by name', wdr('Big 5 Sporting Goods') && /national brand/.test(wdr('Big 5 Sporting Goods').why) && wdr('Freeway Insurance') && /national brand/.test(wdr('Freeway Insurance').why), qb.withdrawn);
  ok('  and a business whose contact is at a chain\'s corporate address (bill.m@autozone.com)', wdr('Corner Parts') && /corporate address/.test(wdr('Corner Parts').why), wdr('Corner Parts'));
  ok('A SPONSORED ATHLETE IS NEVER THE DECISION MAKER (the NASCAR driver), nor a videographer', wdr('Speedy Insure') && wdr('Speedy Insure').why === 'not a decision maker'
    && wdr('Seven Brew Cafe') && wdr('Seven Brew Cafe').why === 'not a decision maker', [wdr('Speedy Insure'), wdr('Seven Brew Cafe')]);
  // info@ beside a named person is a SEND PATH (kept apart, never their own
  // address): the business stays, reachable through the shared inbox.
  const hrp = (await P.query(`SELECT reachable, email, generic_email FROM university_contacts WHERE university_id = $1 AND brand = 'Home Run Park'`, [QU])).rows[0];
  ok('A SHARED INBOX IS A SEND PATH, NOT A PERSON: info@ beside a named owner stays, kept apart from their name', !wdr('Home Run Park')
    && hrp && hrp.reachable === true && !hrp.email && hrp.generic_email === 'info@homerunpark.com', { w: wdr('Home Run Park'), hrp });
  const leaves = (await P.query(`SELECT brand, email, generic_email, reachable FROM university_contacts WHERE university_id = $1 AND brand LIKE '7 Leaves%'`, [QU])).rows;
  const kept7 = leaves.find((x) => x.brand === '7 Leaves Cafe Qtown');
  ok('  a shared inbox with a phone: reached by phone, the inbox moved off the person\'s name', kept7 && kept7.reachable && kept7.email === null && kept7.generic_email === 'customercare@7leavescafe.com', leaves);
  ok('DUPLICATES: "7 Leaves Cafe" and "7 Leaves Cafe Qtown" (one website) are one business', (qb.withdrawn || []).some((w) => w.brand === '7 Leaves Cafe' && w.why === 'duplicate')
    && !(qb.withdrawn || []).some((w) => w.brand === '7 Leaves Cafe Qtown')
    && /^withdrawn: duplicate of 7 Leaves Cafe Qtown/.test((await P.query(`SELECT blocked_reason FROM university_market_seen WHERE market_key = $1 AND brand = '7 Leaves Cafe'`, [QM])).rows[0].blocked_reason), qb.withdrawn);
  ok('  a withdrawn business is reported once, for its first reason', (qb.withdrawn || []).filter((w) => w.brand === 'Freeway Insurance').length === 1);
  ok('  the dedupe keys: Place ID, then website domain, then name + address', QC.normName('7 Leaves Cafe Cypress', 'Cypress, CA') === QC.normName('7 Leaves Cafe', 'Cypress, CA') && QC.domainOf('https://www.7leavescafe.com/') === QC.domainOf('customercare@7leavescafe.com'));
  const hist = qb.histogram || [];
  const listed = hist.reduce((a, r) => a + r.listed, 0);
  const dent = hist.find((r) => r.bucket === 'dentist') || { listed: 0, contactable: 0 };
  ok('NO CATEGORY OVER 15%: 10 contactable dentists cut to their share (never banned: some stay; a short list lets any category keep 2)', dent.contactable === 10 && dent.listed >= 1
    && hist.every((r) => r.listed <= Math.max(2, Math.floor(0.15 * listed))), hist);
  const big = QC.capList(Array.from({ length: 58 }, (_, i) => ({ brand: 'b' + i, fit: 50, ...(i < 18 ? { bucket: 'dentist', priority: 3 } : i < 26 ? { bucket: 'auto', priority: 8 }
    : { bucket: 'c' + (i % 8), priority: 7 }) })));
  const bc = big.list.reduce((o, r) => { o[r.bucket] = (o[r.bucket] || 0) + 1; return o; }, {});
  ok('  Cypress\'s shape (58 contactable, 18 dentists, 8 dealers): every category at or under 15% of the list', Object.values(bc).every((n) => n / big.list.length <= 0.15 + 1e-9) && bc.dentist >= 1, { listed: big.list.length, bc });
  ok('  held, not deleted: the over-share dentists keep their contact, marked held', (await P.query(`SELECT COUNT(*)::int n FROM university_contacts WHERE university_id = $1 AND reachable AND held_reason LIKE 'dentist is over 15%%'`, [QU])).rows[0].n === 10 - dent.listed);
  ok('  the build prints the histogram, the withdrawals by reason, contactable and the social funnel', /CATEGORY HISTOGRAM/.test(CB.formatBuild(qb)) && /WITHDRAWN this build: \d+ \(/.test(CB.formatBuild(qb))
    && /CONTACTABLE: \d+ businesses/.test(CB.formatBuild(qb)) && /SOCIAL: \d+ brands\. \d+ in the social index/.test(CB.formatBuild(qb)), CB.formatBuild(qb));
  const qv = await CB.verify(P, QU);
  ok('  status counts only listed, reachable, not-withdrawn businesses as "with a named contact"', qv.businessesWithNamedContact === listed && qv.contactableBeforeShareCap === hist.reduce((a, r) => a + r.contactable, 0), qv);
  ok('categories ranked by how likely to do an athlete deal: gyms, food, apparel, auto, barbers over dentists and clinics', QC.bucketOf({ category: 'gym' }).priority > QC.bucketOf({ category: 'dentist' }).priority
    && QC.bucketOf({ category: 'restaurant' }).priority > QC.bucketOf({ category: 'medical clinic' }).priority && QC.bucketOf({ types: ['car_dealer'] }).priority > QC.bucketOf({ category: 'dentist' }).priority);
  const CM = require(REPO + 'server/services/campusMarket.js');
  const srch = await CM.search(P, QU, { contact: '1', limit: 5 });
  ok('  the portal\'s list leads with them: default order is deal likelihood, the held rows after', srch.ok && srch.filters.sort === 'priority' && !srch.rows.slice(0, 5).some((x) => /Dental/.test(x.brand)), srch.rows.map((x) => x.brand));
  // The contact ladder itself never pairs a name with a shared inbox, nor picks the sponsored athlete.
  const CC = require(REPO + 'server/services/campusContacts.js');
  const ro = await CC.resolveOne({ brand: 'Q Test' }, { city: 'Qtown, CA', history: false, ai: { deepContactCtx: () => ({}), webSearchJson: async () => ({ text: '{}' }),
    getBrandContacts: async () => ({ contacts: [{ name: 'Daniel Suarez', title: 'NASCAR driver, sponsorship partner', email: 'dan@x.com' }, { name: 'Pat Kowalski', title: 'Owner', source: 'site' }], genericInbox: 'info@qtest.com' }) } });
  ok('  the ladder skips the driver, takes the owner, and keeps info@ as a send path, not as their address', ro.contact_name === 'Pat Kowalski' && ro.email === null && ro.generic_email === 'info@qtest.com' && ro.reachable === true, ro);
  await qclean();

  // ── 5a-1b. THE CAP ON THE LIST THE PORTAL READS (Cypress in production) ──
  // 65 contactable, 22 dentists, nothing held: the dentists' names put them in
  // other categories ("Kids Dental Park" entertainment, "... Market Place"
  // local retail, "... Dental Spa" salons), so no category crossed 15%, and
  // market/search?contact=1 never looked at the cap anyway.
  OUT.push('', '-- the 15% cap on market/search?contact=1 --');
  const KU = 'univ-ut-cap', KM = 'captown, ca';
  const kclean = async () => {
    await P.query(`DELETE FROM university_contacts WHERE university_id = $1`, [KU]).catch(() => {});
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [KM]).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = $1`, [KU]).catch(() => {});
  };
  await kclean();
  await P.query(`INSERT INTO universities (id, name, location) VALUES ($1, 'UT Cap College', '1 Main St, Captown, CA')`, [KU]);
  const kb = async (brand, category, primary, bucketStored, i) => {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit, deal_bucket, deal_priority)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,50,$9,7)`, [KM, brand, 'k-' + i, category, JSON.stringify([primary, 'point_of_interest', 'establishment']), primary, brand + ' Rd, Captown, CA', 1000 + i * 10, bucketStored]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, contact_name, contact_title, phone, reachable, status)
                   VALUES ($1,$2,$3,$4,'Owner',$5,TRUE,'reachable')`, [KU, KM, brand, 'Pat Owner' + i, '714-555-2' + String(i).padStart(3, '0')]);
  };
  let ki = 0;
  const dentNames = ['Kids Dental Park', 'Dentistry at Cypress Market Place', 'Lincoln Ave Dental Spa', 'Parkview Dental Group', 'Pet-Friendly Smiles Dental'];
  for (let i = 0; i < 22; i++) {
    const name = dentNames[i] || `Cypress Family Dentistry ${i}`;
    // What the old name-first rule had stored for them.
    const old = /Park/.test(name) ? 'entertainment' : /Market|Pet/.test(name) ? 'local retail' : /Spa/.test(name) ? 'barber & salon' : 'dentist';
    await kb(name, 'health', 'dentist', old, ki++);
  }
  const mix = [['restaurant', 'mexican_restaurant', 6], ['coffee', 'cafe', 5], ['apparel', 'clothing_store', 5], ['barber', 'barber_shop', 5], ['sports medicine', 'physiotherapist', 4],
    ['gym', 'gym', 5], ['auto', 'car_dealer', 5], ['dessert', 'bakery', 4], ['insurance', 'insurance_agency', 4]];
  for (const [cat, type, n] of mix) for (let i = 0; i < n; i++) await kb(`Cap ${type} ${i}`, cat, type, null, ki++);
  ok('the bucket comes from Google\'s type, not words in the name: "Kids Dental Park", "... Market Place", "... Dental Spa" are dentists',
    dentNames.slice(0, 3).every((n) => QC.bucketOf({ brand: n, category: 'health', primary_type: 'dentist', types: ['dentist', 'health'] }).bucket === 'dentist'));
  const ks = await CM.search(P, KU, { contact: '1', limit: 5000 });
  const kc = {}; for (const r of ks.rows) kc[r.bucket] = (kc[r.bucket] || 0) + 1;
  ok('market/search?contact=1 applies the cap itself: dentists at or under 15% of what it returns (was 22 of 65)', ks.ok && ks.rows.length < 65 && (kc.dentist || 0) >= 1 && (kc.dentist || 0) / ks.rows.length <= 0.15 + 1e-9, { n: ks.rows.length, kc });
  ok('  every category in what search returns is at or under 15%', Object.values(kc).every((n) => n / ks.rows.length <= 0.15 + 1e-9), kc);
  ok('  and no held row is in it', ks.rows.every((r) => !r.held));
  const top10 = ks.rows.slice(0, 10).map((r) => r.bucket);
  ok('  restaurants, coffee, apparel, barbers and sports medicine near the top; dentists not in the top 10',
    ['restaurant', 'smoothie & coffee', 'apparel & sporting', 'sports medicine'].every((b) => ks.rows.slice(0, 25).some((r) => r.bucket === b))
    && ks.rows.slice(0, 30).some((r) => r.bucket === 'barber & salon') && !top10.includes('dentist'), ks.rows.slice(0, 30).map((r) => r.bucket + ': ' + r.brand));
  const kh = await CM.search(P, KU, { contact: '1', held: '1', limit: 5000 });
  ok('  held=1 still shows the held dentists (held, never deleted), last', kh.rows.length === 65 && kh.rows.slice(-3).every((r) => r.held && r.bucket === 'dentist'), kh.rows.length);
  const kv = await CB.verify(P, KU);
  ok('  status agrees with search: businessesWithNamedContact = what search returns, below contactableBeforeShareCap', kv.businessesWithNamedContact === ks.rows.length && kv.contactableBeforeShareCap === 65, kv);
  await kclean();

  // ── 5a-2. THE TILE AND THE LOCK ─────────────────────────────────────────
  OUT.push('', '-- the athletes tile, the lock --');
  const lt = await require(REPO + 'server/services/universityPortal.js').listTeams(P, UID);
  ok('the portal\'s athletes tile sums the athletes on file (7), not a stored roster guess', lt.teams.reduce((a, t) => a + (t.roster_size || 0), 0) === 7, lt.teams.map((t) => [t.name, t.roster_size, t.roster_size_stated]));
  const UJ = require(REPO + 'server/services/universityJobs.js');
  await UJ.release(P, UID);
  const l1 = await UJ.acquire(P, UID, 'business build');
  const l2 = await UJ.acquire(P, UID, 'business build');
  ok('one job at a time per university', l1.ok && !l2.ok && l2.holder && l2.holder.label === 'business build', { l1, l2 });
  await P.query(`UPDATE university_jobs SET beat_at = NOW() - INTERVAL '2 hours' WHERE university_id = $1`, [UID]);
  const l3 = await UJ.acquire(P, UID, 'business build');
  ok('  a crashed job\'s lock (no sign of life for 20 minutes) frees itself', l3.ok, l3);
  await UJ.release(P, UID);
  ok('  and it can be cleared by hand', !(await UJ.status(P, UID)) && /app\.post\('\/api\/admin\/university-unlock', requireAuth, requireCampusAdmin/.test(fs.readFileSync(REPO + 'server/index.js', 'utf8')));

  // ── 5b. ZERO ON EITHER SIDE IS A FAILURE ────────────────────────────────
  OUT.push('', '-- zero local or zero social is a failure --');
  await P.query(`DELETE FROM university_social_brands WHERE university_id = $1`, [UID]);
  const vz = await CB.verify(P, UID);
  ok('0 social brands after a build: status says FAILED, with the funnel', vz.failures.some((f) => /^0 social brands: \d+ in the social index/.test(f)) && /FAILED:/.test(CB.formatVerify(vz)), vz.failures);
  await CB.socialList(P, { id: UID });

  // ── 5c. THE NIGHT: HARD $5, NO PLACES, THE PROJECTION FIRST ─────────────
  OUT.push('', '-- the night: projected, capped at $5 --');
  const est = await CN.estimate(P, UID);
  ok('the projection: 3 teams x 5 cards, a social seat a team (one brand, two teams at most), the named contacts on file, lookups only for the rest',
    est.ok && est.cards === 15 && est.socialCards === 2 && est.cardsFromFile === 3 && est.lookupsNeeded === 10 && est.discoveryUsd === CN.DISCOVERY_USD
    && est.totalUsd[1] <= 5 && est.nightCapUsd === 5, est);
  ok('  with what a named contact costs here, the reserve before and after, and the runway', est.perNamedUsd > 0 && est.reserveNow === 3 && Number.isFinite(est.runwayNightsNow)
    && /RUNWAY: /.test(CN.formatEstimate(est)) && /PROJECTED: \$\d+\.\d\d -- writing \$/.test(CN.formatEstimate(est)), CN.formatEstimate(est));
  ok('  printed', /TONIGHT FOR UT Cypress College: 3 teams x 5 cards = 15 cards/.test(CN.formatEstimate(est)) && /HARD CAP: \$5\.00/.test(CN.formatEstimate(est)), CN.formatEstimate(est));
  const stTxt = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('  and on the status page, before the run', /CN\.formatEstimate\(est\)/.test(stTxt));

  // ── 5d. THE SWITCHER ─────────────────────────────────────────────────────
  OUT.push('', '-- the admin views any university, read-only --');
  const AV = require(REPO + 'server/services/adminView.js');
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('ut-admin', 'The Admin', 'admin.ut@nildash.example', 'x', 'admin') ON CONFLICT DO NOTHING`);
  const mw = AV.middleware({ pool: P, adminEmail: 'admin.ut@nildash.example' });
  const call = (req) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    mw(req, res, () => resolve({ status: 'next', seen: AV.override(req.session.userId) }));
  });
  const badUni = await AV.set(P, { session: {} }, 'univ-nope');
  ok('choosing a university that does not exist is refused', !badUni.ok);
  const sess = { userId: 'ut-admin' };
  const chosen = await AV.set(P, { session: sess }, UID);
  ok('the admin chooses a university for this session only', chosen.ok && sess.viewUniversityId === UID);
  const g = await call({ session: sess, method: 'GET' });
  ok('  every portal read now resolves to it', g.status === 'next' && g.seen === UID, g);
  const w = await call({ session: sess, method: 'POST' });
  ok('  and every write is refused: nothing is changed or sent as the school', w.status === 403 && w.body.code === 'ADMIN_VIEW_READ_ONLY', w);
  const xs = { userId: xu.id, viewUniversityId: 'univ-ut-empty' };
  const nx = await call({ session: xs, method: 'GET' });
  ok('  for anyone but the admin it does nothing (and is cleared)', nx.status === 'next' && nx.seen === null && !xs.viewUniversityId, nx);
  ok('  no account is written: the admin\'s own university_id is untouched', (await P.query(`SELECT university_id FROM users WHERE id = 'ut-admin'`)).rows[0].university_id === null);
  const campus = fs.readFileSync(REPO + 'server/routes/campus.js', 'utf8');
  ok('  both resolvers ask it first (the market routes and the teams / inventory routes)', /adminView'\)\.override\(u\.id\)/.test(campus)
    && /async function resolveSessionUniversity\(userId\) \{\n  \/\/ The admin viewing another university[^\n]*\n  const viewing = require\('\.\/services\/adminView'\)\.override\(userId\);/.test(stTxt)
    && /app\.use\('\/api\/university', require\('\.\/services\/adminView'\)\.middleware/.test(stTxt));
  const portal = fs.readFileSync(REPO + 'public/university.html', 'utf8');
  ok('  the portal says so on every screen, with a way back', /Viewing " \+ name \+ " as admin\. Read-only/.test(portal) && /viewingAsAdmin/.test(portal));
  await P.query(`DELETE FROM users WHERE id = 'ut-admin'`).catch(() => {});

  // ── 6. THE ADMIN PAGE ────────────────────────────────────────────────────
  OUT.push('', '-- the admin page --');
  const adm = fs.readFileSync(REPO + 'public/admin.html', 'utf8');
  ok('/admin has the Universities section: create university, create user (link shown, not emailed), rosters / business list / nightly, status',
    />Universities</.test(adm) && /createUniversity\(\)/.test(adm) && /createUniversityUser\(\)/.test(adm) && /university-roster-import/.test(adm)
    && /university-business-build/.test(adm) && /university-nightly/.test(adm) && /uniStatus\(\)/.test(adm) && /Not emailed/.test(adm)
    && /uniView\(\)/.test(adm) && /view-university/.test(adm));
  const scripts = [...adm.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const broken = scripts.filter((x) => { try { new Function(x[2]); return false; } catch (_) { return true; } });
  ok('  every script on /admin parses (the email-history and suppression panels were swallowed by a broken string)', !broken.length, broken.map((x) => x[2].slice(0, 60)));
  ok('  every route is admin-only', ['create-university', 'create-university-user', 'university-roster-import', 'university-business-build', 'university-nightly', 'university-bootstrap']
    .concat(['view-university']).every((r) => new RegExp(`app\\.post\\('/api/admin/${r}', requireAuth, requireCampusAdmin`).test(idx)) && /app\.get\('\/api\/admin\/university-status\/:universityId', requireAuth, requireCampusAdmin/.test(idx));

  await clean();
  await P.query(`DELETE FROM users WHERE id = 'ut-agent'`).catch(() => {});
  await P.query(`DELETE FROM social_brands WHERE brand = 'Nike' AND proof_url = 'https://n.example'`).catch(() => {});
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
