'use strict';
// ── /api/ops/report: WHAT IS BROKEN, FOR AN AGENT THAT RUNS WITHOUT A LOGIN ──
//
// Every admin page needs the founder's browser session, so nothing that runs
// on a schedule could see what failed overnight. This is the same picture,
// read only, behind one token instead of a login:
//   - the status page (services, payment failures, faults, nights by agent
//     and by university, quiet teams)
//   - every university: the university-status text (build, last night, the
//     estimate, the runway, what is missing)
//   - approvals that did not send, open, by agent, with the latest reason
//
// OPS_READ_TOKEN unset: the route answers 404 as if it did not exist. It
// reads, never writes, never spends, never sends. A wrong token is 404 too.
const crypto = require('crypto');

function tokenOk(req) {
  const want = String(process.env.OPS_READ_TOKEN || '');
  if (want.length < 24) return false;
  const h = String(req.headers.authorization || '');
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return got.length > 0 && crypto.timingSafeEqual(a, b);
}

async function universityText(pool, id) {
  const CB = require('./campusBuild');
  const CN = require('./campusNightly');
  const v = await CB.verify(pool, id);
  const L = [CB.formatVerify(v)];
  if (v.lastBuild) L.push('\n' + CB.formatBuild(v.lastBuild));
  if (v.lastNight) L.push('\n' + CN.formatNight(v.lastNight));
  const est = await CN.estimate(pool, id).catch(() => null);
  if (est && est.ok) L.push('\n' + CN.formatEstimate(est));
  return L.join('\n');
}

async function collect(pool) {
  const out = { at: new Date().toISOString(), readErrors: [] };
  const step = async (label, fn) => {
    try { return await fn(); } catch (e) { out.readErrors.push(`${label}: ${e.message}`); return null; }
  };
  out.status = await step('status page', () => require('./statusPage').collect(pool));
  const ids = await step('universities', async () =>
    (await pool.query(`SELECT u.id FROM universities u WHERE EXISTS (SELECT 1 FROM university_teams t WHERE t.university_id = u.id) ORDER BY u.id`)).rows.map((r) => r.id));
  out.universities = [];
  for (const id of ids || []) {
    out.universities.push({ id, text: await step(`university ${id}`, () => universityText(pool, id)) });
  }
  out.unsentByAgent = await step('approval faults', () => require('./sendFaults').byAgentOpen(pool));
  out.unsentReasons = await step('approval fault reasons', async () => (await pool.query(
    `SELECT f.kind, COUNT(*)::int AS n, (ARRAY_AGG(f.why ORDER BY f.detected_at DESC))[1] AS latest
       FROM approval_faults f WHERE f.resolved_at IS NULL GROUP BY 1 ORDER BY n DESC`)).rows);
  return out;
}

function formatText(r) {
  const L = [`OPS REPORT ${r.at}`];
  const s = r.status;
  if (s) {
    const red = (s.services || []).filter((x) => x.state === 'failed');
    L.push('', `SERVICES FAILING: ${red.length ? red.map((x) => `${x.service} (${String(x.error || '').slice(0, 200)})`).join('; ') : 'none'}`);
    if ((s.payment || []).length) L.push(`PAYMENT FAILURES: ${s.payment.map((p) => `${p.service}: ${String(p.reason || '').slice(0, 160)}`).join('; ')}`);
    L.push('', 'FAULTS (latest):');
    for (const f of (s.faults || []).slice(0, 30)) L.push(`  ${JSON.stringify(f).slice(0, 300)}`);
    L.push('', 'AGENT NIGHTS:');
    for (const n of (s.agents || []).slice(0, 3)) L.push(`  ${JSON.stringify(n).slice(0, 1500)}`);
    L.push('', 'UNIVERSITY NIGHTS:');
    for (const n of (s.universities || []).slice(0, 3)) L.push(`  ${JSON.stringify(n).slice(0, 1500)}`);
    if ((s.quietTeams || []).length) L.push('', `QUIET TEAMS: ${JSON.stringify(s.quietTeams).slice(0, 1000)}`);
    if ((s.readErrors || []).length) L.push('', `STATUS READ ERRORS: ${s.readErrors.join('; ')}`);
  }
  for (const u of r.universities || []) L.push('', `══ UNIVERSITY ${u.id} ══`, u.text || '(could not read)');
  L.push('', 'APPROVED, NOT SENT (open, by agent):');
  for (const a of r.unsentByAgent || []) L.push(`  ${a.email}: ${a.n} (${a.ours} ours), latest ${a.latest_kind}`);
  L.push('', 'APPROVED, NOT SENT (by reason):');
  for (const x of r.unsentReasons || []) L.push(`  ${x.kind}: ${x.n}; latest: ${String(x.latest || '').slice(0, 300)}`);
  if (r.readErrors.length) L.push('', `READ ERRORS: ${r.readErrors.join('; ')}`);
  return L.join('\n') + '\n';
}

module.exports = { tokenOk, collect, formatText, universityText };
