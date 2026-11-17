'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/universitybook.js
//
// ── THE BOOKING PAGE (services/universityBook, public/book.html) ─────────────
// A business picks a team, sees the school's price (or asks for options) and
// books. The booking lands in the school's own tables, moves the business to
// "Working out terms", shows on Today, and the pitch ends with the link.
// Fictional names only.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('universitybooktest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const PASS = 'book-test-pass-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const UB = require(REPO + 'server/services/universityBook.js');
  const TW = require(REPO + 'server/services/teamWriter.js');
  await require(REPO + 'server/services/campusPool').ensureTables(P);
  await require(REPO + 'server/services/teamScan').ensureTables(P);
  await UB.ensureTables(P);

  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ('univ-pinecrest','Pinecrest State University','Pinecrest','Pinecrest, GA'), ('univ-elsewhere','Elsewhere College','Elsewhere','Elsewhere, GA')`);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, season, roster_size, nil_rate_cents, nil_rate_what) VALUES
    ('pc:vb','univ-pinecrest',$1,'Volleyball','Fall',17,150000,'8 players: a two-hour appearance and one post each'),
    ('pc:bsb','univ-pinecrest','Baseball','Baseball','Spring',36,NULL,NULL),
    ('el:fb','univ-elsewhere','Football','Football','Fall',100,NULL,NULL)`, ["Women's Volleyball"]);

  // ── THE SERVICE ────────────────────────────────────────────────────────
  ok('the link: /book/<school>, the team on it', UB.bookUrl('univ-pinecrest', 'pc:vb') === 'https://mynildash.com/book/pinecrest?t=pc%3Avb' && UB.idOf('pinecrest') === 'univ-pinecrest' && UB.idOf('../x') === null);
  const pg = await UB.page(P, 'pinecrest');
  ok('the page: the school and its teams, fall first, with the school\'s price', pg.school.name === 'Pinecrest State University' && pg.teams.map((t) => t.id).join(',') === 'pc:vb,pc:bsb'
    && pg.teams[0].rate.price === '$1,500' && pg.teams[1].rate === null, pg);
  ok('  no athlete, no other school', !/roster|athlete/i.test(JSON.stringify(pg)) && !/Elsewhere/.test(JSON.stringify(pg)));
  ok('  a school that is not there is a 404', (await UB.page(P, 'nowhere')) === null);

  const bad = async (body, why) => { const r = await UB.book(P, 'pinecrest', body); ok(`refused: ${why}`, !r.ok && r.status === 400, r); };
  await bad({ name: 'Dana Reyes', email: 'dana@harbor.test', teamId: 'pc:vb' }, 'no business');
  await bad({ business: 'Harbor Lane Dental', email: 'dana@harbor.test', teamId: 'pc:vb' }, 'no name');
  await bad({ business: 'Harbor Lane Dental', name: 'Dana Reyes', teamId: 'pc:vb' }, 'no way to reach them');
  await bad({ business: 'Harbor Lane Dental', name: 'Dana Reyes', email: 'not-an-email', teamId: 'pc:vb' }, 'a bad email');
  await bad({ business: 'Harbor Lane Dental', name: 'Dana Reyes', email: 'dana@harbor.test', teamId: 'el:fb' }, 'another school\'s team');
  const hp = await UB.book(P, 'pinecrest', { business: 'Spam Co', name: 'Bot', email: 'b@b.test', teamId: 'pc:vb', website: 'http://spam' });
  ok('the hidden field: a bot is thanked and nothing is kept', hp.ok && hp.id === null && (await P.query(`SELECT COUNT(*)::int n FROM university_bookings`)).rows[0].n === 0);

  await P.query(`INSERT INTO university_crm (university_id, brand, stage) VALUES ('univ-pinecrest','Harbor Lane Dental','contacted'), ('univ-pinecrest','Corner Grill','deal_signed')`);
  const b1 = await UB.book(P, 'pinecrest', { business: 'Harbor Lane Dental', name: 'Dana Reyes', email: 'Dana@Harbor.test', phone: '', teamId: 'pc:vb', dates: 'A Saturday in March', note: 'New patient special' });
  ok('a booking at the school\'s price is kept as sent', b1.ok && b1.rated);
  const row = (await P.query(`SELECT * FROM university_bookings WHERE id = $1`, [b1.id])).rows[0];
  ok('  with the deal, the price, the dates and a lower-case email', row.university_id === 'univ-pinecrest' && row.price_cents === 150000 && /8 players/.test(row.deal) && row.dates === 'A Saturday in March'
    && row.email === 'dana@harbor.test' && row.wants_options === false && row.status === 'new', row);
  const crm = (b) => P.query(`SELECT stage FROM university_crm WHERE university_id = 'univ-pinecrest' AND brand = $1`, [b]).then((r) => (r.rows[0] || {}).stage);
  ok('  the business moves to Working out terms', (await crm('Harbor Lane Dental')) === 'in_talks');
  const touch = (await P.query(`SELECT * FROM university_touches WHERE university_id = 'univ-pinecrest' AND brand = 'Harbor Lane Dental'`)).rows[0];
  ok('  and an inbound touch says what they booked, on the team', touch.direction === 'in' && touch.team_id === 'pc:vb' && /Booked from your link: Women's Volleyball, 8 players.*\$1,500/.test(touch.summary) && /Dana Reyes/.test(touch.summary), touch);
  const b2 = await UB.book(P, 'pinecrest', { business: 'Corner Grill', name: 'Sam Hill', phone: '(205) 555-0100', teamId: 'pc:vb', wantsOptions: true });
  ok('asking for options: no price kept, and a signed deal is never moved back', b2.ok && !b2.rated && (await crm('Corner Grill')) === 'deal_signed'
    && (await P.query(`SELECT price_cents, wants_options FROM university_bookings WHERE id = $1`, [b2.id])).rows[0].wants_options === true);
  const b3 = await UB.book(P, 'pinecrest', { business: 'Riverside Ford', name: 'Lee Park', email: 'lee@ford.test', teamId: 'pc:bsb' });
  ok('a team with no rate: options, never a price', b3.ok && !b3.rated && (await P.query(`SELECT price_cents FROM university_bookings WHERE id = $1`, [b3.id])).rows[0].price_cents === null);
  const again = await UB.book(P, 'pinecrest', { business: 'riverside ford', name: 'Lee Park', email: 'lee@ford.test', teamId: 'pc:bsb' });
  ok('the same business and team again within ten minutes is the first booking, not a second', again.ok && again.duplicate && again.id === b3.id);
  const L = await UB.list(P, 'univ-pinecrest');
  ok('the office\'s list: newest first, with the team', L.length === 3 && L[0].business === 'Riverside Ford' && L[2].team === "Women's Volleyball");
  ok('  only its own school', (await UB.list(P, 'univ-elsewhere')).length === 0 && !(await UB.setStatus(P, 'univ-elsewhere', b1.id, 'seen')).ok);
  ok('rate limit: five in ten minutes from one address, then no', [1, 2, 3, 4, 5].every(() => UB.allow('9.9.9.9', 1000)) && !UB.allow('9.9.9.9', 2000) && UB.allow('9.9.9.9', 1000 + 11 * 60 * 1000));

  // ── THE PITCH ENDS WITH THE LINK ───────────────────────────────────────
  const ctx = { university: { id: 'univ-pinecrest', name: 'Pinecrest State University' }, team: { name: "Women's Volleyball" }, business: { brand_name: 'Harbor Lane Dental' },
    contactName: 'Dana Reyes', bookUrl: UB.bookUrl('univ-pinecrest', 'pc:vb') };
  const email = TW.compose({ subject: 's', body: 'Players on the team would do an appearance.' }, ctx);
  ok('the team pitch ends with the booking link, above the sign-off', /See the options and pick a date: https:\/\/mynildash\.com\/book\/pinecrest\?t=pc%3Avb\n\nWomen's Volleyball/.test(email), email);
  ok('  the DM too', /pick a date: https:\/\/mynildash\.com\/book\/pinecrest/.test(TW.compose({ subject: 'DM', body: 'Hi.' }, { ...ctx, dm: true })));
  ok('  a brand program card does not get it', !/book\//.test(TW.compose({ subject: 's', body: 'x' }, { ...ctx, program: { url: 'https://brand.test' } })));
  const scan = fs.readFileSync(REPO + 'server/services/teamScan.js', 'utf8');
  ok('  the night passes the link for the email and the DM', (scan.match(/bookUrl: require\('\.\/universityBook'\)\.bookUrl\(university\.id, team\.id\)/g) || []).length === 2);

  // ── A TEAM WITH PLAYERS IS PITCHED, INVENTORY OR NOT ───────────────────
  const CN = require(REPO + 'server/services/campusNightly.js');
  const sell = await CN.sellableTeams(P, 'univ-pinecrest');
  ok('a team with players or a rate is sellable with no inventory loaded', sell.get('pc:vb').sellable && sell.get('pc:bsb').sellable && sell.get('pc:bsb').items === 0);
  await P.query(`INSERT INTO university_teams (id, university_id, name) VALUES ('pc:empty','univ-pinecrest','Club Team')`);
  ok('  a team with nothing at all is not', !(await CN.sellableTeams(P, 'univ-pinecrest')).get('pc:empty').sellable);
  await P.query(`DELETE FROM university_teams WHERE id = 'pc:empty'`);

  // ── WORKING ALONGSIDE THE SCHOOL'S TOOLS ───────────────────────────────
  ok('no marketplace set: none on the page', (await UB.page(P, 'pinecrest')).marketplace === null && (await UB.marketplace(P, 'univ-pinecrest')) === null);
  ok('a bad link is refused', !(await UB.setMarketplace(P, 'univ-pinecrest', { name: 'X', url: 'javascript:alert(1)' })).ok
    && !(await UB.setMarketplace(P, 'univ-pinecrest', { name: 'X', url: 'http://plain.example.com' })).ok);
  const mp = await UB.setMarketplace(P, 'univ-pinecrest', { name: 'Opendorse', url: 'opendorse.com/pinecrest' });
  ok('the marketplace link is kept as https and shown on the booking page', mp.ok && mp.marketplace.url === 'https://opendorse.com/pinecrest'
    && (await UB.page(P, 'pinecrest')).marketplace.name === 'Opendorse' && (await UB.page(P, 'pinecrest')).marketplace.url === 'https://opendorse.com/pinecrest', mp);
  ok('  only for its own school', (await UB.page(P, 'elsewhere')) === null || (await UB.marketplace(P, 'univ-elsewhere')) === null);
  const one = (await UB.list(P, 'univ-pinecrest')).find((b) => b.business === 'Harbor Lane Dental');
  const sum = UB.summary(one, 'Pinecrest State University Athletics');
  ok('the deal summary: who pays, contact, team, the work, the price, when, and that the office adds the players', /Business \(pays the athletes\): Harbor Lane Dental/.test(sum) && /Contact: Dana Reyes, dana@harbor\.test/.test(sum)
    && /Team: Women's Volleyball/.test(sum) && /What the athletes do: 8 players/.test(sum) && /Total paid to the athletes: \$1,500/.test(sum) && /When: A Saturday in March/.test(sum)
    && /Athletes: the players who opt in \(added by the NIL office\)/.test(sum), sum);
  ok('  an options request says to be agreed, never a made-up price', /Total paid to the athletes: to be agreed/.test(UB.summary((await UB.list(P, 'univ-pinecrest')).find((b) => b.business === 'Riverside Ford'), 'X')));
  await P.query(`INSERT INTO university_deals (university_id, brand, team_id, value_cents, description, signed_on) VALUES ('univ-pinecrest','=HYPERLINK("x")','pc:vb',150000,'Appearance','2026-11-10')`);
  const rows = await UB.exportRows(P, 'univ-pinecrest');
  const csv = UB.toCsv(rows);
  ok('the export: every deal and booking, one row each, with a header', rows.filter((r) => r.kind === 'Deal done').length === 1 && rows.filter((r) => r.kind === 'Booked from link').length === 3
    && /^Date,Type,Business,Team,Athlete,Amount \(USD\),What the athletes do,When,Contact\r\n/.test(csv) && /1500\.00/.test(csv), rows);
  ok('  a cell that starts like a formula never runs as one', /"'=HYPERLINK\(""x""\)"/.test(csv) && !/,=HYPERLINK/.test(csv));
  ok('  nothing from another school', !UB.toCsv(await UB.exportRows(P, 'univ-elsewhere')).includes('Harbor'));

  // ── THE DEMO SCHOOL (services/demoSchool) ──────────────────────────────
  const DS = require(REPO + 'server/services/demoSchool.js');
  const d1 = await DS.seed(P), d2 = await DS.seed(P);
  const cnt = async (t) => (await P.query(`SELECT COUNT(*)::int n FROM ${t} WHERE university_id = $1`, [DS.ID])).rows[0].n;
  ok('the demo school seeds, and seeding again rewrites it rather than doubling it', d1.ok && d2.ok && (await cnt('university_teams')) === d2.teams && (await cnt('university_drafts')) === d2.cards
    && (await cnt('university_bookings')) === 2 && (await cnt('university_deals')) === 4, d2);
  const dToday = await require(REPO + 'server/services/universityToday.js').today(P, DS.ID);
  ok('  its morning: pitches waiting, deals paid, every team listed', dToday.leads.waiting === 8 && dToday.deals.cents === 570000 && dToday.teams.length === 12, { leads: dToday.leads, deals: dToday.deals });
  const draftsDemo = (await P.query(`SELECT body FROM university_drafts WHERE university_id = $1`, [DS.ID])).rows;
  ok('  its pitches are paid NIL deals with the booking link, never sponsorship', draftsDemo.every((r) => /paid NIL deal/.test(r.body) && /\/book\/pinecrest-demo\?t=/.test(r.body) && !TW.SPONSORSHIP.test(r.body)));
  ok('  made-up contacts only: .example addresses and 555 numbers', (await P.query(`SELECT contact_email, contact_phone FROM university_drafts WHERE university_id = $1`, [DS.ID])).rows.every((r) => /\.example$/.test(r.contact_email) && /^\(555\)/.test(r.contact_phone)));
  ok('  and the nightly run never picks it', /AND u\.id NOT LIKE '%-demo'/.test(fs.readFileSync(REPO + 'server/services/campusNightly.js', 'utf8')));

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, university_id, plan_tier) VALUES ('bk-staff','Riley Office','bk-staff@book.test',$1,'university','univ-pinecrest','unlimited')`, [hash]);
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'book-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off',
      RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const pageRes = await fetch(base + '/book/pinecrest');
    ok('GET /book/pinecrest is the page, no sign-in', pageRes.status === 200 && /Book our athletes for your business/.test(await pageRes.text()));
    const api = await (await fetch(base + '/api/book/pinecrest')).json();
    ok('  its data, public', api.school.short === 'Pinecrest' && api.teams.length === 2);
    ok('  a made-up school is a 404', (await fetch(base + '/api/book/nope')).status === 404);
    const post = await fetch(base + '/api/book/pinecrest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business: 'Magnolia Coffee', name: 'Jo Lane', email: 'jo@magnolia.test', teamId: 'pc:vb', dates: 'Any weekday' }) });
    ok('  a business books over HTTP', post.status === 200 && (await post.json()).ok);
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bk-staff@book.test', password: PASS }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const call = (m, p, body) => fetch(base + p, { method: m, headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const list = await (await call('GET', '/api/university/market/bookings')).json();
    ok('staff see their link and the bookings, Magnolia first', list.url === 'https://mynildash.com/book/pinecrest' && list.bookings[0].business === 'Magnolia Coffee' && list.bookings.length === 4, list);
    ok('  each booking carries its deal summary, and the marketplace link comes with the list', /Business \(pays the athletes\): Magnolia Coffee/.test(list.bookings[0].summary)
      && list.marketplace && list.marketplace.name === 'Opendorse');
    const setMp = await call('POST', '/api/university/market/marketplace', { name: 'INFLCR', url: 'https://inflcr.example.com/pinecrest' });
    ok('  staff set the marketplace over HTTP', setMp.status === 200 && (await (await fetch(base + '/api/book/pinecrest')).json()).marketplace.name === 'INFLCR');
    const ex = await call('GET', '/api/university/market/deals-export.csv');
    const exText = await ex.text();
    ok('  the CSV downloads', ex.status === 200 && /text\/csv/.test(ex.headers.get('content-type')) && /attachment; filename="nildash-deals\.csv"/.test(ex.headers.get('content-disposition')) && /Magnolia Coffee/.test(exText));
    ok('  and is not public', [401, 403].includes((await fetch(base + '/api/university/market/deals-export.csv')).status));
    const qr = await call('GET', '/api/university/market/booking-qr.svg');
    ok('  the QR code is an SVG', qr.status === 200 && /image\/svg\+xml/.test(qr.headers.get('content-type')) && /<svg/.test(await qr.text()));
    const seen = await call('POST', '/api/university/market/booking/status', { id: list.bookings[0].id, status: 'seen' });
    ok('  "Got it" marks one seen', seen.status === 200 && (await (await call('GET', '/api/university/market/bookings?status=new')).json()).bookings.length === 3);
    const signedInPage = await call('GET', '/api/book/pinecrest');
    ok('  a signed-in staff member can open their own booking page (the wall lets it through)', signedInPage.status === 200);
    const anon = await fetch(base + '/api/university/market/bookings');
    ok('the office\'s list is not public', anon.status === 401 || anon.status === 403, anon.status);
  } finally { srv.kill(); }

  // ── THE PAGES ──────────────────────────────────────────────────────────
  const book = fs.readFileSync(REPO + 'public/book.html', 'utf8');
  ok('the booking page says NILDash never signs or negotiates, and the school pays the players', /NILDash does not sign or negotiate deals/.test(book) && /pays the players/.test(book));
  ok('  a hidden field for bots, no em dashes', /id="website"/.test(book) && !/[—]/.test(book));
  ok('  after booking, the business is sent to the school\'s marketplace when one is set', /set up your business on \$\{esc\(mp\.name\)\}/.test(book) && /href="\$\{esc\(mp\.url\)\}" target="_blank" rel="noopener"/.test(book));
  const portal = fs.readFileSync(REPO + 'public/university.html', 'utf8');
  ok('Today: copy a deal summary, set the marketplace, download every deal', /Copy deal summary/.test(portal) && /Your NIL marketplace/.test(portal) && /deals-export\.csv/.test(portal) && /data-mpsave/.test(portal));
  ok('Today shows new bookings, the link and the QR download', /New bookings \(/.test(portal) && /Your booking link/.test(portal) && /booking-qr\.svg\?download=1/.test(portal));
  ok('  and greets by the time of day, never by name when viewing as admin', /hr < 12 \? "Morning" : hr < 17 \? "Afternoon" : "Evening"/.test(portal) && /viewingAsAdmin \? "" :/.test(portal));
  const svc = fs.readFileSync(REPO + 'server/services/universityBook.js', 'utf8').replace(/\/\/.*$/gm, '');
  const tables = [...svc.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase()).filter((t) => !['if', 'set', 'your', 'the', 'link'].includes(t));   // 'DO UPDATE SET', 'from your link'
  ok('only university tables', tables.every((t) => /^university_|^universities$/.test(t)), [...new Set(tables)]);

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
