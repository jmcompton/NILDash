'use strict';
// ── A PRICE THE FOUNDER PROMISED ONE AGENCY ─────────────────────────────────
//
// Tiered pricing (services/pricing) sells Starter at $149 and up. The founder
// sometimes quotes an agency the original $99 a month before that, and keeps
// his word (Propoint, Nov 2026). Without this, that agency would sign up and
// Stripe would charge the tier price: the promise broken by the checkout.
//
//   price_offers   one row per promise: who it is for (an exact email, or a
//                  whole domain written "@propointathlete.com"), the plan
//                  ('legacy99', the one STRIPE_AGENT_PRICE_ID plan), the trial
//                  days the checkout gives, and a note.
//
// At checkout (createAgentCheckoutSession) an offer that matches the signing-up
// email sells the $99 plan with the offer's trial. Every person from that
// agency's domain gets it. A legacy $99 subscriber is never limited by a tier
// (services/pricing: plan_period is left unset), the same as Chris Sarver.
//
// Admin only. Nothing here reads or writes a price id; the checkout does.

const PLANS = ['legacy99'];

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS price_offers (
    match       TEXT PRIMARY KEY,
    plan        TEXT NOT NULL DEFAULT 'legacy99',
    trial_days  INTEGER NOT NULL DEFAULT 14,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

// "joyce@x.com" stays an email; "x.com", "@x.com" and "https://x.com" become "@x.com".
function normalizeMatch(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(s)) return s;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^@/, '').replace(/\/.*$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s) ? '@' + s : null;
}

async function add(pool, b = {}) {
  await ensureTable(pool);
  const match = normalizeMatch(b.match || b.email || b.domain);
  if (!match) return { ok: false, status: 400, error: 'Enter an email (joyce@propointathlete.com) or a domain (propointathlete.com).' };
  const plan = PLANS.includes(String(b.plan || 'legacy99')) ? String(b.plan || 'legacy99') : null;
  if (!plan) return { ok: false, status: 400, error: 'The only plan an offer can give is legacy99 ($99 a month).' };
  const days = parseInt(b.trialDays == null ? 14 : b.trialDays, 10);
  if (!Number.isFinite(days) || days < 0 || days > 60) return { ok: false, status: 400, error: 'Trial days must be 0 to 60.' };
  const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const r = await pool.query(
    `INSERT INTO price_offers (match, plan, trial_days, note) VALUES ($1, $2, $3, $4)
     ON CONFLICT (match) DO UPDATE SET plan = EXCLUDED.plan, trial_days = EXCLUDED.trial_days, note = EXCLUDED.note
     RETURNING *`, [match, plan, days, note]);
  return { ok: true, offer: r.rows[0] };
}

async function remove(pool, raw) {
  await ensureTable(pool);
  const match = normalizeMatch(raw);
  if (!match) return { ok: false, status: 400, error: 'Unknown offer.' };
  const r = await pool.query(`DELETE FROM price_offers WHERE match = $1`, [match]);
  return { ok: true, removed: r.rowCount };
}

async function list(pool) {
  await ensureTable(pool);
  return (await pool.query(`SELECT * FROM price_offers ORDER BY created_at DESC`)).rows;
}

// The offer for this email, exact email first, then its domain; or null.
async function forEmail(pool, email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return null;
  await ensureTable(pool);
  const r = await pool.query(
    `SELECT * FROM price_offers WHERE match = $1 OR match = $2 ORDER BY (match = $1) DESC LIMIT 1`,
    [e, e.slice(at)]);
  return r.rows[0] || null;
}

module.exports = { add, remove, list, forEmail, normalizeMatch, ensureTable, PLANS };
