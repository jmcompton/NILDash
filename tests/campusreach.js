'use strict';
//   node tests/campusreach.js
//
// ── FREE FIRST, AND EVERY WAY TO REACH THEM ON EVERY CARD ───────────────────
// Cypress: 46 named people without an email, 30 with a website nobody opened;
// 66 Instagram handles and zero DM cards. The free steps (Places details, the
// website, the Instagram link) run before any paid lookup; a shared inbox is a
// send path; every card with a handle carries a DM; no person, no card.
// Places, the website reader, Instagram and the model are stubbed; the tables are real.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const CP = require(REPO + 'server/services/campusPool.js');
const CC = require(REPO + 'server/services/campusContacts.js');
const TS = require(REPO + 'server/services/teamScan.js');
const CR = require(REPO + 'server/services/campusReach.js');
const QC = require(REPO + 'server/services/campusQuality.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const U = 'univ-reachtest', MK = 'reachtown, ca';

// The stubs.
const SITES = {
  'https://joes-gym.test': { personalEmail: 'joe@joes-gym.test', roleEmail: 'info@joes-gym.test', people: [], outcomeKind: 'found' },
  'https://tacos.test': { personalEmail: null, roleEmail: 'hola@tacos.test', people: [], outcomeKind: 'found' },
  'https://quiet.test': { personalEmail: null, roleEmail: null, people: [], outcomeKind: 'fetched-empty' },
  'https://owner-named.test': { personalEmail: 'maria@owner-named.test', roleEmail: null, people: [{ name: 'Maria Lopez', title: 'Owner' }], outcomeKind: 'found' },
  'https://placesfound.test': { personalEmail: 'kim@placesfound.test', roleEmail: null, people: [], outcomeKind: 'found' },
};
const siteCalls = [];
const deps = {
  places: { lookupPlaceById: async (id) => (id === 'pl-places' ? { website: 'https://placesfound.test', phone: '(714) 555-0177' } : null) },
  site: { findSiteEmail: async (w) => { siteCalls.push(w); return SITES[w] || { outcomeKind: 'fetch-failed' }; } },
  ig: { findInstagram: async (w) => (/joes-gym|tacos/.test(w) ? { handle: /joes/.test(w) ? 'joesgym' : 'tacoshop', scope: 'business' } : null) },
};
let ladderCalls = 0;
const contactsAi = {
  deepContactCtx: (o) => ({ ...o }),
  getBrandContacts: async () => { ladderCalls++; return { contacts: [{ name: 'Lee Paid', title: 'Owner', email: 'lee@paid.test', source: 'site' }], addressLadder: {} }; },
  webSearchJson: async () => ({ text: '{"name": null}', citations: [] }),
};
const prompts = [];
const ai = { oneShot: async (p) => { prompts.push(p); const biz = (p.match(/BUSINESS: (.+)/) || [])[1];
  return /INSTAGRAM DIRECT MESSAGE/.test(p) ? `SUBJECT: DM\nBODY:\nThe team trains near ${biz}. Would you back our season? Happy to talk.`
    : `SUBJECT: The team and ${biz}\nBODY:\n${biz} is close to campus and home games bring families past you. Would you like to support the program this season? Could we set up a short call?`; } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TS.ensureTables(P); await CP.ensureTables(P); await QC.ensureColumns(P);
  const clean = async () => {
    for (const t of ['university_contacts', 'university_market_runs', 'university_drafts', 'university_brand_engagement', 'university_crm', 'university_touches']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [U]).catch(() => {});
    await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'rt:%'`);
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);
    await P.query(`DELETE FROM universities WHERE id = $1`, [U]);
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, location) VALUES ($1,'Reach Test College','1 College Way, Reachtown, CA 90000')`, [U]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES ('rt:bb',$1,'Basketball','basketball',$2)`, [U, MK]);
  const biz = async (brand, type, c) => {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,$3,'local',$4::jsonb,$5,'x',1000,70)`,
      [MK, brand, c.place_id || null, JSON.stringify([type]), type]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, contact_title, email, generic_email, phone, instagram, website, reachable, status, withdrawn_reason)
                   VALUES ($1,$2,$3,$4,$5,'Owner',$6,$7,$8,$9,$10,$11,$12,$13)`,
      [U, MK, brand, c.place_id || null, c.name || null, c.email || null, c.generic || null, c.phone || null, c.instagram || null, c.website || null,
        c.reachable !== false, c.reachable === false ? 'unreachable' : 'reachable', c.withdrawn || null]);
  };
  // ── 1. FREE FIRST ─────────────────────────────────────────────────────────
  OUT.push('-- free first, paid last --');
  const city = 'Reachtown, CA';
  const r1 = await CC.freeContact({ brand: 'Joes Gym', website: 'https://joes-gym.test', contact_name: 'Joe Park' }, { city, deps });
  ok('THE WEBSITE ON FILE IS READ: a person\'s address over info@', r1.email === 'joe@joes-gym.test' && r1.genericEmail === 'info@joes-gym.test' && r1.instagram === 'joesgym' && r1.placesCalls === 0, r1);
  const r2 = await CC.freeContact({ brand: 'Places Co', place_id: 'pl-places', contact_name: 'Kim Ito' }, { city, deps });
  ok('  no website on file: Places details gives it, then the site is read', r2.website === 'https://placesfound.test' && r2.email === 'kim@placesfound.test' && r2.phone === '(714) 555-0177' && r2.placesCalls === 1, r2);
  const r3 = await CC.freeContact({ brand: 'Owner Named', website: 'https://owner-named.test' }, { city, deps });
  ok('  no person on file: an owner the website names is the person', r3.person && r3.person.name === 'Maria Lopez' && r3.person.source === 'website', r3.person);
  ladderCalls = 0;
  const o1 = await CC.resolveOne({ brand: 'Joes Gym', website: 'https://joes-gym.test', contact_name: 'Joe Park' }, { city, deps, ai: contactsAi, history: false });
  ok('A NAMED PERSON AND A WAY TO REACH THEM FROM THE FREE STEPS: the paid lookup is never called', ladderCalls === 0 && o1.free === true && o1.reachable && o1.email === 'joe@joes-gym.test', { ladderCalls, o1 });
  const o2 = await CC.resolveOne({ brand: 'Quiet Shop', website: 'https://quiet.test' }, { city, deps, ai: contactsAi, history: false });
  ok('  only when the free steps leave no person or no way to reach them does the paid lookup run', ladderCalls === 1 && o2.free === false && o2.contact_name === 'Lee Paid', { ladderCalls, o2 });

  // ── 2. A SHARED INBOX IS A SEND PATH ─────────────────────────────────────
  OUT.push('', '-- info@ beside a named person is a way to send --');
  await biz('Taco Shop', 'mexican_restaurant', { name: 'Rosa Diaz', generic: 'hola@tacos.test', reachable: false, withdrawn: 'only a shared inbox (hola@tacos.test), no direct address, phone or DM for Rosa Diaz' });
  await QC.recheckContacts(P, { id: U, marketKey: MK });
  const tr = (await P.query(`SELECT reachable, generic_email, email FROM university_contacts WHERE university_id = $1 AND brand = 'Taco Shop'`, [U])).rows[0];
  ok('a named person with only info@ counts again (kept apart, never as their own address)', tr.reachable === true && tr.generic_email === 'hola@tacos.test' && !tr.email, tr);
  await P.query(`DELETE FROM university_contacts WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);

  // ── 3. EVERY WAY TO REACH THEM, ON THE NIGHT'S CARDS ─────────────────────
  OUT.push('', '-- every card: every channel, the DM written wherever there is a handle, a name on both --');
  await biz('Mail And Gram Gym', 'gym', { name: 'Ann Lee', email: 'ann@mag.test', instagram: 'maggym' });
  await biz('Phone And Gram Cafe', 'cafe', { name: 'Ben Ruiz', phone: '(714) 555-0122', instagram: 'pgcafe' });
  await biz('Inbox Taqueria', 'mexican_restaurant', { name: 'Cora Vega', generic: 'hola@inboxtaq.test' });
  await biz('Nameless Barber', 'barber_shop', { email: 'shop@nameless.test' });
  prompts.length = 0;
  await TS.runTeamScan(P, { universityId: U, teamId: 'rt:bb', limit: 5, mode: 'pitch', discoverPool: false, deps: { ai, contactsAi, night: '2026-10-12', socialPerTeam: 0 } });
  const cards = Object.fromEntries((await P.query(`SELECT * FROM university_drafts WHERE university_id = $1 AND night = '2026-10-12'`, [U])).rows.map((d) => [d.brand_name, d]));
  const mg = cards['Mail And Gram Gym'];
  ok('AN EMAIL AND A HANDLE: the email first, the DM written beside it', mg && mg.channel === 'email' && /^Hi Ann,/.test(mg.body) && /^Hi Ann,/.test(mg.dm_text || '') && mg.contact_instagram === 'maggym', mg);
  const pg = cards['Phone And Gram Cafe'];
  ok('A PHONE AND A HANDLE: the call card, and the DM too', pg && pg.channel === 'call' && /^Hi Ben,/.test(pg.dm_text || ''), pg);
  ok('  the DM is short: 2 or 3 sentences, written as a DM', prompts.some((p) => /INSTAGRAM DIRECT MESSAGE[\s\S]*30 to 70 words/.test(p)) && String(mg.dm_text).split(/[.!?]/).filter((x) => x.trim()).length <= 5);
  const it = cards['Inbox Taqueria'];
  ok('A SHARED INBOX IS A SEND PATH: an email card to it, greeting the person by name, marked shared', it && it.channel === 'email' && it.contact_email === 'hola@inboxtaq.test'
    && it.email_is_shared === true && /^Hi Cora,/.test(it.body), it);
  // Free nights (the default): no person found free is still a card, written
  // to the business, and "Find the owner" puts a name on it later.
  const nb = cards['Nameless Barber'];
  ok('NO PERSON YET, STILL A CARD: addressed to the business, to its inbox', nb && nb.channel === 'email' && !nb.contact_name
    && /^Hi Nameless Barber team,/.test(nb.body) && nb.contact_email === 'shop@nameless.test', nb);
  const html = require('fs').readFileSync(REPO + 'public/university.html', 'utf8');
  ok('the portal shows the DM as the second action, with Copy and the Instagram link', /Or on Instagram/.test(html) && /Copy DM/.test(html) && /Mark DM sent/.test(html) && /shared inbox, not/.test(html));
  const home = require('fs').readFileSync(REPO + 'public/index.html', 'utf8');
  ok('  and Home does the same for an agent\'s email and call cards', /function hqDmSecond\(c, i\)/.test(home) && /hqDmSecond\(c, i\)/.test(home.replace('function hqDmSecond(c, i)', '')));

  // ── 4. THE BACKFILL, AND ITS REPORT ──────────────────────────────────────
  OUT.push('', '-- the website scrape across the named people already on file, and the cards brought up to date --');
  await P.query(`DELETE FROM university_drafts WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'rt:%'`);
  await P.query(`DELETE FROM university_contacts WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);
  await biz('Joes Gym', 'gym', { name: 'Joe Park', phone: '(714) 555-0101', website: 'https://joes-gym.test' });
  await biz('Taco Shop', 'mexican_restaurant', { name: 'Rosa Diaz', phone: '(714) 555-0102', website: 'https://tacos.test' });
  await biz('Quiet Shop', 'florist', { name: 'Quinn Ash', phone: '(714) 555-0103', website: 'https://quiet.test' });
  await biz('Places Co', 'clothing_store', { name: 'Kim Ito', phone: '(714) 555-0104', place_id: 'pl-places' });
  await biz('Had Email', 'bakery', { name: 'Hal Bea', email: 'hal@hademail.test', instagram: 'hadgram' });
  await TS.runTeamScan(P, { universityId: U, teamId: 'rt:bb', limit: 5, mode: 'pitch', discoverPool: false, deps: { ai, contactsAi, night: '2026-10-13', socialPerTeam: 0 } });
  await P.query(`UPDATE university_drafts SET dm_text = NULL WHERE university_id = $1`, [U]);   // as last night's cards were: no DMs
  siteCalls.length = 0;
  const dry = await CR.run(P, U, { deps, ai });
  ok('THE DRY RUN READS THE WEBSITES ON FILE (free) and says what it found, writing nothing', dry.ok && !dry.apply && dry.found.ownEmail === 1 && dry.found.sharedInbox === 1
    && dry.found.instagram === 2 && dry.found.placesCalls === 0 && siteCalls.length === 3
    && (await P.query(`SELECT COUNT(*)::int n FROM university_contacts WHERE university_id = $1 AND COALESCE(email,'') <> ''`, [U])).rows[0].n === 1, { found: dry.found, siteCalls });
  const ap = await CR.run(P, U, { deps, ai, apply: true });
  ok('APPLIED: own emails before -> after, and how many came from the websites', ap.before.own_email === 1 && ap.after.own_email === 3 && ap.found.ownEmail === 2 && ap.found.websiteFromPlaces === 1
    && ap.after.any_email === 4, { before: ap.before, after: ap.after, found: ap.found });
  ok('  a card whose person now has an address became an email card, addressed to them by name', ap.rewritten >= 2
    && (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE university_id = $1 AND channel = 'email' AND body LIKE 'Hi %,%'`, [U])).rows[0].n === ap.cardsAfter.email, ap);
  ok('  every card with a handle now carries a DM', ap.cardsAfter.withDm === ap.cardsAfter.withHandle && ap.cardsAfter.withDm >= 3 && ap.cardsBefore.withDm === 0, { before: ap.cardsBefore, after: ap.cardsAfter });
  ok('  the cost, said: website fetches free, Places at list price, the writer per call', ap.usd.websites === 0 && ap.usd.places > 0 && ap.usd.writer > 0
    && /COST: \$\d+\.\d\d -- website fetches \$0\.00, Places details \$/.test(CR.format(ap)), CR.format(ap));
  ok('  and printed with the before and after', /with their own email +1 -> 3/.test(CR.format(ap)) && /own email addresses found +2/.test(CR.format(ap)) && /carry a DM option/.test(CR.format(ap)), CR.format(ap));
  ok('the admin script is registered', /'campus-reach': \{ file: 'scripts\/campus-reach\.js'/.test(require('fs').readFileSync(REPO + 'server/index.js', 'utf8')));
  await clean();
}

main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
