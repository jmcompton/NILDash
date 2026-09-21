'use strict';
// ── ONE BUTTON: THE DEAL IS SIGNED ──────────────────────────────────────────
//
// An agent closes a deal in a text message on a Tuesday. Nothing in the
// product ever heard about it: the pipeline still said Outreach Sent, the
// brand ledger still said contacted, and deal_outcomes -- the table the whole
// fit model learns from -- stayed empty unless somebody happened to fill in a
// deal value on the deals page. So the one thing the business exists to do
// was the one thing it did not record.
//
// This is that record, and it reuses every store that already exists:
//
//   athlete_self_deals   the Pipeline row, moved to the existing Closed stage
//                        through services/pipeline (never a second stage
//                        machine, never a backwards move).
//   deal_outcomes        the analytics row the fit model reads.
//   brand_engagement     state 'closed', which is what makes the business
//                        NIL-active for every agent (services/brandFlags).
//
// BOTH ANSWERS ARE OPTIONAL. The form asks what the deal was worth and what
// the athlete will do, and either can be skipped: a deal we know happened and
// cannot price is worth more than a deal nobody logged because the form
// demanded a number. A skipped value is NULL, never 0 -- deal_outcomes is
// averaged, and a pile of zeroes would quietly halve every average.

const PIPE = require('./pipeline');

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 100000000) return null;              // a typo, not a deal
  return Math.round(n * 100) / 100;
}
function text(v, max) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  return s ? s.slice(0, max || 300) : null;
}
function followerBand(n) {
  const f = Number(n) || 0;
  if (f < 1000) return 'under-1k';
  if (f < 5000) return '1k-5k';
  if (f < 25000) return '5k-25k';
  if (f < 100000) return '25k-100k';
  return '100k-plus';
}

async function ensureTable(pool) {
  // Additive only: deal_outcomes is an existing table and every column it
  // already has keeps its meaning. brand_key is the deal's own record of
  // WHICH business this was, so a flag can be matched across agents by Place
  // ID or domain rather than by a name (services/brandFlags).
  await pool.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS brand_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS logged_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE deal_outcomes ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outcomes_brand_key ON deal_outcomes(brand_key)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outcomes_agent ON deal_outcomes(agent_id)`).catch(() => {});
}

// What the athlete brings to the row, for the fit model. Every field is
// optional: an athlete with none of it still logs a deal.
async function athleteFacts(pool, athleteId) {
  try {
    const r = await pool.query(
      `SELECT data->>'name' AS name, data->>'school' AS school, data->>'schoolTier' AS tier,
              data->>'sport' AS sport, data->>'instagram' AS ig, data->>'tiktok' AS tt
         FROM athletes WHERE id = $1`, [athleteId]);
    const a = r.rows[0] || {};
    return {
      name: a.name || null, school: a.school || null, tier: a.tier || null, sport: a.sport || null,
      followers: (parseInt(a.ig, 10) || 0) + (parseInt(a.tt, 10) || 0),
    };
  } catch (_) { return { name: null, school: null, tier: null, sport: null, followers: 0 }; }
}

// ── LOG IT ──────────────────────────────────────────────────────────────────
// Returns { ok, id, brand, athleteId, value, deliverable, stage } or
// { ok:false, error } in words an agent can read.
async function logDeal(pool, { agentId, athleteId, brandName, brandKey, value, deliverable, category, contactEmail, source, now } = {}) {
  const brand = text(brandName, 200);
  if (!agentId) return { ok: false, error: 'Sign in again: the deal needs an agent on it.' };
  if (!athleteId) return { ok: false, error: 'Which athlete signed this deal?' };
  if (!brand) return { ok: false, error: 'Which business signed the deal?' };
  // The athlete must be this agent's. A deal is written against a roster and
  // an id from somewhere else is not a typo, it is another agent's athlete.
  let owns;
  try {
    owns = (await pool.query(`SELECT 1 FROM athletes WHERE id = $1 AND agent_id = $2`, [athleteId, agentId])).rows[0];
  } catch (e) { return { ok: false, error: 'Could not read the roster: ' + e.message }; }
  if (!owns) return { ok: false, error: 'That athlete is not on your roster.' };

  await ensureTable(pool);
  const val = money(value);
  const what = text(deliverable, 300);
  const when = now ? new Date(now) : new Date();
  const facts = await athleteFacts(pool, athleteId);

  // 1. THE PIPELINE, through the one writer. enterStage never moves a deal
  //    backwards and appends to stage_history, so a brand already Closed
  //    stays closed and the history is not rewritten.
  let stage = null, dealRowId = null;
  try {
    const moved = await PIPE.enterStage(pool, {
      athleteId, agentId, brandName: brand, stage: 'Closed',
      note: 'Deal signed' + (val ? ` — $${val}` : '') + (what ? ` — ${what}` : ''),
      category: category || null, value: val, contactEmail: contactEmail || null,
      source: source || 'deal-log',
    });
    if (moved && moved.ok) { stage = moved.to; dealRowId = moved.deal && moved.deal.id; }
  } catch (e) {
    return { ok: false, error: 'Could not move the deal to Closed: ' + e.message };
  }

  // 2. THE OUTCOME ROW the fit model learns from. A NULL value is a deal with
  //    no price on it, which is different from a deal worth nothing.
  let id = null;
  try {
    const ins = await pool.query(
      `INSERT INTO deal_outcomes
         (agent_id, athlete_id, deal_id, brand, brand_key, business_category, school, school_tier,
          sport, follower_band, deliverable, deal_value, closed_at, logged_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [agentId, athleteId, dealRowId == null ? null : String(dealRowId), brand, brandKey || null,
        category || null, facts.school, facts.tier, facts.sport, followerBand(facts.followers),
        what, val, when, agentId]);
    id = ins.rows[0] && ins.rows[0].id;
  } catch (e) {
    return { ok: false, error: 'Could not record the deal: ' + e.message };
  }

  // 3. THE LEDGER. This is what makes the business NIL-active for every
  //    agent, so it is best-effort in the same way every other ledger write
  //    is: a deal that is already recorded must not fail because the ledger
  //    did, and the log says so.
  try {
    const store = require('../store');
    await store.markBrandClosed(athleteId, { agentId, brandKey: brandKey || null, brandName: brand, source: 'deal-log' });
  } catch (e) {
    console.error(`[deal-log] ledger write failed for "${brand}": ${e.message}`);
  }

  console.log(`[deal-log] agent=${agentId} athlete=${athleteId} "${brand}" signed${val ? ' $' + val : ' (no value given)'}${what ? ' — ' + what : ''} (outcome ${id})`);
  return { ok: true, id, brand, athleteId, athleteName: facts.name, value: val, deliverable: what, stage: stage || 'Closed' };
}

