'use strict';
// Signup funnel classification.
//
// Pure logic, deliberately split out of the route so it can be tested without a
// database. The route supplies rows; this decides what each row means.
//
// WHAT THIS CAN AND CANNOT TELL YOU. NILDash keeps no outbound email delivery log.
// The password_resets table records that a link was ISSUED and whether it was USED,
// so "issued, never used, now expired" is knowable. "The email never arrived" is not
// distinguishable from "the email arrived and was ignored". Any read of these numbers
// that assumes otherwise is wrong.

const FUNNEL_STEPS = [
  { key: 'signed_up', label: 'Signed up' },
  { key: 'set_password', label: 'Set password' },
  { key: 'logged_in', label: 'Logged in' },
  { key: 'added_athlete', label: 'Added an athlete' },
  { key: 'ran_scan', label: 'Ran a scan' },
  { key: 'sent_outreach', label: 'Sent outreach' },
];

// Roles the Agent Activity table can display. Kept here so the funnel can EXPLAIN a
// gap in that table rather than silently reproducing the same filter.
const AGENT_ACTIVITY_ROLES = ['agent', 'admin'];

function classifyFunnelUser(u, nowMs) {
  const now = nowMs || Date.now();
  // Raw per-step truth, before any funnel ordering is imposed.
  const raw = {
    signed_up: true,
    set_password: u.password_reset_required !== true,
    logged_in: !!u.last_login,
    added_athlete: Number(u.athletes || 0) > 0,
    ran_scan: Number(u.scans || 0) > 0,
    sent_outreach: Number(u.outreach || 0) > 0,
  };
  // A funnel is monotonic: reaching step N means every earlier step too. Kept
  // separate from raw so an out-of-order account is REPORTED, not massaged. An
  // agent who was invited (password_reset_required still true) but has run scans
  // would otherwise vanish from the counts entirely.
  let reached = -1;
  for (let i = 0; i < FUNNEL_STEPS.length; i++) {
    if (!raw[FUNNEL_STEPS[i].key]) break;
    reached = i;
  }
  const anomalies = [];
  for (let i = reached + 2; i < FUNNEL_STEPS.length; i++) {
    if (raw[FUNNEL_STEPS[i].key]) anomalies.push(FUNNEL_STEPS[i].key);
  }
  const stuckIdx = reached + 1;

  const expired = u.reset_expires ? new Date(u.reset_expires).getTime() < now : null;
  // Why is this person stuck before logging in? The reset table is the only
  // evidence there is, and it cannot speak to delivery.
  let note = null;
  if (!raw.logged_in) {
    if (!Number(u.reset_tokens || 0)) note = 'no set-password link was ever issued';
    else if (u.reset_used) note = 'set-password link WAS used, but never logged in after';
    else if (expired) note = 'set-password link issued, never used, now EXPIRED';
    else note = 'set-password link issued and still valid, not used yet';
  }

  return {
    id: u.id, name: u.name, email: u.email, role: u.role, plan: u.plan,
    comped: u.comped, subscription_status: u.subscription_status, archived: u.archived,
    created_at: u.created_at, last_login: u.last_login,
    password_reset_required: u.password_reset_required,
    athletes: Number(u.athletes || 0), scans: Number(u.scans || 0), outreach: Number(u.outreach || 0),
    reset_tokens: Number(u.reset_tokens || 0), reset_used: !!u.reset_used,
    reset_expires: u.reset_expires || null, reset_expired: expired,
    note, raw, reached, anomalies,
    stuckAt: stuckIdx < FUNNEL_STEPS.length ? FUNNEL_STEPS[stuckIdx].key : null,
    // Why this account does or does not appear in Agent Activity.
    inAgentActivity: AGENT_ACTIVITY_ROLES.includes(String(u.role || '')) && u.archived !== true,
  };
}

function buildFunnel(rows, nowMs) {
  const users = (rows || []).map((u) => classifyFunnelUser(u, nowMs));
  const steps = FUNNEL_STEPS.map((s, i) => ({
    key: s.key,
    label: s.label,
    reached: users.filter((u) => u.reached >= i).length,
    stuck: users.filter((u) => u.stuckAt === s.key).map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      note: u.note, created_at: u.created_at,
    })),
  }));
  return {
    total: users.length,
    steps,
    users,
    missingFromAgentActivity: users.filter((u) => !u.inAgentActivity).map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, archived: u.archived,
    })),
    anomalies: users.filter((u) => u.anomalies.length).map((u) => ({
      id: u.id, name: u.name, email: u.email, stuckAt: u.stuckAt, laterStepsDone: u.anomalies,
    })),
    note: 'No outbound email delivery log exists, so a link never used cannot be distinguished from an email never delivered.',
  };
}

module.exports = { FUNNEL_STEPS, AGENT_ACTIVITY_ROLES, classifyFunnelUser, buildFunnel };
