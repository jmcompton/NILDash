#!/usr/bin/env node
'use strict';
// Nightly fill of the morning outreach queue.
//
//   node server/jobs/outreachQueue.js --dry-run        pick and price, write nothing
//   node server/jobs/outreachQueue.js --send           the real nightly run
//   node server/jobs/outreachQueue.js --status         what each agent has queued
//   node server/jobs/outreachQueue.js --send --agent <id> [--force]
//
// Off unless OUTREACH_QUEUE_ENABLED=1, so a deploy cannot start spending by
// surprise. Same shape as the weekly digest, for the same reason.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. EMPTY SLOTS ONLY. An agent who never acts is never filled for, so an
//    inactive account costs nothing at all -- not a reduced amount, nothing.
//
// 2. ONE CLAIM PER AGENT PER NIGHT. outreach_queue_runs has PRIMARY KEY
//    (agent_id, run_date) and the row is claimed BEFORE any lookup. A slot freed
//    at 10am waits for tomorrow; an agent skipping three cards in one sitting
//    triggers zero lookups. A crash after the claim costs that agent one night,
//    which is the right way round for money.
//
// 3. THE CAP IS A CAP. $0.50 an agent a night, checked before each lookup against
//    its ceiling. A slot that cannot be filled inside it is LEFT EMPTY and the
//    reason is logged. Never a partial fill that quietly costs more.
//
// Cost: the quality bar needs a named contact, which needs the deep ladder --
// $0.12 to $0.26 a business, and a cached one is free. Cache first, at most
// MAX_ATTEMPTS_PER_SLOT candidates a slot.

const store = require('../store');
const ai = require('../ai');
const { buildContactLadder } = require('../services/contactLadder');
const Q = require('../services/outreachQueue');

const ENABLED = process.env.OUTREACH_QUEUE_ENABLED === '1';
const CAP_USD = parseFloat(process.env.OUTREACH_QUEUE_AGENT_CAP_USD) || Q.DEFAULT_AGENT_NIGHTLY_USD;
// The ladder's own ceiling, used to decide whether the NEXT lookup fits. Pricing
// the worst case rather than the average is what makes the cap a cap.
const LOOKUP_CEILING_USD = parseFloat(process.env.OUTREACH_QUEUE_LOOKUP_USD) || 0.26;

function today() { return new Date().toISOString().slice(0, 10); }

// Claim the night. Returns false when this agent has already been filled today,
// which is what stops a freed slot refilling on the spot.
async function claimNight(pool, agentId, runDate, force) {
  if (force) {
    await pool.query(
      `INSERT INTO outreach_queue_runs (agent_id, run_date) VALUES ($1,$2)
       ON CONFLICT (agent_id, run_date) DO UPDATE SET created_at = NOW()`, [agentId, runDate]);
    return true;
  }
  const r = await pool.query(
    `INSERT INTO outreach_queue_runs (agent_id, run_date) VALUES ($1,$2)
     ON CONFLICT (agent_id, run_date) DO NOTHING`, [agentId, runDate]);
  return (r.rowCount || 0) > 0;
}

// Businesses this athlete has seen but nobody has contacted or retired. The
// ledger is keyed (athlete_id, brand_key), so a brand skipped by one athlete is
// still offered to another on the same roster.
async function candidatesFor(pool, athleteId, limit) {
  const r = await pool.query(
    `SELECT be.brand_key, be.brand_name
       FROM brand_engagement be
      WHERE be.athlete_id = $1
        AND be.state = 'shown'
        AND NOT EXISTS (
          SELECT 1 FROM outreach_queue q
           WHERE q.athlete_id = be.athlete_id AND q.brand_key = be.brand_key)
      ORDER BY be.last_shown_at DESC NULLS LAST
      LIMIT $2`, [athleteId, limit]);
  return r.rows;
}

// The rationale the scan already wrote, which is the same sentence that justifies
// the message. No extra model call.
async function rationaleFor(pool, agentId, athleteId, brandName) {
  const r = await pool.query(
    `SELECT reasoning FROM brand_match_scores
      WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(brand_name) = LOWER($3)
      ORDER BY created_at DESC LIMIT 1`, [agentId, athleteId, brandName]).catch(() => ({ rows: [] }));
  return (r.rows[0] && r.rows[0].reasoning) || null;
}

