#!/usr/bin/env node
'use strict';
// scripts/seed-queue.js — put real cards in the morning queue RIGHT NOW, using
// only what is already cached. No lookups, no model calls, no spend.
//
//   railway run node scripts/seed-queue.js --athlete "Marcus Johnson" --dry-run
//   railway run node scripts/seed-queue.js --athlete "Marcus Johnson"
//
// WHY A SCRIPT AND NOT HAND-WRITTEN SQL. The card has rules that live in code:
// a national brand handle is never a DM, a Tier 2 contact must carry its source
// note, and there is no email field. Hand-rolled INSERTs would satisfy the schema
// and violate all three, and the page would render something the product does not
// actually promise. This builds every card through the SHIPPED buildCard, so a
// seeded card and a job-built card are the same object.
//
// STRICTLY CACHE-ONLY. Candidates come from brand_evidence_cache rows that already
// exist; a business with no cached contacts is skipped and named, never looked up.
// The nightly job stays the only thing that ever spends.

const store = require('../server/store');
const { buildContactLadder } = require('../server/services/contactLadder');
const ai = require('../server/ai');
const Q = require('../server/services/outreachQueue');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : process.argv[i + 1];
}
const DRY = process.argv.includes('--dry-run');
const ATHLETE = arg('athlete', null);
const COUNT = parseInt(arg('count', '3'), 10) || 3;

async function main() {
  if (!ATHLETE) {
    console.error('--athlete "Full Name" is required.');
    process.exit(2);
  }
  const pool = store.pool;

  // 1. The athlete, and the agent who owns them. The agent is taken FROM the
  //    athlete rather than guessed, so a card can never land on someone else's home.
  const a = await pool.query(
    `SELECT id, agent_id, data->>'name' AS name FROM athletes
      WHERE data->>'name' ILIKE $1 AND agent_id IS NOT NULL ORDER BY created_at ASC LIMIT 1`,
    ['%' + ATHLETE + '%']);
  if (!a.rows[0]) { console.error('No athlete matching "' + ATHLETE + '" with an agent.'); process.exit(1); }
  const ath = a.rows[0];
  console.log(`athlete  ${ath.name} (${ath.id})`);
  console.log(`agent    ${ath.agent_id}`);

  // 2. Which slots are actually open. Never overwrite a queued card.
  const open = Q.slotsToFill((await pool.query(
    `SELECT slot, state FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`, [ath.id])).rows);
  if (!open.length) { console.log('All three slots already hold a queued card. Nothing to do.'); return; }
  console.log(`slots    open: ${open.join(', ')}`);

  // 3. Businesses this athlete has seen, that already have a CACHED contacts row.
  //    The join is what guarantees no lookup: no cached evidence, no candidate.
  const cands = await pool.query(
    `SELECT be.brand_key, be.brand_name, ec.website, ec.evidence
       FROM brand_engagement be
       JOIN LATERAL (
         SELECT website, evidence FROM brand_evidence_cache
          WHERE lane = 'contacts' AND LOWER(brand) = LOWER(be.brand_name)
            AND evidence->'contacts' IS NOT NULL
            AND jsonb_array_length(evidence->'contacts') > 0
          ORDER BY refreshed_at DESC LIMIT 1
       ) ec ON TRUE
      WHERE be.athlete_id = $1
        AND be.state = 'shown'
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q
                         WHERE q.athlete_id = be.athlete_id AND q.brand_key = be.brand_key)
      ORDER BY be.last_shown_at DESC NULLS LAST
      LIMIT $2`, [ath.id, Math.max(COUNT * 4, 12)]);
  console.log(`cached   ${cands.rows.length} candidate business(es) with contacts already on file\n`);
  if (!cands.rows.length) {
    console.log('Nothing cached for this athlete. Either run a Deal Scan first, or');
    console.log('open AI Outreach on a few cards so the ladder gets cached, then re-run.');
    return;
  }

  let placed = 0;
  for (const c of cands.rows) {
    if (placed >= Math.min(COUNT, open.length)) break;
    const ev = c.evidence || {};
    const res = {
      contacts: ev.contacts || [], notAffiliated: ev.notAffiliated || [],
      genericInbox: ev.genericInbox || null, personalInbox: ev.personalInbox || null,
      businessPhone: ev.businessPhone || null, website: c.website || null,
    };

    // The Instagram handle lives in its own lane, keyed on the domain. Read only.
    let ig = { instagram: null, instagramScope: null };
    if (c.website) {
      const dom = String(c.website).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
      const igr = await pool.query(
        `SELECT evidence FROM brand_evidence_cache WHERE lane = 'instagram' AND brand_key LIKE $1
          ORDER BY refreshed_at DESC LIMIT 1`, [dom + '%']).catch(() => ({ rows: [] }));
      const e = (igr.rows[0] || {}).evidence;
      if (e && e.found !== false && e.handle) ig = { instagram: e.handle, instagramScope: e.scope || 'business' };
    }
    res.instagram = ig.instagram;

    const ladder = buildContactLadder(res, {
      rankOf: ai.contactAuthorityRank, rootDomain: ai.rootDomain,
      category: null, brand: c.brand_name, instagramScope: ig.instagramScope,
    });
    const bar = Q.passesBar(ladder, ig);
    if (!bar.ok) { console.log(`  skip  ${c.brand_name}: ${bar.reason}`); continue; }

    const why = (await pool.query(
      `SELECT reasoning FROM brand_match_scores
        WHERE athlete_id = $1 AND LOWER(brand_name) = LOWER($2) ORDER BY created_at DESC LIMIT 1`,
      [ath.id, c.brand_name]).catch(() => ({ rows: [] }))).rows[0];

    const card = Q.buildCard({
      brandKey: c.brand_key, brand: c.brand_name,
      rationale: (why && why.reasoning) || null, athleteName: ath.name,
    }, ladder, ig);

    const slot = open[placed];
    console.log(`  ${DRY ? 'DRY ' : 'ADD '} slot ${slot}  ${card.brandName}  [${card.channel}]  `
      + `${card.contactName || 'no name'}${card.instagram ? ' @' + card.instagram : ''}`
      + `${card.instagramScope === 'brand' ? ' (brand acct)' : ''}`);
    if (!DRY) {
      const ins = await pool.query(
        `INSERT INTO outreach_queue
           (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title,
            source_note, affiliation_scope, instagram, instagram_scope, phone, phone_ask_for,
            dm_text, channel, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued')
         ON CONFLICT DO NOTHING RETURNING id`,
        [ath.agent_id, ath.id, slot, card.brandKey, card.brandName, card.why, card.contactName,
         card.contactTitle, card.sourceNote, card.affiliationScope, card.instagram,
         card.instagramScope, card.phone, card.phoneAskFor, card.dmText, card.channel]);
      if (!ins.rowCount) { console.log('        (slot taken by a concurrent write, skipped)'); continue; }
    }
    placed++;
  }

  console.log(`\n${DRY ? 'Would place' : 'Placed'} ${placed} card(s).`);
  if (!DRY && placed) console.log('Reload the home page — the queue sits under "Do this first".');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[seed-queue] ' + e.message);
  process.exit(1);
});
