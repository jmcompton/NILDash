'use strict';
// ── WE WERE FINDING THE DATA AND DISCARDING IT ──────────────────────────────
//
// Cypress: 88 businesses with a named person, 42 with an email. Of the 46
// without, 30 had a website on file that nobody had opened; 66 of the 88 had
// an Instagram handle and the night wrote zero DM cards. This applies the
// free steps (campusContacts.freeContact) to the people already on file and
// brings the latest night's cards up to date:
//
//   contacts  for every named person without their own email: the website on
//             file (or the one Places details gives), its mailto links and
//             contact/about/team pages; a person's address first, a shared
//             inbox over nothing; the Instagram handle the site links to.
//             Nothing already on file is overwritten.
//   cards     a card whose person now has an email becomes an email card
//             (written, addressed to them by name); every card whose person
//             has a handle carries a DM (written: short, their name, the team,
//             why, the ask).
//
// dryRun (default): the website and Instagram scrape runs (it is free, plain
// HTTP) and the report says what it found; nothing is written, no Places call
// and no writer call is made. apply: does all of it.

async function counts(pool, uni) {
  return (await pool.query(
    `SELECT COUNT(*)::int AS named,
            COUNT(*) FILTER (WHERE COALESCE(c.email, '') <> '')::int AS own_email,
            COUNT(*) FILTER (WHERE COALESCE(c.email, '') = '' AND COALESCE(c.generic_email, '') <> '')::int AS shared_only,
            COUNT(*) FILTER (WHERE COALESCE(c.email, '') <> '' OR COALESCE(c.generic_email, '') <> '')::int AS any_email,
            COUNT(*) FILTER (WHERE COALESCE(c.website, '') <> '')::int AS website,
            COUNT(*) FILTER (WHERE COALESCE(c.instagram, '') <> '')::int AS instagram,
            COUNT(*) FILTER (WHERE COALESCE(c.email, '') = '' AND COALESCE(c.website, '') <> '')::int AS no_email_with_site
       FROM university_contacts c JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable AND COALESCE(c.contact_name, '') <> ''`, [uni.id])).rows[0];
}

async function cardCounts(pool, uni) {
  const rows = (await pool.query(
    `SELECT channel, lane, contact_email, contact_phone, contact_instagram, program_url, dm_text FROM university_drafts
      WHERE university_id = $1 AND kind = 'pitch' AND night = (SELECT MAX(night) FROM university_drafts WHERE university_id = $1 AND night IS NOT NULL)`, [uni.id])).rows;
  const CHN = require('./cardChannel');
  const out = { cards: rows.length, email: 0, call: 0, dm: 0, program: 0, none: 0, withHandle: 0, withDm: 0 };
  for (const d of rows) {
    const ch = d.channel || CHN.campusChannelOf({ email: d.contact_email, phone: d.contact_phone, instagram: d.contact_instagram, programUrl: d.lane === 'social' ? d.program_url : null, social: d.lane === 'social' });
    out[ch || 'none']++;
    if (CHN.hasHandle(d.contact_instagram)) out.withHandle++;
    if (d.dm_text || ch === 'dm') out.withDm++;
  }
  return out;
}

