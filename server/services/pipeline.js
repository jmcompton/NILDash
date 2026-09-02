'use strict';
// ── THE PIPELINE, AND THE ONLY PLACE ITS STAGES ARE NAMED ───────────────────
//
// Before this there were four vocabularies for one concept:
//
//   the Pipeline board   Prospecting / Outreach Sent / Negotiating / Closing / Closed
//   athlete_self_deals   Prospect / Pitched / In Talks / Agreed / Contract
//   the athlete send     wrote 'Contacted', which an init-time remap then renamed
//                        to 'Pitched' -- so a row's stage depended on whether the
//                        server had rebooted since it was written
//   athlete_deal_pipeline  not_contacted / pitched / in_talks / deal_closed
//
// That last one is the drift worth naming: `_stageRemap` in store.js ran on
// EVERY BOOT, unguarded, renaming rows underneath running code. A vocabulary
// that renames itself at init is not a vocabulary.
//
// So: five stages, defined here, and every writer and reader goes through this
// module. The legacy names are a one-way mapping into these, applied ONCE by a
// guarded migration -- never again on the next boot.

// The board, in order. Order is meaningful: it is what makes "never move a deal
// backward" a comparison rather than a special case.
const STAGES = ['Prospecting', 'Outreach Sent', 'Negotiating', 'Closing', 'Closed'];

// Off the board, not a stage past Closed. A lost deal is not further along than
// a closing one, so it is never reachable by advancing and never compared by rank.
const LOST = 'Lost';

// Where a card lands the moment an agent actually works it.
const OUTREACH_SENT = 'Outreach Sent';
const FIRST = STAGES[0];

// ── EVERY NAME THIS PRODUCT HAS EVER WRITTEN ────────────────────────────────
// Lower-cased keys, because the same stage has been stored capitalised
// differently by different writers. A name not on this list is NOT guessed at --
// see normalizeStage.
const LEGACY = {
  // athlete_self_deals, pre-remap and post-remap both, since production holds a
  // mix of the two depending on when each row was written.
  prospect: 'Prospecting',
  prospecting: 'Prospecting',
  contacted: 'Outreach Sent',
  pitched: 'Outreach Sent',
  'outreach sent': 'Outreach Sent',
  outreach: 'Outreach Sent',
  'in talks': 'Negotiating',
  negotiating: 'Negotiating',
  negotiation: 'Negotiating',
  closing: 'Closing',
  agreed: 'Closing',
  signed: 'Closing',
  contract: 'Closing',
  closed: 'Closed',
  won: 'Closed',
  'closed won': 'Closed',
  paid: 'Closed',
  invoiced: 'Closed',
  // athlete_deal_pipeline statuses, for the backfill.
  not_contacted: 'Prospecting',
  in_talks: 'Negotiating',
  deal_closed: 'Closed',
  no_response: 'Outreach Sent',
  // Terminal, off the board.
  lost: LOST,
  'closed lost': LOST,
  dead: LOST,
};

// A stage we do not recognise is NOT silently turned into Prospecting: that
// would quietly move a closed deal back to the top of the board on the next
// write. Unknown returns null and the caller decides, which in practice means
// "leave the row alone".
function normalizeStage(stage) {
  const s = String(stage == null ? '' : stage).trim().toLowerCase();
  if (!s) return null;
  return LEGACY[s] || (STAGES.indexOf(String(stage).trim()) > -1 ? String(stage).trim() : null);
}

// Position on the board. Lost and anything unrecognised are -1, which makes
// them un-advanceable rather than first.
function rank(stage) {
  const n = normalizeStage(stage);
  return n === null || n === LOST ? -1 : STAGES.indexOf(n);
}

function isTerminal(stage) {
  const n = normalizeStage(stage);
  return n === 'Closed' || n === LOST;
}

