'use strict';
// ── WHO THE NIGHT RAN, AND WHY NOT THE REST ─────────────────────────────────
//
// floor-report counts an athlete-night only when its detail carries `loop`
// metrics (the loop shipped 2026-09-30; nights before it have none). An
// athlete missing from that count was kept out by one of the rules below,
// read straight from outreach_queue_runs. Every athlete, every night:
//
//   RAN        the loop ran for them (what floor-report counts)
//   NO-ROW     no run row for their agent that night: the scheduler never
//              claimed the agent (server down 1-5am Central, queue disabled,
//              or the night not reached)
//   SKIP       the agent was skipped by rule; the note says which (dormant
//              off-week, no agent name)
//   UNFIN      the agent's run was claimed and never finished (the process
//              stopped mid-run); its details were never written
//   NOT-REACHED  the run finished without them: the agent's night cap
//              stopped the roster early, or they were added after the run
//   PAUSED     held by the three-night backoff
//   FULL       all five slots still hold cards the agent has not actioned
//   ERROR      their fill threw
//   NO-LOOP    in the run, returned before the loop for another stated reason
//
//   node scripts/nightly-coverage.js [--days 7] [--athlete Natalie]
//   /api/admin/scripts/nightly-coverage?text=1[&days=7][&athlete=Wagner]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const Job = require(ROOT + 'server/jobs/outreachQueue.js');
const SC = require(ROOT + 'server/services/schoolCheck.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const ymd = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

function classify(run, athleteId) {
  if (!run) return { cls: 'NO-ROW' };
  const note = String(run.note || '');
  if (/^skipped:/.test(note) || (run.finished_at && run.filled === 0 && Array.isArray(run.details) && !run.details.length && note)) return { cls: 'SKIP', why: note };
  if (!run.finished_at) return { cls: 'UNFIN', why: 'claimed ' + (run.created_at ? new Date(run.created_at).toISOString().slice(11, 16) + ' UTC' : '?') + ', never finished' };
  const d = (Array.isArray(run.details) ? run.details : []).find((x) => x && x.athleteId === athleteId);
  if (!d) return { cls: 'NOT-REACHED', why: 'not in the finished run' + (note ? ' (' + note + ')' : '') };
  if (d.loop) return { cls: 'RAN', why: `${d.filled || 0} placed` };
  if (d.error) return { cls: 'ERROR', why: d.error };
  if (d.paused || d.emptyReason === 'paused') return { cls: 'PAUSED', why: d.note || '' };
  if (d.emptyReason === 'slots-full') return { cls: 'FULL', why: d.note || '' };
  return { cls: 'NO-LOOP', why: d.note || d.emptyReason || 'no reason recorded' };
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const days = Math.max(1, parseInt(arg('--days') || '7', 10) || 7);
  const only = String(arg('--athlete') || '').toLowerCase();
  const today = Job.today();
  const dates = []; for (let i = days - 1; i >= 0; i--) { const t = new Date(today + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - i); dates.push(ymd(t)); }
  const aths = (await P.query(
    `SELECT a.id, a.data, a.data->>'name' AS name, a.created_at, u.id AS agent_id, u.name AS agent, u.email AS agent_email, u.last_login
       FROM athletes a JOIN users u ON u.id = a.agent_id
      WHERE u.role IN ('agent','admin') AND u.archived IS NOT TRUE
      ORDER BY u.name NULLS LAST, a.data->>'name'`)).rows;
  const runs = new Map();
  for (const r of (await P.query(`SELECT agent_id, run_date, filled, note, details, finished_at, created_at FROM outreach_queue_runs WHERE run_date >= $1::date`, [dates[0]])).rows) {
    runs.set(r.agent_id + '|' + ymd(r.run_date), r);
  }
  const L = [];
  L.push(`NIGHTLY COVERAGE   ${dates[0]} .. ${dates[dates.length - 1]}   ${aths.length} athletes on ${new Set(aths.map((a) => a.agent_id)).size} active agent accounts`, '');
  // ── PER NIGHT ──
  const CLS = ['RAN', 'FULL', 'PAUSED', 'NOT-REACHED', 'UNFIN', 'SKIP', 'NO-ROW', 'ERROR', 'NO-LOOP'];
  L.push('PER NIGHT   ' + CLS.map((c) => c.padStart(11)).join(''));
  const grid = new Map();
  for (const a of aths) grid.set(a.id, dates.map((d) => (a.created_at && ymd(a.created_at) > d ? { cls: '-', why: 'not on the roster yet' } : classify(runs.get(a.agent_id + '|' + d), a.id))));
  dates.forEach((d, i) => {
    const n = {}; for (const a of aths) { const c = grid.get(a.id)[i].cls; n[c] = (n[c] || 0) + 1; }
    const rowsTonight = [...runs.keys()].filter((k) => k.endsWith('|' + d)).length;
    L.push(`${d}  ` + CLS.map((c) => String(n[c] || 0).padStart(11)).join('') + `   (${rowsTonight} agent run row(s))`);
  });
  // ── PER AGENT: the gate ──
  L.push('', 'AGENTS (active = signed in within ' + Job.INACTIVE_AFTER_DAYS + ' days; dormant are filled weekly from this deploy on)');
  const byAgent = new Map(); for (const a of aths) { const x = byAgent.get(a.agent_id) || { a, n: 0 }; x.n++; byAgent.set(a.agent_id, x); }
  for (const { a, n } of byAgent.values()) {
    const why = Job.inactiveSkip({ last_login: a.last_login });
    L.push(`  ${(a.agent || a.agent_email || a.agent_id).padEnd(26)} ${String(n).padStart(3)} athlete(s)  ${why ? 'DORMANT: ' + why : 'active, last login ' + ymd(a.last_login)}`);
  }
  // ── PER ATHLETE ──
  L.push('', 'ATHLETES   one column a night: R ran, F full, P paused, N not reached, U unfinished, S skipped, - no row, E error, L no loop');
  const CH = { RAN: 'R', FULL: 'F', PAUSED: 'P', 'NOT-REACHED': 'N', UNFIN: 'U', SKIP: 'S', 'NO-ROW': '-', ERROR: 'E', 'NO-LOOP': 'L', '-': ' ' };
  for (const a of aths) {
    if (only && !String(a.name || '').toLowerCase().includes(only)) continue;
    const g = grid.get(a.id);
    const sp = SC.problemFor(a);
    L.push(`  ${g.map((x) => CH[x.cls] || '?').join('')}  ${String(a.name || a.id).padEnd(26)} ${String(a.agent || '').padEnd(20)}${sp ? '  [' + sp.code + ']' : ''}`);
    if (only) g.forEach((x, i) => L.push(`        ${dates[i]}  ${x.cls.padEnd(12)} ${x.why || ''}`));
  }
  console.log(L.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('nightly-coverage: FAILED', e.message); process.exit(1); });
module.exports = { classify };