async function fillAgent(pool, agent, opts) {
  const runDate = opts.runDate || today();
  const dry = !!opts.dryRun;
  if (!dry && !(await claimNight(pool, agent.id, runDate, opts.force))) {
    console.log(`[queue] agent=${agent.id} already filled for ${runDate}, skipping (use --force to re-run)`);
    return { filled: 0, spent: 0, claimed: false };
  }
  const budget = Q.newBudget(CAP_USD);
  const athletes = (await pool.query(
    `SELECT id, data->>'name' AS name FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`,
    [agent.id])).rows;
  let filled = 0;
  const notes = [];

  for (const ath of athletes) {
    const existing = (await pool.query(
      `SELECT slot, state FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`,
      [ath.id])).rows;
    const open = Q.slotsToFill(existing);
    if (!open.length) continue;

    const pool_ = await candidatesFor(pool, ath.id, open.length * Q.MAX_ATTEMPTS_PER_SLOT);
    let ci = 0;

    for (const slot of open) {
      let placed = false;
      for (let attempt = 0; attempt < Q.MAX_ATTEMPTS_PER_SLOT && ci < pool_.length; attempt++) {
        const cand = pool_[ci++];
        // BEFORE the money. A lookup that would breach the cap is not started.
        if (!budget.canSpend(LOOKUP_CEILING_USD)) {
          const why = Q.slotSkipReason(budget, LOOKUP_CEILING_USD);
          console.log(`[queue] agent=${agent.id} athlete=${ath.id} slot=${slot} ${why}`);
          notes.push(`slot ${slot}: ${why}`);
          attempt = Q.MAX_ATTEMPTS_PER_SLOT;
          break;
        }
        let out = null;
        try {
          out = await ai.getBrandContacts(cand.brand_name || cand.brand_key, null,
            opts.region || '', ai.deepContactCtx({ market: null }));
        } catch (e) {
          console.warn(`[queue] lookup failed brand="${cand.brand_name}": ${e.message}`);
          continue;
        }
        // A cache hit costs nothing and must not be charged against the cap.
        if (!out.cached) budget.spend(LOOKUP_CEILING_USD);

        const ladder = buildContactLadder(out, {
          rankOf: ai.contactAuthorityRank, rootDomain: ai.rootDomain,
          category: null, brand: cand.brand_name,
        });
        const ig = { instagram: out.instagram || null, instagramScope: out.instagramScope || null };
        const bar = Q.passesBar(ladder, ig);
        if (!bar.ok) {
          console.log(`[queue] agent=${agent.id} athlete=${ath.id} brand="${cand.brand_name}" not queued: ${bar.reason}`);
          continue;
        }
        const card = Q.buildCard({
          brandKey: cand.brand_key, brand: cand.brand_name,
          rationale: await rationaleFor(pool, agent.id, ath.id, cand.brand_name),
          athleteName: ath.name,
        }, ladder, ig);

        if (dry) {
          console.log(`[queue] DRY agent=${agent.id} athlete=${ath.name} slot=${slot} `
            + `${card.brandName} via ${card.channel} (${card.contactName || 'no name'})`);
          placed = true; filled++;
          break;
        }
        // ON CONFLICT DO NOTHING against the partial unique index: a racing run
        // loses here rather than producing a second card for the same slot.
        const ins = await pool.query(
          `INSERT INTO outreach_queue
             (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title,
              source_note, affiliation_scope, instagram, instagram_scope, phone, phone_ask_for,
              dm_text, channel, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued')
           ON CONFLICT DO NOTHING RETURNING id`,
          [agent.id, ath.id, slot, card.brandKey, card.brandName, card.why, card.contactName,
           card.contactTitle, card.sourceNote, card.affiliationScope, card.instagram,
           card.instagramScope, card.phone, card.phoneAskFor, card.dmText, card.channel]);
        if ((ins.rowCount || 0) > 0) { placed = true; filled++; }
        break;
      }
      if (!placed && budget.canSpend(LOOKUP_CEILING_USD)) {
        console.log(`[queue] agent=${agent.id} athlete=${ath.id} slot=${slot} left empty: `
          + `no candidate passed the bar in ${Q.MAX_ATTEMPTS_PER_SLOT} attempts`);
      }
    }
  }

  if (!dry) {
    await pool.query(
      `UPDATE outreach_queue_runs SET filled = $3, spent_usd = $4, note = $5
        WHERE agent_id = $1 AND run_date = $2`,
      [agent.id, runDate, filled, budget.spent(), notes.join('; ') || null]).catch(() => {});
  }
  console.log(`[queue] agent=${agent.id} filled=${filled} spent=$${budget.spent().toFixed(2)} of $${CAP_USD.toFixed(2)}`);
  return { filled, spent: budget.spent(), claimed: true };
}

async function run(opts = {}) {
  const pool = store.pool;
  const agents = opts.agentId
    ? (await pool.query(`SELECT id FROM users WHERE id = $1`, [opts.agentId])).rows
    : (await pool.query(
      `SELECT id FROM users WHERE role IN ('agent','admin') AND archived IS NOT TRUE ORDER BY created_at ASC`)).rows;
  let filled = 0, spent = 0;
  for (const a of agents) {
    const r = await fillAgent(pool, a, opts).catch((e) => {
      console.error(`[queue] agent=${a.id} failed: ${e.message}`);
      return { filled: 0, spent: 0 };
    });
    filled += r.filled; spent += r.spent;
  }
  console.log(`[queue] run complete agents=${agents.length} filled=${filled} spent=$${spent.toFixed(2)}`);
  return { agents: agents.length, filled, spent };
}

async function status(pool) {
  const r = await (pool || store.pool).query(
    `SELECT agent_id, state, COUNT(*)::int AS n FROM outreach_queue GROUP BY agent_id, state ORDER BY agent_id`);
  for (const row of r.rows) console.log(`  ${row.agent_id}  ${row.state}  ${row.n}`);
  return r.rows;
}

module.exports = { run, fillAgent, claimNight, candidatesFor, ENABLED, CAP_USD, LOOKUP_CEILING_USD };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    agentId: argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : null,
  };
  const go = async () => {
    if (argv.includes('--status')) return status();
    if (!opts.dryRun && !argv.includes('--send')) {
      console.error('Refusing to run without --send or --dry-run.');
      process.exit(2);
    }
    if (!opts.dryRun && !ENABLED && !opts.agentId) {
      console.error('OUTREACH_QUEUE_ENABLED is not 1. Set it, or pass --agent <id> to fill one agent.');
      process.exit(2);
    }
    return run(opts);
  };
  go().then(() => process.exit(0)).catch((e) => { console.error('[queue] ' + e.message); process.exit(1); });
}