// ── NEVER BACKWARD ──────────────────────────────────────────────────────────
//
// Copied from the athlete-side send (index.js), which only ever advanced from
// the very first stage. The rule generalises: an agent who marks a DM sent on a
// brand they are already NEGOTIATING with has not undone the negotiation, and a
// system that moves it back to "Outreach Sent" has just deleted their work.
//
// Returns the stage the row should end up in. When that equals the current
// stage, the caller writes nothing.
function advanceTo(current, target) {
  const cur = normalizeStage(current);
  const tgt = normalizeStage(target);
  if (!tgt) return cur;                       // nothing sensible to move to
  if (!cur) return tgt;                       // no stage on file yet
  if (cur === LOST) return cur;               // a lost deal is not revived by outreach
  return rank(tgt) > rank(cur) ? tgt : cur;
}

// ── CREATE OR ADVANCE ───────────────────────────────────────────────────────
//
// The one write every Home action funnels through: approving an email, marking a
// DM sent, marking a call done. All three mean the same thing about the deal --
// this brand has now been contacted for this athlete -- so all three land here.
//
// DEDUPED ON athlete + normalised brand name, the same key the athlete-side path
// and the legacy migration both use, so an agent and an athlete working the same
// brand share one row rather than racing to create two.
//
// stage_history is appended on every real move and never rewritten, because it
// is the only record of when a deal actually progressed.
async function enterStage(pool, {
  athleteId, agentId, brandName, stage, note, contactName, contactEmail,
  category, value, source,
}) {
  const brand = String(brandName || '').trim();
  if (!athleteId || !brand) return { ok: false, reason: 'athlete and brand are required' };
  const target = normalizeStage(stage) || OUTREACH_SENT;

  const existing = (await pool.query(
    `SELECT * FROM athlete_self_deals
      WHERE athlete_id = $1 AND LOWER(TRIM(brand_name)) = LOWER(TRIM($2))
      ORDER BY created_at ASC LIMIT 1`,
    [athleteId, brand])).rows[0];

  if (!existing) {
    const history = JSON.stringify([{ stage: target, date: new Date().toISOString(),
      note: note || 'Created by outreach' }]);
    const row = (await pool.query(
      `INSERT INTO athlete_self_deals
         (athlete_id, agent_id, brand_name, deal_type, value, stage, notes,
          category, contact_name, contact_email, source, stage_history)
       VALUES ($1,$2,$3,'Other',$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [athleteId, agentId || null, brand, value == null ? null : value, target,
        note || null, category || null, contactName || null, contactEmail || null,
        source || 'outreach', history])).rows[0];
    return { ok: true, created: true, advanced: true, from: null, to: target, deal: row };
  }

  const from = normalizeStage(existing.stage);
  const to = advanceTo(existing.stage, target);
  // Contact details are filled in where they were blank even when the stage does
  // not move: learning the owner's name on the third touch is worth keeping.
  const history = Array.isArray(existing.stage_history) ? existing.stage_history.slice() : [];
  if (to !== from) {
    history.push({ stage: to, date: new Date().toISOString(), note: note || 'Advanced by outreach' });
  }
  const row = (await pool.query(
    `UPDATE athlete_self_deals
        SET stage = $1,
            stage_history = $2,
            contact_name = COALESCE(contact_name, $3),
            contact_email = COALESCE(contact_email, $4),
            category = COALESCE(category, $5),
            updated_at = NOW()
      WHERE id = $6 RETURNING *`,
    [to, JSON.stringify(history), contactName || null, contactEmail || null,
      category || null, existing.id])).rows[0];
  return { ok: true, created: false, advanced: to !== from, from, to, deal: row };
}

// Convenience for the three Home actions, which all mean the same thing.
function enterOutreachSent(pool, opts) {
  return enterStage(pool, { ...opts, stage: OUTREACH_SENT });
}

module.exports = {
  STAGES, LOST, OUTREACH_SENT, FIRST, LEGACY,
  normalizeStage, rank, isTerminal, advanceTo, enterStage, enterOutreachSent,
};