async function run(pool, universityId, opts = {}) {
  const apply = opts.apply === true;
  const CP = require('./campusPool');
  const CC = require('./campusContacts');
  const TS = require('./teamScan');
  const QC = require('./campusQuality');
  const Q = require('./outreachQueue');
  await CP.ensureTables(pool);
  await TS.ensureTables(pool);
  await QC.ensureColumns(pool);
  const uni = await CP.universityOf(pool, universityId);
  if (!uni) return { ok: false, error: `No university "${universityId}".` };
  const city = TS.cityOf(uni.location) || uni.location;
  // A named person with only a shared inbox counts again (campusQuality).
  if (apply) await QC.recheckContacts(pool, uni).catch(() => {});
  const before = await counts(pool, uni);
  const cardsBefore = await cardCounts(pool, uni);
  const people = (await pool.query(
    `SELECT c.brand, c.place_id, c.website, c.phone, c.instagram, c.contact_name, c.contact_title, c.email, c.generic_email
       FROM university_contacts c JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable AND COALESCE(c.contact_name, '') <> ''
        AND (COALESCE(c.email, '') = '' OR COALESCE(c.instagram, '') = '')
      ORDER BY (COALESCE(c.email, '') = '') DESC, c.brand`, [uni.id])).rows;
  const found = { ownEmail: 0, sharedInbox: 0, instagram: 0, websiteFromPlaces: 0, placesCalls: 0, sites: {}, rows: [] };
  for (const p of people) {
    // Dry run: no Places call (it is not free); the website on file only.
    const row = { brand: p.brand, place_id: apply ? p.place_id : null, website: p.website, phone: p.phone, instagram: p.instagram,
      contact_name: p.contact_name, contact_title: p.contact_title };
    if (!row.website && !row.place_id) continue;
    const f = await CC.freeContact(row, { city, deps: opts.deps }).catch((e) => ({ steps: ['failed: ' + e.message] }));
    found.placesCalls += f.placesCalls || 0;
    if (f.siteOutcome) found.sites[f.siteOutcome] = (found.sites[f.siteOutcome] || 0) + 1;
    const r = { brand: p.brand, person: p.contact_name, steps: f.steps };
    const newOwn = !p.email && f.email && !QC.isGenericInbox(f.email) ? f.email : null;
    const newShared = !p.email && !newOwn && !p.generic_email ? (f.genericEmail || (f.email && QC.isGenericInbox(f.email) ? f.email : null)) : null;
    const newIg = !p.instagram && f.instagram ? f.instagram : null;
    const newSite = !p.website && f.website ? f.website : null;
    if (newOwn) { found.ownEmail++; r.email = newOwn; }
    if (newShared) { found.sharedInbox++; r.sharedInbox = newShared; }
    if (newIg) { found.instagram++; r.instagram = newIg; }
    if (newSite) { found.websiteFromPlaces++; r.website = newSite; }
    if (apply && (newOwn || newShared || newIg || newSite)) {
      await pool.query(
        `UPDATE university_contacts SET email = COALESCE(NULLIF(email, ''), $3), generic_email = COALESCE(NULLIF(generic_email, ''), $4),
                instagram = COALESCE(NULLIF(instagram, ''), $5), website = COALESCE(NULLIF(website, ''), $6),
                email_source = CASE WHEN COALESCE(email, '') = '' AND $3::text IS NOT NULL THEN 'website' ELSE email_source END, updated_at = NOW()
          WHERE university_id = $1 AND brand = $2`, [uni.id, p.brand, newOwn, newShared, newIg, newSite]);
    }
    if (newOwn || newShared || newIg || newSite) found.rows.push(r);
  }
  // ── THE LATEST NIGHT'S CARDS, BROUGHT UP TO DATE ──────────────────────────
  let rewritten = 0, dmsWritten = 0, writerCalls = 0;
  if (apply) {
    const TW = require('./teamWriter');
    const CHN = require('./cardChannel');
    const sender = await require('./campusMarket').defaultSender(pool, uni.id).catch(() => null);
    const cards = (await pool.query(
      `SELECT d.*, c.email AS c_email, c.generic_email AS c_shared, c.instagram AS c_ig, c.contact_name AS c_name,
              m.category, m.primary_type_label, m.address, m.distance_m, m.rating, m.user_ratings_total,
              t.id AS t_id, t.name AS t_name, t.sport AS t_sport, t.season AS t_season, t.venue AS t_venue, t.home_dates AS t_home, t.roster_size AS t_roster
         FROM university_drafts d
         LEFT JOIN university_contacts c ON c.university_id = d.university_id AND c.brand = d.brand_name
         LEFT JOIN university_market_seen m ON m.market_key = $2 AND m.brand = d.brand_name
         LEFT JOIN university_teams t ON t.id = d.team_id
        WHERE d.university_id = $1 AND d.kind = 'pitch' AND COALESCE(d.lane, '') <> 'social' AND d.sent_at IS NULL
          AND d.night = (SELECT MAX(night) FROM university_drafts WHERE university_id = $1 AND night IS NOT NULL)`, [uni.id, uni.marketKey])).rows;
    for (const d of cards) {
      const name = d.contact_name || d.c_name;
      if (!name || !d.t_id) continue;
      const team = { id: d.t_id, name: d.t_name, sport: d.t_sport, season: d.t_season, venue: d.t_venue, home_dates: d.t_home, roster_size: d.t_roster };
      const business = { brand_name: d.brand_name, category: d.category, kindLabel: d.primary_type_label, address: d.address, distance_m: d.distance_m,
        rating: d.rating, user_ratings_total: d.user_ratings_total };
      const ctx = { university: uni, team, business, contactName: name, sender };
      const sendTo = d.contact_email || d.c_email || d.c_shared || null;
      const ch = d.channel || CHN.campusChannelOf({ email: d.contact_email, phone: d.contact_phone, instagram: d.contact_instagram, brand: d.brand_name, city: require('./teamScan').cityOf(uni.location) });
      // A card whose person now has an address becomes an email card.
      if (ch !== 'email' && sendTo) {
        writerCalls++;
        const w = await TW.writeAsk(ctx, { ai: opts.ai });
        if (w.ok) {
          await pool.query(`UPDATE university_drafts SET channel = 'email', subject = $2, body = $3, contact_email = $4, email_is_shared = $5, updated_at = NOW() WHERE id = $1`,
            [d.id, w.subject, w.body, sendTo, !(d.contact_email || d.c_email)]);
          rewritten++;
        }
      }
      // Every card with a handle carries the DM.
      // Never a brand-wide account's DM (cardChannel.campusHandle).
      const ig = CHN.campusHandle({ instagram: d.contact_instagram || d.c_ig, brand: d.brand_name, city: require('./teamScan').cityOf(uni.location) });
      if (!d.dm_text && CHN.hasHandle(ig)) {
        writerCalls++;
        const w = await TW.writeAsk({ ...ctx, dm: true }, { ai: opts.ai });
        if (w.ok) {
          await pool.query(`UPDATE university_drafts SET dm_text = $2, contact_instagram = COALESCE(NULLIF(contact_instagram, ''), $3), updated_at = NOW() WHERE id = $1`,
            [d.id, w.body, String(ig).replace(/^@/, '')]);
          dmsWritten++;
        }
      }
    }
    await QC.ensureCapped(pool, uni, { force: true }).catch(() => {});
  }
  const after = apply ? await counts(pool, uni) : null;
  const cardsAfter = apply ? await cardCounts(pool, uni) : null;
  const usd = { places: Math.round(found.placesCalls * Q.USD_PER_PLACES_REQUEST * 100) / 100, writer: Math.round(writerCalls * Q.USD_PER_AI_CALL * 100) / 100, websites: 0 };
  return { ok: true, apply, university: uni.name, id: uni.id, checked: people.length, before, after, found, cardsBefore, cardsAfter,
    rewritten, dmsWritten, writerCalls, usd, totalUsd: Math.round((usd.places + usd.writer) * 100) / 100 };
}

