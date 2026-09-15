'use strict';
// ── HOW MANY ATHLETES AN ACCOUNT MAY HOLD ────────────────────────────────────
//
// One rule, read by the Add Client route, the seat-status endpoint, the admin
// page and the roster importer, so none of them can disagree.
//
// THE PLAN SETS THE LIMIT. That rule is unchanged: basic and beta hold ten,
// pro twenty, unlimited and enterprise have no ceiling.
//
// AN ADMIN CAN OVERRIDE IT FOR ONE ACCOUNT. users.seat_override is NULL for
// everyone by default, which means "the plan decides". A number is that
// account's limit instead; 0 means no limit at all. It is set only from the
// admin page (POST /api/admin/set-seat-override) and shown there beside the
// plan, so who has one is never a mystery. The first account to carry one is
// an agent whose roster is larger than any plan tier and who is not paying
// per seat.

function planSeatLimit(plan) {
  if (!plan) return 10;
  const p = String(plan).toLowerCase();
  if (p.includes('unlimited') || p.includes('enterprise') || p.includes('599')) return null;
  if (p.includes('pro') || p.includes('499')) return 20;
  return 10; // basic, beta, $299, etc.
}

// A stored override, read strictly: NULL / undefined / '' is "none"; a
// non-negative integer is an override; anything else is treated as none
// rather than as a limit of NaN.
function readOverride(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// The user row (or the safe copy getUser returns) -> what applies.
//   { limit: 10 | 20 | null, source: 'plan' | 'override', plan, override }
// limit null means no ceiling.
function seatLimitFor(user) {
  const u = user || {};
  const plan = u.plan_tier || u.plan || 'basic';
  const override = readOverride(u.seat_override);
  if (override !== null) return { limit: override === 0 ? null : override, source: 'override', plan, override };
  return { limit: planSeatLimit(plan), source: 'plan', plan, override: null };
}

// The sentence the Add Client route returns when the limit is hit. Says
// where the number came from, because "upgrade your plan" is the wrong advice
// for an account whose limit an admin set by hand.
function limitMessage(seats) {
  if (seats.source === 'override') {
    return `You've reached the athlete limit (${seats.limit}) set on your account. Contact support to raise it.`;
  }
  return `You've reached your athlete limit (${seats.limit}) on your current plan. Upgrade to add more athletes.`;
}

// For the admin page: "plan (10)", "override: no limit", "override: 30".
function describeSeats(seats) {
  if (seats.source === 'override') return seats.limit === null ? 'no limit (override)' : `${seats.limit} (override)`;
  return seats.limit === null ? 'no limit (plan)' : `${seats.limit} (plan)`;
}

module.exports = { planSeatLimit, readOverride, seatLimitFor, limitMessage, describeSeats };
