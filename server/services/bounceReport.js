'use strict';
// ── WHERE THE BOUNCES COME FROM (admin script bounce-report) ────────────────
//
// Per agent, every email sent in the last 30 days, split two ways:
//
//   PATH     card     a morning card from the nightly queue (its address came
//                     from the email finder), or a follow-up to one, sent by
//                     the release
//            by hand  the editor's Send, or anything written from a Deal Scan,
//                     Write Outreach or the editor; the athlete's brand email;
//                     a new message from the inbox
//   STATUS   what was known about the address as it left: valid, catch-all,
//            invalid, unverified (checked, no answer) or none (never checked)
//
// Recorded at send time from now on (outreach_logs.send_verify_status and
// send_path, written whether or not SEND_GATE_ON). Sends made before that are
// judged by the verification on record and whether it was made before the
// send; a check made after a send did not exist when it went.
//
// BOUNCED: the agent pressed "This bounced", or the address is suppressed as
// a bounce. gmail.send cannot see a bounce itself.

const SG = require('./sendGate');
const STATUSES = ['valid', 'catch-all', 'invalid', 'unverified', 'none'];
const PATHS = ['card', 'hand'];

async function gather(pool, { days = 30, agentId = null } = {}) {
  await SG.ensureColumns(pool);
  const params = [days];
  let scope = '';
  if (agentId) { params.push(String(agentId)); scope = ` AND l.agent_id = $${params.length}`; }
  const logs = (await pool.query(
    `SELECT l.id, l.agent_id, l.brand_name, LOWER(TRIM(l.sent_to_email)) AS email, l.sent_at, l.source, l.contact_id,
            l.parent_id, l.touch_no, l.send_path, l.send_verify_status, l.bounced_at,
            p.source AS root_source, p.contact_id AS root_contact,
            (SELECT e.system FROM email_sends e WHERE e.ref_id = l.id ORDER BY e.sent_at ASC LIMIT 1) AS system,
            v.result, v.status, v.detail, v.checked_at, v.source AS v_source,
            s.kind AS sup_kind, s.reason AS sup_reason,
            u.name AS agent_name, u.email AS agent_email
       FROM outreach_logs l
       LEFT JOIN outreach_logs p ON p.id = l.parent_id
       LEFT JOIN email_verification v ON v.email = LOWER(TRIM(l.sent_to_email))
       LEFT JOIN email_suppression s ON s.email = LOWER(TRIM(l.sent_to_email))
       LEFT JOIN users u ON u.id = l.agent_id
      WHERE l.sent_at > NOW() - make_interval(days => $1)${scope}
      ORDER BY u.name NULLS LAST, l.agent_id, l.sent_at`, params).catch((e) => { console.error('[bounce-report] logs: ' + e.message); return { rows: [] }; })).rows;
  // The athlete's brand email and new inbox messages are recorded only in
  // email_sends (services/sendRules).
  const other = (await pool.query(
    `SELECT e.id, e.agent_id, e.email, e.sent_at, e.system, e.subject,
            v.result, v.status, v.detail, v.checked_at, v.source AS v_source,
            s.kind AS sup_kind, s.reason AS sup_reason, u.name AS agent_name, u.email AS agent_email
       FROM email_sends e
       LEFT JOIN email_verification v ON v.email = e.email
       LEFT JOIN email_suppression s ON s.email = e.email
       LEFT JOIN users u ON u.id = e.agent_id
      WHERE e.system IN ('athlete', 'compose') AND e.sent_at > NOW() - make_interval(days => $1)${agentId ? ' AND e.agent_id = $2' : ''}
      ORDER BY e.sent_at`, params).catch((e) => { console.error('[bounce-report] email_sends: ' + e.message); return { rows: [] }; })).rows;
  return { logs, other };
}