// ── UNDO ────────────────────────────────────────────────────────────────────
// A deal logged on the wrong card is one tap away, so undoing it has to be
// one tap too. Scoped to the agent who logged it: nobody undoes anyone else's
// deal. The outcome row is REMOVED rather than flagged, because it feeds an
// average and a row that is not real must not be in it.
async function undoDeal(pool, { agentId, id } = {}) {
  if (!agentId || !id) return { ok: false, error: 'Which deal should be undone?' };
  await ensureTable(pool);
  let row;
  try {
    row = (await pool.query(
      `SELECT * FROM deal_outcomes WHERE id = $1 AND agent_id = $2`, [id, agentId])).rows[0];
  } catch (e) { return { ok: false, error: e.message }; }
  if (!row) return { ok: false, error: 'That deal is not one of yours, or it was already undone.' };

  try { await pool.query(`DELETE FROM deal_outcomes WHERE id = $1 AND agent_id = $2`, [id, agentId]); }
  catch (e) { return { ok: false, error: 'Could not remove the deal: ' + e.message }; }

  // The Pipeline row goes back to where it was BEFORE the close, read off the
  // stage history this same module appended to. No history and it lands on
  // Negotiating, which is where a signed-then-unsigned deal actually is.
  let stage = null;
  try {
    const deal = (await pool.query(
      `SELECT id, stage, stage_history FROM athlete_self_deals
        WHERE athlete_id = $1 AND LOWER(TRIM(brand_name)) = LOWER(TRIM($2))
        ORDER BY created_at ASC LIMIT 1`, [row.athlete_id, row.brand])).rows[0];
    if (deal && PIPE.normalizeStage(deal.stage) === 'Closed') {
      const hist = Array.isArray(deal.stage_history) ? deal.stage_history.slice() : [];
      while (hist.length && PIPE.normalizeStage(hist[hist.length - 1].stage) === 'Closed') hist.pop();
      stage = (hist.length && PIPE.normalizeStage(hist[hist.length - 1].stage)) || 'Negotiating';
      hist.push({ stage, date: new Date().toISOString(), note: 'Deal log undone' });
      await pool.query(
        `UPDATE athlete_self_deals SET stage = $1, stage_history = $2, updated_at = NOW() WHERE id = $3`,
        [stage, JSON.stringify(hist), deal.id]);
    }
  } catch (e) { console.error('[deal-log] undo could not move the pipeline row:', e.message); }

  // And the ledger. Back to 'responded' when that business really did write
  // back, otherwise to 'contacted' -- never further back than the truth.
  try {
    const replied = (await pool.query(
      `SELECT 1 FROM outreach_logs
        WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(TRIM(brand_name)) = LOWER(TRIM($3))
          AND replied_at IS NOT NULL LIMIT 1`, [agentId, row.athlete_id, row.brand])).rows[0];
    const back = replied ? 'responded' : 'contacted';
    await pool.query(
      `UPDATE brand_engagement SET state = $1, outcome = NULL, outcome_at = NULL, updated_at = NOW()
        WHERE athlete_id = $2 AND state = 'closed'
          AND (LOWER(TRIM(brand_name)) = LOWER(TRIM($3)) OR brand_key = $4)`,
      [back, row.athlete_id, row.brand, row.brand_key || '']);
  } catch (e) { console.error('[deal-log] undo could not revert the ledger:', e.message); }

  console.log(`[deal-log] agent=${agentId} UNDID deal ${id} "${row.brand}"`);
  return { ok: true, id, brand: row.brand, stage: stage || null };
}

