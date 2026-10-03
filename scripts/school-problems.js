'use strict';
// ── ATHLETES THE LOCAL LANE CANNOT PLACE, EVERY AGENT ───────────────────────
// services/localLaneCheck over every roster: no school, a pro team in the school
// field, a pro with no city, a school last night's run could not find. Each
// agent sees their own on Home with the fix.
//
//   node scripts/school-problems.js            list
//   node scripts/school-problems.js --apply    also apply the fixes the record
//                                               itself determines (a pro team
//                                               typed as the school -> pro with
//                                               that team and its city)
//   /api/admin/scripts/school-problems?text=1[&apply=1]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const SC = require(ROOT + 'server/services/localLaneCheck.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const apply = process.argv.includes('--apply');
  const agents = (await P.query(
    `SELECT DISTINCT u.id, u.name, u.email FROM users u JOIN athletes a ON a.agent_id = u.id
      WHERE u.role IN ('agent','admin') AND u.archived IS NOT TRUE ORDER BY u.name NULLS LAST`)).rows;
  const L = [`SCHOOL PROBLEMS${apply ? ' (applying the record-determined fixes)' : ' (read-only; &apply=1 applies the one-click fixes)'}`, ''];
  let n = 0, fixed = 0;
  for (const u of agents) {
    const list = await SC.forAgent(P, u.id);
    for (const p of list) {
      n++;
      let tail = p.fix ? `  fix: ${p.fixLabel}` : '  (the agent must supply this)';
      if (apply && p.fix) { const r = await SC.applyFix(P, u.id, p.athleteId); if (r.ok) { fixed++; tail = `  FIXED: ${JSON.stringify(r.applied)}`; } else tail = '  not fixed: ' + r.error; }
      L.push(`  ${String(p.name).padEnd(24)} ${String(u.name || u.email).padEnd(22)} ${p.code.padEnd(15)} ${p.text}${tail}`);
    }
  }
  L.push('', `${n} athlete(s)${apply ? `, ${fixed} fixed` : ''}. Each agent sees theirs on Home with the fix.`);
  console.log(L.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('school-problems: FAILED', e.message); process.exit(1); });
