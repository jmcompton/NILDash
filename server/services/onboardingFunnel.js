'use strict';
// ── THE ONBOARDING FUNNEL, PER AGENT AND IN TOTAL ───────────────────────────
//
// scripts/onboarding-funnel.js, /api/admin/scripts/onboarding-funnel. Eight
// steps, each with the moment it first happened:
//
//   created              users.created_at
//   link sent            the first set-password link (password_resets.created_at)
//   first login          users.first_login_at, stamped at sign-in
//   mailbox connected    the first email_accounts row
//   address added        users.business_address_at
//   first athlete        the first athletes row
//   first card approved  the first approved email, approve action, or worked card
//   first email sent     the first outreach_logs.sent_at
//
// Older accounts did some of these before the stamp existed (a link issued
// before password_resets.created_at, a login before first_login_at). Those
// read "yes, before tracking" rather than a made-up date. Read-only.

const STEPS = [
  ['created', 'created'], ['link', 'link sent'], ['login', 'first login'], ['mailbox', 'mailbox connected'],
  ['address', 'address added'], ['athlete', 'first athlete'], ['approved', 'first card approved'], ['sent', 'first email sent'],
];

async function gather(pool, opts = {}) {
  await require('./agentSetup').ensureTable(pool).catch(() => {});
  await require('./pitchActions').ensureTable(pool).catch(() => {});
  const params = [];
  let scope = '';
  if (opts.agentId) { params.push(opts.agentId); scope = ` AND u.id = $${params.length}`; }
  return (await pool.query(`
    SELECT u.id, u.name, u.email, u.created_at, u.archived, u.comped, u.first_login_at, u.last_login,
           u.business_address_at,
           (COALESCE(u.business_street, '') <> '' AND COALESCE(u.business_city, '') <> '' AND COALESCE(u.business_state, '') <> '') AS has_address,
           pr.first_link_at, COALESCE(pr.links, 0) AS links,
           (SELECT MIN(ea.created_at) FROM email_accounts ea WHERE ea.user_id = u.id) AS mailbox_at,
           (SELECT MIN(a.created_at) FROM athletes a WHERE a.agent_id = u.id) AS athlete_at,
           LEAST((SELECT MIN(l.approved_at) FROM outreach_logs l WHERE l.agent_id = u.id),
                 (SELECT MIN(p.created_at) FROM pitch_actions p WHERE p.agent_id = u.id AND p.action = 'approve'),
                 (SELECT MIN(COALESCE(q.sent_at, q.updated_at)) FROM outreach_queue q WHERE q.agent_id = u.id AND q.state IN ('sent', 'sending'))) AS approved_at,
           (SELECT MIN(l.sent_at) FROM outreach_logs l WHERE l.agent_id = u.id AND l.sent_at IS NOT NULL) AS sent_at,
           s.started_at AS setup_started_at, s.done_at AS setup_done_at,
           s.mailbox_at AS setup_mailbox_at, s.address_at AS setup_address_at, s.athlete_at AS setup_athlete_at
      FROM users u
      LEFT JOIN (SELECT LOWER(TRIM(email)) AS e, MIN(created_at) AS first_link_at, COUNT(*)::int AS links
                   FROM password_resets GROUP BY 1) pr ON pr.e = LOWER(TRIM(u.email))
      LEFT JOIN agent_setup s ON s.user_id = u.id
     WHERE u.role = 'agent'${scope}
     ORDER BY u.created_at NULLS FIRST, u.email`, params)).rows;
}

// One agent's eight steps. Pure. { key: { yes, at, note } }
function stepsOf(r) {
  const s = {};
  s.created = { yes: true, at: r.created_at || null };
  s.link = { yes: Number(r.links) > 0, at: r.first_link_at || null };
  s.login = { yes: !!(r.first_login_at || r.last_login), at: r.first_login_at || null };
  s.mailbox = { yes: !!r.mailbox_at, at: r.mailbox_at || null };
  s.address = { yes: !!(r.has_address || r.business_address_at), at: r.business_address_at || null };
  s.athlete = { yes: !!r.athlete_at, at: r.athlete_at || null };
  s.approved = { yes: !!r.approved_at, at: r.approved_at || null };
  s.sent = { yes: !!r.sent_at, at: r.sent_at || null };
  for (const k of Object.keys(s)) if (s[k].yes && !s[k].at) s[k].note = 'before tracking';
  return s;
}

function internalOf(r) {
  try { return require('./coldAgent').isInternal(r, { excludeNames: [], excludeEmails: [] }); } catch (_) { return null; }
}

function build(rows) {
  const agents = rows.map((r) => ({ id: r.id, name: r.name, email: r.email, comped: !!r.comped, archived: !!r.archived,
    internal: internalOf(r), steps: stepsOf(r),
    setup: r.setup_started_at ? { started: r.setup_started_at, done: r.setup_done_at || null,
      n: [r.setup_mailbox_at, r.setup_address_at, r.setup_athlete_at].filter(Boolean).length } : null }));
  const tally = (list) => Object.fromEntries(STEPS.map(([k]) => [k, list.filter((a) => a.steps[k].yes).length]));
  const real = agents.filter((a) => !a.internal && !a.archived);
  return { agents, totals: { all: { n: agents.length, ...tally(agents) }, real: { n: real.length, ...tally(real) } } };
}

async function run(pool, opts = {}) { return build(await gather(pool, opts)); }

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function format(r) {
  const L = [];
  const t = r.totals;
  L.push(`ONBOARDING FUNNEL: ${t.all.n} agent account(s); ${t.real.n} real (not internal, test or archived)`);
  L.push('');
  L.push('                       all agents     real agents');
  for (const [k, label] of STEPS) {
    const pct = (n, of) => (of ? `${String(Math.round((100 * n) / of)).padStart(3)}%` : '   -');
    L.push(`  ${label.padEnd(20)} ${String(t.all[k]).padStart(4)} ${pct(t.all[k], t.all.n)}     ${String(t.real[k]).padStart(4)} ${pct(t.real[k], t.real.n)}`);
  }
  L.push('');
  L.push('PER AGENT (oldest first). A date is when it first happened; "yes" is before it was tracked; "-" is not yet.');
  for (const a of r.agents) {
    const tags = [a.comped ? 'comped' : null, a.archived ? 'archived' : null, a.internal ? 'internal/test' : null].filter(Boolean);
    L.push('');
    L.push(`${a.name || '(no name)'} <${a.email}>${tags.length ? ' [' + tags.join(', ') + ']' : ''}`);
    L.push('  ' + STEPS.map(([k, label]) => {
      const s = a.steps[k];
      return `${label}: ${s.at ? day(s.at) : s.yes ? 'yes' : '-'}`;
    }).join(' · '));
    const stuck = STEPS.find(([k]) => !a.steps[k].yes);
    L.push(`  ${stuck ? 'next step: ' + stuck[1] : 'every step done'}`
      + (a.setup ? ` · setup screen: started ${day(a.setup.started)}, ${a.setup.done ? 'finished ' + day(a.setup.done) : a.setup.n + ' of 3 done'}` : ''));
  }
  return L.join('\n');
}

module.exports = { STEPS, gather, stepsOf, build, run, format };