// Pure. One send -> { path, how, status, bounced }.
function classify(r) {
  const origin = r.root_source || r.source || null;
  const contact = r.contact_id || r.root_contact;
  let path = r.send_path || null;
  if (!path) path = r.system === 'manual' ? 'hand' : (origin === 'nightly-queue' ? 'card' : 'hand');
  const how = path === 'card' ? (Number(r.touch_no || 1) > 1 ? 'follow-up to a card' : 'morning card')
    : r.system === 'athlete' ? 'athlete brand email'
    : r.system === 'compose' ? 'inbox, new message'
    : r.system === 'manual' ? (origin === 'prewarm' ? 'editor Send (Deal Scan draft)' : contact ? 'editor Send (Write Outreach)' : 'editor Send')
    : origin === 'prewarm' ? 'Deal Scan draft, approved'
    : contact ? 'Write Outreach draft, approved'
    : 'approved by hand';
  const status = r.send_verify_status || SG.categoryOf(r.result ? r : null, r.sent_at);
  const bounced = !!r.bounced_at || r.sup_kind === 'bounce';
  return { path, how, status: STATUSES.includes(status) ? status : 'unverified', bounced };
}

function build(data) {
  const agents = new Map();
  const totals = { sends: 0, bounced: 0, cells: {} };
  const add = (r, c) => {
    const k = r.agent_id || '(no agent)';
    if (!agents.has(k)) agents.set(k, { agentId: k, name: r.agent_name || null, email: r.agent_email || null, sends: 0, bounced: 0, cells: {}, how: {}, notValid: [] });
    const A = agents.get(k);
    const cell = `${c.path}|${c.status}`;
    for (const T of [A, totals]) {
      T.sends++;
      T.cells[cell] = T.cells[cell] || { sends: 0, bounced: 0 };
      T.cells[cell].sends++;
      if (c.bounced) { T.bounced++; T.cells[cell].bounced++; }
    }
    A.how[c.how] = (A.how[c.how] || 0) + 1;
    if (c.status !== 'valid' || c.bounced) {
      A.notValid.push({ at: r.sent_at, path: c.path, how: c.how, status: c.status, email: r.email, brand: r.brand_name || r.subject || null,
        bounced: c.bounced, detail: r.detail || null });
    }
  };
  for (const r of data.logs) add(r, classify(r));
  for (const r of data.other) add(r, classify({ ...r, send_path: 'hand' }));
  return { agents, totals };
}

function table(T) {
  const L = [];
  L.push(`    ${'path'.padEnd(8)}${STATUSES.map((s) => s.padStart(12)).join('')}`);
  for (const p of PATHS) {
    const row = STATUSES.map((s) => {
      const c = T.cells[`${p}|${s}`];
      return (c ? `${c.sends}${c.bounced ? ` (${c.bounced}b)` : ''}` : '0').padStart(12);
    }).join('');
    L.push(`    ${(p === 'hand' ? 'by hand' : 'card').padEnd(8)}${row}`);
  }
  return L;
}

function format(rep, { days = 30 } = {}) {
  const L = [];
  L.push(`BOUNCE REPORT: emails sent in the last ${days} days, by agent, split by path and by what was known about the address as it left.`);
  L.push('Columns: the verification at send time. "(Nb)": N of those bounced ("This bounced", or suppressed as a bounce).');
  L.push('');
  for (const A of rep.agents.values()) {
    L.push(`${A.name || A.agentId}${A.email ? ' <' + A.email + '>' : ''}: ${A.sends} sent, ${A.bounced} bounced`);
    L.push(...table(A));
    L.push('    by: ' + Object.entries(A.how).map(([k, n]) => `${n} ${k}`).join(', '));
    if (A.notValid.length) {
      L.push('    not valid at send, or bounced:');
      for (const x of A.notValid) {
        L.push(`      ${new Date(x.at).toISOString().slice(0, 10)}  ${x.path === 'hand' ? 'by hand' : 'card   '}  ${x.status.padEnd(10)} ${x.email || '(no address)'}`
          + `${x.brand ? ' -> ' + x.brand : ''}  [${x.how}]${x.bounced ? '  BOUNCED' : ''}`);
      }
    }
    L.push('');
  }
  L.push(`ALL AGENTS: ${rep.totals.sends} sent, ${rep.totals.bounced} bounced`);
  L.push(...table(rep.totals));
  return L.join('\n');
}

async function run(pool, opts = {}) {
  const days = Math.max(1, Math.min(365, parseInt(opts.days, 10) || 30));
  const rep = build(await gather(pool, { days, agentId: opts.agentId || null }));
  rep.days = days;
  return rep;
}

module.exports = { gather, classify, build, format, run, STATUSES, PATHS };