function format(r) {
  if (!r.ok) return r.error;
  const b = r.before, a = r.after, f = r.found;
  const L = [`${r.apply ? 'APPLIED' : 'DRY RUN (the website scrape ran; nothing written, no Places or writer call; apply=1 to do it)'}: ${r.university}`,
    '', `NAMED PEOPLE: ${b.named}${a && a.named !== b.named ? ` -> ${a.named}` : ''}`,
    `  with their own email           ${b.own_email}${a ? ` -> ${a.own_email}` : ` -> ${b.own_email + f.ownEmail} if applied`}`,
    `  a shared inbox only (info@)    ${b.shared_only}${a ? ` -> ${a.shared_only}` : ` -> ${b.shared_only + f.sharedInbox} if applied`}`,
    `  any email to send to           ${b.any_email}${a ? ` -> ${a.any_email}` : ` -> ${b.any_email + f.ownEmail + f.sharedInbox} if applied`}`,
    `  with an Instagram handle       ${b.instagram}${a ? ` -> ${a.instagram}` : ` -> ${b.instagram + f.instagram} if applied`}`,
    '', `FROM THE WEBSITES (${r.checked} people without an email or a handle checked):`,
    `  own email addresses found      ${f.ownEmail}`, `  shared inboxes found           ${f.sharedInbox}`, `  Instagram handles found        ${f.instagram}`,
    `  websites found by Places       ${f.websiteFromPlaces}${r.apply ? '' : ' (Places is not called on a dry run)'}`,
    `  sites: ${Object.entries(f.sites).map(([k, v]) => `${v} ${k}`).join(', ') || 'none read'}  (fetch-failed / js-rendered: we could not read the page; fetched-empty: we read it and there was no address)`];
  L.push('', `CARDS, LATEST NIGHT: ${r.cardsBefore.cards}`,
    `  before: ${r.cardsBefore.email} email, ${r.cardsBefore.call} call, ${r.cardsBefore.dm} DM, ${r.cardsBefore.program} program; ${r.cardsBefore.withDm} carry a DM option (${r.cardsBefore.withHandle} have a handle)`);
  if (r.cardsAfter) L.push(`  after:  ${r.cardsAfter.email} email, ${r.cardsAfter.call} call, ${r.cardsAfter.dm} DM, ${r.cardsAfter.program} program; ${r.cardsAfter.withDm} carry a DM option`,
    `  ${r.rewritten} rewritten as email cards, ${r.dmsWritten} DMs written`);
  L.push('', `COST: $${r.totalUsd.toFixed(2)} -- website fetches $0.00, Places details $${r.usd.places.toFixed(2)} (${r.found.placesCalls} calls at list price; cached answers cost nothing), writer $${r.usd.writer.toFixed(2)} (${r.writerCalls} calls)`);
  if (f.rows.length) { L.push('', 'FOUND:'); for (const x of f.rows.slice(0, 60)) L.push(`  ${String(x.brand).slice(0, 36).padEnd(36)} ${x.person || ''}: ${[x.email && 'email ' + x.email, x.sharedInbox && 'inbox ' + x.sharedInbox, x.instagram && '@' + x.instagram, x.website && 'site ' + x.website].filter(Boolean).join(', ')}`); }
  return L.join('\n');
}

module.exports = { run, format, counts, cardCounts };