// Deals this agent has logged, newest first. The list the undo button reads.
async function recentFor(pool, agentId, limit) {
  try {
    const r = await pool.query(
      `SELECT o.id, o.brand, o.deal_value, o.deliverable, o.closed_at, o.athlete_id,
              a.data->>'name' AS athlete_name
         FROM deal_outcomes o LEFT JOIN athletes a ON a.id = o.athlete_id
        WHERE o.agent_id = $1 ORDER BY o.closed_at DESC NULLS LAST, o.id DESC LIMIT $2`,
      [agentId, Math.min(200, Math.max(1, Number(limit) || 50))]);
    return r.rows.map((x) => ({ id: x.id, brand: x.brand, athleteId: x.athlete_id, athlete: x.athlete_name,
      value: x.deal_value == null ? null : Number(x.deal_value), deliverable: x.deliverable, closedAt: x.closed_at }));
  } catch (e) { console.error('[deal-log] recentFor:', e.message); return []; }
}

// Has this agent already logged a deal for this athlete and brand? The card
// shows "Deal signed ✓" instead of the button.
async function loggedFor(pool, agentId, pairs) {
  const out = new Map();
  if (!agentId || !Array.isArray(pairs) || !pairs.length) return out;
  try {
    const r = await pool.query(
      `SELECT id, athlete_id, LOWER(TRIM(brand)) AS brand FROM deal_outcomes WHERE agent_id = $1`, [agentId]);
    for (const x of r.rows) out.set(x.athlete_id + '|' + x.brand, x.id);
  } catch (e) { console.error('[deal-log] loggedFor:', e.message); }
  return out;
}

// ── ADMIN ONLY: THE COUNTER ────────────────────────────────────────────────
// Total deals, total value and this month, across everyone. Nothing public.
async function counts(pool, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS deals,
              COALESCE(SUM(deal_value), 0)::numeric AS value,
              COUNT(*) FILTER (WHERE deal_value IS NOT NULL)::int AS priced,
              COUNT(*) FILTER (WHERE closed_at >= $1)::int AS deals_this_month,
              COALESCE(SUM(deal_value) FILTER (WHERE closed_at >= $1), 0)::numeric AS value_this_month,
              COUNT(DISTINCT agent_id)::int AS agents,
              COUNT(DISTINCT athlete_id)::int AS athletes
         FROM deal_outcomes`, [monthStart]);
    const x = r.rows[0] || {};
    return {
      deals: Number(x.deals) || 0,
      totalValue: Number(x.value) || 0,
      priced: Number(x.priced) || 0,
      // Said out loud, because a total that silently ignores unpriced deals
      // reads as the whole book and is not.
      unpriced: (Number(x.deals) || 0) - (Number(x.priced) || 0),
      dealsThisMonth: Number(x.deals_this_month) || 0,
      valueThisMonth: Number(x.value_this_month) || 0,
      agents: Number(x.agents) || 0,
      athletes: Number(x.athletes) || 0,
      monthStart: monthStart.toISOString().slice(0, 10),
    };
  } catch (e) {
    console.error('[deal-log] counts:', e.message);
    return { deals: 0, totalValue: 0, priced: 0, unpriced: 0, dealsThisMonth: 0, valueThisMonth: 0, agents: 0, athletes: 0, error: e.message };
  }
}

module.exports = { logDeal, undoDeal, recentFor, loggedFor, counts, ensureTable, money, text, followerBand };
