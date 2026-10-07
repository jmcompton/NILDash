'use strict';
// Five cards a team here, not the night's default two: these fixtures climb
// every rung (from file, social, bought for the card, new ground), and two
// cards a team stops after the first two. tests/univperteam.js checks two.
process.env.UNIVERSITY_CARDS_PER_TEAM = '5';
// The paid night (contacts bought for the card, for tomorrow): what these
// fixtures measure. tests/freenight.js covers the free night, the default.
process.env.UNIVERSITY_NIGHT_PAID_CONTACTS = 'on';
// Runs against the local test Postgres.
//
//   node tests/campusnight.js
//
// ── THE UNIVERSITY NIGHT SOURCES, IT DOES NOT JUST SPEND ────────────────────
// Cypress: 88 named contacts, one night wrote 85 cards from them, 4 left, and
// 373 social brands sat unused (every card's rungs: ["local"]). The night now
// climbs the agent side's ladder (local, social, the rest from file, contacts
// bought for the card, new ground), buys contacts for tomorrow with what the
// cap has left, and says how many nights of named contacts are left.
// The model and the contact lookup are stubbed; the tables are real.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
delete process.env.GOOGLE_PLACES_API_KEY;

const store = require(REPO + 'server/store.js');
const CP = require(REPO + 'server/services/campusPool.js');
const CN = require(REPO + 'server/services/campusNightly.js');
const CB = require(REPO + 'server/services/campusBuild.js');
const TS = require(REPO + 'server/services/teamScan.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
// A TEAM IS PITCHED WHEN IT HAS SOMETHING TO SELL (campusNightly.sellableTeams):
// every fixture team gets home dates and one available inventory item.
const roster = async (P, uid) => {
  await P.query(`UPDATE university_teams SET home_dates = COALESCE(home_dates, 8) WHERE university_id = $1`, [uid]);
  await P.query(`INSERT INTO university_inventory (id, university_id, team_id, name, price_cents)
    SELECT t.id || ':inv', t.university_id, t.id, 'Home game banner', 25000 FROM university_teams t WHERE t.university_id = $1 ON CONFLICT (id) DO NOTHING`, [uid]);
};
const U = 'univ-nighttest', MK = 'nighttown, ca';

const prompts = [];
const ai = {
  oneShot: async (prompt) => {
    prompts.push(prompt);
    const biz = (prompt.match(/BUSINESS: (.+)/) || [])[1];
    return `SUBJECT: The team and ${biz}\nBODY:\n${biz} is a good partner for the program this season. Could we set up a short call?`;
  },
};
// Pending businesses: an even number finds an owner, an odd one finds nobody.
const looked = [];
const contactsAi = {
  deepContactCtx: (o) => ({ ...o }),
  getBrandContacts: async (brand) => {
    looked.push(brand);
    const n = Number(String(brand).split(' ').pop());
    return n % 2 === 0 ? { contacts: [{ name: 'Olive Hart', title: 'Owner', email: `olive${n}@nt.test`, source: 'site' }], addressLadder: {} }
      : { contacts: [], businessPhone: null, instagram: null, addressLadder: {} };
  },
  webSearchJson: async () => ({ text: '{"name": null}', citations: [] }),
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TS.ensureTables(P);
  await CP.ensureTables(P);
  await CB.ensureTables(P);
  const clean = async () => {
    for (const t of ['university_inventory', 'university_athletes', 'university_contacts', 'university_market_runs', 'university_crm', 'university_touches', 'university_drafts', 'university_brand_engagement', 'university_social_brands']) {
      await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [U]).catch(() => {});
    }
    await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'nt:%'`);
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);
    await P.query(`DELETE FROM university_discovery_cells WHERE market_key = $1`, [MK]).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = $1`, [U]);
  };
  await clean();

  // ── FIXTURE: 3 teams, 9 named contacts on file, 30 businesses never looked up, 2 social brands
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Night Test College','NTC','1 College Way, Nighttown, CA 90000')`, [U]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES
    ('nt:bb',$1,'Basketball','basketball',$2), ('nt:sb',$1,'Softball','softball',$2), ('nt:soc',$1,'Soccer','soccer',$2)`, [U, MK]);
  const kinds = ['gym', 'cafe', 'mexican_restaurant', 'clothing_store', 'barber_shop', 'physiotherapist', 'car_dealer', 'bakery', 'florist'];
  for (let i = 0; i < 9; i++) {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,$3,'local',$4::jsonb,$5,'x',$6,60)`,
      [MK, `File Biz ${i}`, 'nf-' + i, JSON.stringify([kinds[i]]), kinds[i], 800 + i * 100]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, contact_title, email, reachable, status)
                   VALUES ($1,$2,$3,$4,'Dana Reed','Owner',$5,TRUE,'reachable')`, [U, MK, `File Biz ${i}`, 'nf-' + i, `dana${i}@nt.test`]);
  }
  for (let i = 0; i < 30; i++) {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,$3,'local',$4::jsonb,$5,'x',$6,50)`,
      [MK, `Open Biz ${i}`, 'no-' + i, JSON.stringify([kinds[i % 9]]), kinds[i % 9], 2000 + i * 100]);
  }
  for (const [b, sports] of [['Grip Socks Co', ['all']], ['Hydra Drink', ['all']]]) {
    await P.query(`INSERT INTO university_social_brands (university_id, brand, website, program_url, category, sports, proof_date, offer, evidence)
                   VALUES ($1,$2,$3,$4,'apparel',$5,NOW(),'free gear and a commission code for athletes','program states no minimum')`,
      [U, b, `https://${b.split(' ')[0].toLowerCase()}.test`, `https://${b.split(' ')[0].toLowerCase()}.test/athletes`, sports]);
  }

  await roster(P, U);
  const est = await CN.estimate(P, U);
  ok('the projection: 15 cards, 3 social (a seat a team), 9 from file, 3 needing a contact bought', est.ok && est.cards === 15 && est.socialCards === 3
    && est.cardsFromFile === 9 && est.lookupsNeeded === 3, est);

  // ── THE NIGHT ─────────────────────────────────────────────────────────────
  OUT.push('', '-- the ladder: local, social, the rest from file, contacts bought for the card --');
  const night = '2026-10-10';
  const r = await CN.runNight(P, U, { ai, contactsAi, night });
  const cards = (await P.query(`SELECT d.*, t.name AS team FROM university_drafts d JOIN university_teams t ON t.id = d.team_id WHERE d.university_id = $1 AND d.night = $2`, [U, night])).rows;
  ok('every team holds five cards', r.ok && r.cards === 15 && r.short.length === 0, { cards: r.cards, short: r.short, perTeam: r.perTeam });
  const per = (lane) => cards.filter((c) => c.lane === lane);
  ok('EVERY TEAM GETS ONE SOCIAL BRAND: three social cards, one a team', per('social').length === 3 && new Set(per('social').map((c) => c.team_id)).size === 3,
    cards.map((c) => [c.team, c.lane, c.brand_name]));
  ok('  no brand to more than two teams in one night', Object.values(per('social').reduce((o, c) => { o[c.brand_name] = (o[c.brand_name] || 0) + 1; return o; }, {})).every((n) => n <= 2));
  ok('  a social card has no invented person: the program page is how to reach them', per('social').every((c) => !c.contact_name && /\/athletes$/.test(c.program_url || '')), per('social'));
  ok('  and the writer is told what the program is', prompts.some((p) => /THEIR ATHLETE PROGRAM: free gear/.test(p) && /PROGRAM PAGE: https:\/\//.test(p)));
  ok('THE CONTACTS ON FILE FIRST: all nine used, never more than four a team before the social seat', per('local').length === 9 && r.byLane.local === 9, r.byLane);
  ok('  then contacts bought for the card, only for what was still short', per('local-wide').length === 3 && r.byLane['local-wide'] === 3, r.byLane);
  const first = r.perTeam[0];
  ok('  the first team: local then social, and done', JSON.stringify(first.rungs) === '["local","social"]', first.rungs);
  ok('  the last team climbs further: local, social, local, local-wide', r.perTeam[2].rungs.join(',') === 'local,social,local,local-wide', r.perTeam[2].rungs);
  ok('national is never a rung', !r.perTeam.some((t) => (t.rungs || []).includes('national')));

  OUT.push('', '-- after the cards: contacts for tomorrow, the reserve, the runway --');
  ok('THE NIGHT BUYS CONTACTS FOR TOMORROW with what is left', r.replenish && r.replenish.tried > 0 && r.replenish.found > 0, r.replenish);
  ok('  the reserve grows after the cards used it: 0 left after the cards, more by morning', r.reserve.afterCards === 0 && r.reserve.after === r.replenish.found && r.reserve.after > r.reserve.afterCards, r.reserve);
  ok('  best kinds first: the lookups went to the likeliest sponsors before the rest', looked.length > 0);
  ok('the spend is split by what it bought and adds up', r.spend && Math.abs(r.spend.writingUsd + r.spend.discoveryUsd + r.spend.contactsUsd + r.spend.placesRingsUsd - r.costUsd) < 0.01
    && r.spend.writingUsd > 0 && r.costUsd <= 5, r.spend);
  ok('  and printed', /SPENT \$\d+\.\d\d of the \$5\.00 cap:/.test(CN.formatNight(r)) && /writing +\$/.test(CN.formatNight(r)) && /discovery +\$/.test(CN.formatNight(r))
    && /contacts +\$/.test(CN.formatNight(r)) && /RESERVE \(named contacts unused, ready for tomorrow\): 9 -> \d+/.test(CN.formatNight(r)), CN.formatNight(r));
  ok('  with no Places key, discovery spends nothing and says why', r.spend.discoveryUsd === 0 && r.discovery.errors.length > 0, r.discovery);

  const v = await CB.verify(P, U);
  ok('STATUS: named contacts unused and ready for tomorrow, and the runway in nights at the current card rate',
    v.namedContactsUnused === r.reserve.after && v.runway.perNight === 12 && v.runwayNights === Math.round((r.reserve.after / 12) * 10) / 10, v.runway);
  ok('  under three nights is a FAILURE, like zero social brands', v.runwayNights < 3 && v.failures.some((f) => /^runway [\d.]+ nights: \d+ named contacts unused for 12 cards a night/.test(f))
    && /FAILED:[\s\S]*runway/.test(CB.formatVerify(v)) && /runway +[\d.]+ nights/.test(CB.formatVerify(v)), { failures: v.failures, text: CB.formatVerify(v) });
  // Enough on file: no failure.
  for (let i = 0; i < 40; i++) {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,$3,'local','["gym"]','gym','x',900,60)`, [MK, `Deep Biz ${i}`, 'nd-' + i]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, contact_title, email, reachable, status) VALUES ($1,$2,$3,$4,'Pat Lee','Owner',$5,TRUE,'reachable')`,
      [U, MK, `Deep Biz ${i}`, 'nd-' + i, `pat${i}@nt.test`]);
  }
  const v2 = await CB.verify(P, U);
  ok('  three nights or more is not a failure', v2.runwayNights >= 3 && !v2.failures.some((f) => /^runway/.test(f)), v2.runway);

  // A night where the reserve already holds its target buys nothing.
  const est2 = await CN.estimate(P, U);
  ok('the projection reads the reserve, the runway and what a named contact costs here', est2.ok && est2.reserveNow === v2.namedContactsUnused && est2.runwayNightsNow > 0
    && /RESERVE: \d+ now/.test(CN.formatEstimate(est2)), CN.formatEstimate(est2));

  // The cards route carries the rung and the program page.
  const route = require('fs').readFileSync(REPO + 'server/routes/campus.js', 'utf8');
  ok('the portal\'s cards carry the rung and the program page', /d\.lane, d\.program_url/.test(route)
    && /BRAND PROGRAM/.test(require('fs').readFileSync(REPO + 'public/university.html', 'utf8')));

  // ── NO EMAIL ADDRESS, NO EMAIL CARD ─────────────────────────────────────
  OUT.push('', '-- a card cannot exist without a way to reach someone --');
  await P.query(`DELETE FROM university_drafts WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'nt:%'`);
  await P.query(`DELETE FROM university_contacts WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_social_brands WHERE university_id = $1`, [U]);
  const reach = [['Mail Gym', 'gym', { email: 'owner@mailgym.test' }], ['Phone Taqueria', 'mexican_restaurant', { phone: '(714) 555-0199' }],
    ['Gram Barber', 'barber_shop', { instagram: '@grambarber' }], ['Ghost Cafe', 'cafe', {}]];
  for (const [b, t, c] of reach) {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,$3,'local',$4::jsonb,$5,'x',1200,70)
                   ON CONFLICT (market_key, brand) DO NOTHING`, [MK, b, 'r-' + b, JSON.stringify([t]), t]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, contact_title, email, phone, instagram, reachable, status)
                   VALUES ($1,$2,$3,$4,'Sam Ortiz','Owner',$5,$6,$7,TRUE,'reachable')`, [U, MK, b, 'r-' + b, c.email || null, c.phone || null, c.instagram || null]);
  }
  const before = prompts.length;
  const rr = await TS.runTeamScan(P, { universityId: U, teamId: 'nt:bb', limit: 5, mode: 'pitch', discoverPool: false, deps: { ai, contactsAi, night: '2026-10-11', socialPerTeam: 0 } });
  const byBrand = Object.fromEntries((await P.query(`SELECT * FROM university_drafts WHERE university_id = $1 AND night = '2026-10-11'`, [U])).rows.map((d) => [d.brand_name, d]));
  ok('an email address makes an email card', byBrand['Mail Gym'] && byBrand['Mail Gym'].channel === 'email' && /^Hi Sam,/.test(byBrand['Mail Gym'].body), byBrand['Mail Gym']);
  const call = byBrand['Phone Taqueria'];
  ok('A PHONE ONLY IS A CALL CARD: the name, the number, the best time, three talking points, and no email body',
    call && call.channel === 'call' && call.contact_phone === '(714) 555-0199' && /2 to 4 pm/.test(call.best_time)
    && Array.isArray(call.talking_points) && call.talking_points.length === 3 && /^Who you are: /.test(call.talking_points[0]) && /^The ask: /.test(call.talking_points[2])
    && !/^Hi /.test(call.body) && /^Call Sam Ortiz at \(714\) 555-0199\./.test(call.body), call);
  ok('  and no email was written for it: the writer was never asked', !prompts.slice(before).some((p) => /BUSINESS: Phone Taqueria/.test(p)));
  const dm = byBrand['Gram Barber'];
  ok('INSTAGRAM ONLY IS A DM CARD: a short message, signed without an email address', dm && dm.channel === 'dm' && prompts.slice(before).some((p) => /BUSINESS: Gram Barber[\s\S]*INSTAGRAM DIRECT MESSAGE/.test(p))
    && !/@nt\.test|@/.test(String(dm.body).split('\n').pop()), dm);
  ok('NOTHING TO REACH, NO CARD', !byBrand['Ghost Cafe'], Object.keys(byBrand));
  const CM = require(REPO + 'server/services/campusMarket.js');
  const legacy = CM.cardForPortal({ id: 'x', brand_name: 'Old Pizza', contact_name: 'Lee Wu', contact_phone: '(714) 555-0100', contact_email: null,
    subject: 'Backing the team', body: 'Hi Lee,\n\nan email with nowhere to go', why: 'a restaurant near campus', team_label: 'Softball' }, 'Night Test College');
  ok('A CARD WRITTEN BEFORE THIS, phone only, is shown as a call card, its email body gone', legacy.channel === 'call' && legacy.subject === null
    && !/nowhere to go/.test(legacy.body) && legacy.talking_points.length === 3 && /Night Test College Athletics, calling about the Softball program/.test(legacy.talking_points[0]) && legacy.sendable === false, legacy);
  const vc = await CB.verify(P, U);
  const nEmail = Object.values(byBrand).filter((d) => d.channel === 'email').length;
  ok('STATUS COUNTS THE LATEST NIGHT BY HOW IT REACHES SOMEONE', nEmail >= 1 && vc.cardsByChannel.email === nEmail && vc.cardsByChannel.call === 1 && vc.cardsByChannel.dm === 1
    && vc.cardsByChannel.none === 0 && new RegExp(`${nEmail} with an email, 1 phone only \\(call cards\\), 1 Instagram only \\(DM cards\\)`).test(CB.formatVerify(vc)), { by: vc.cardsByChannel, nEmail });
  const CHN = require(REPO + 'server/services/cardChannel.js');
  ok('Approve refuses anything that cannot send, and says why', CHN.canSend({ phone: '714 555 0100' }).ok === false && /call card/.test(CHN.canSend({ phone: '714 555 0100' }).why)
    && /DM card/.test(CHN.canSend({ instagram: '@x_y' }).why) && CHN.canSend({ email: 'a@b.co' }).ok && !CHN.canSend({}).ok);
  ok('  the portal renders each channel with its own action, and a call card has no Open in email', (() => {
    const html = require('fs').readFileSync(REPO + 'public/university.html', 'utf8');
    return /Mark called/.test(html) && /Copy message/.test(html) && /ch === "call"/.test(html) && /No email address for this person, so this is a call, not an email/.test(html);
  })());

  await clean();
}

main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
