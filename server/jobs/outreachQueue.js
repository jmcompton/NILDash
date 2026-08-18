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

// ONE FILLER, shared by the nightly job and the admin "fill now" button. If the
// button had its own copy, the card an admin sees and the card the job writes
// would drift apart, and the button is exactly where that drift gets noticed last.
//
// onProgress is called with plain sentences so a UI can print them verbatim; the
// job passes console.log and the endpoint pushes them to a poller.
async function fillAthlete(pool, ctx) {
  const { agentId, athleteId, athleteName, budget, region } = ctx;
  const say = ctx.onProgress || (() => {});
  const dry = !!ctx.dryRun;

  const open = Q.slotsToFill((await pool.query(
    `SELECT slot, state FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`,
    [athleteId])).rows);
  if (!open.length) { say(`${athleteName}: all three slots already full`); return { filled: 0, open: 0 }; }
  say(`${athleteName}: ${open.length} slot${open.length > 1 ? 's' : ''} to fill`);

  const cands = await candidatesFor(pool, athleteId, open.length * Q.MAX_ATTEMPTS_PER_SLOT);
  if (!cands.length) {
    say(`${athleteName}: no un-contacted businesses on their scan. Run a Deal Scan first.`);
    return { filled: 0, open: open.length };
  }
  let ci = 0, filled = 0;

  for (const slot of open) {
    let placed = false;
    for (let attempt = 0; attempt < Q.MAX_ATTEMPTS_PER_SLOT && ci < cands.length; attempt++) {
      const cand = cands[ci++];
      // BEFORE the money, priced at the CEILING. A lookup that would breach the
      // cap is never started, so the cap cannot be overshot by one business.
      if (!budget.canSpend(LOOKUP_CEILING_USD)) {
        const why = Q.slotSkipReason(budget, LOOKUP_CEILING_USD);
        say(`slot ${slot} ${why}`);
        return { filled, open: open.length, cappedOut: true };
      }
      say(`looking up ${cand.brand_name}…`);
      let out = null;
      try {
        out = await ai.getBrandContacts(cand.brand_name || cand.brand_key, null,
          region || '', ai.deepContactCtx({ market: null }));
      } catch (e) {
        say(`${cand.brand_name}: lookup failed (${e.message})`);
        continue;
      }
      if (!out.cached) budget.spend(LOOKUP_CEILING_USD);

      const ladder = buildContactLadder(out, {
        rankOf: ai.contactAuthorityRank, rootDomain: ai.rootDomain,
        category: null, brand: cand.brand_name, instagramScope: out.instagramScope || null,
      });
      const ig = { instagram: out.instagram || null, instagramScope: out.instagramScope || null };
      const bar = Q.passesBar(ladder, ig);
      if (!bar.ok) { say(`${cand.brand_name}: skipped, ${bar.reason}`); continue; }

      const card = Q.buildCard({
        brandKey: cand.brand_key, brand: cand.brand_name,
        rationale: await rationaleFor(pool, agentId, athleteId, cand.brand_name),
        athleteName,
      }, ladder, ig);

      if (dry) { say(`slot ${slot}: ${card.brandName} (${card.channel})`); placed = true; filled++; break; }
      const ins = await pool.query(
        `INSERT INTO outreach_queue
           (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title,
            source_note, affiliation_scope, instagram, instagram_scope, phone, phone_ask_for,
            dm_text, channel, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued')
         ON CONFLICT DO NOTHING RETURNING id`,
        [agentId, athleteId, slot, card.brandKey, card.brandName, card.why, card.contactName,
         card.contactTitle, card.sourceNote, card.affiliationScope, card.instagram,
         card.instagramScope, card.phone, card.phoneAskFor, card.dmText, card.channel]);
      if ((ins.rowCount || 0) > 0) {
        placed = true; filled++;
        say(`slot ${slot}: ${card.brandName} — ${card.channel === 'dm' ? 'DM ready' : 'call'}`
          + (card.contactName ? `, ${card.contactName}` : ''));
      }
      break;
    }
    if (!placed) say(`slot ${slot}: nothing passed the bar in ${Q.MAX_ATTEMPTS_PER_SLOT} attempts`);
  }
  return { filled, open: open.length };
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

  for (const ath of athletes) {
    const r = await fillAthlete(pool, {
      agentId: agent.id, athleteId: ath.id, athleteName: ath.name,
      budget, region: opts.region, dryRun: dry,
      onProgress: (m) => console.log('[queue] ' + m),
    });
    filled += r.filled;
    if (r.cappedOut) break;   // the cap is per agent, so one athlete exhausting it stops the rest
  }

  if (!dry) {
    await pool.query(
      `UPDATE outreach_queue_runs SET filled = $3, spent_usd = $4 WHERE agent_id = $1 AND run_date = $2`,
      [agent.id, runDate, filled, budget.spent()]).catch(() => {});
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

module.exports = { run, fillAgent, fillAthlete, claimNight, candidatesFor, ENABLED, CAP_USD, LOOKUP_CEILING_USD };

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
