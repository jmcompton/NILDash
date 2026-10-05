'use strict';
// ── THE NATIONAL AND SOCIAL LANES FOR ONE ATHLETE, BEFORE AND AFTER ─────────
//
// BEFORE: what the two lanes offered (the raw national comps and social index,
// in their own order). AFTER: what survives the signing-evidence bar
// (services/signingEvidence): a sourced deal with an athlete of comparable
// reach, or a verified program whose range takes this athlete, in the last 12
// months; household incumbents refused. Each kept brand shows its evidence and
// size band; each refused one, why. Read-only: nothing is written or spent.
//
//   node scripts/brand-lanes-before-after.js --athlete <id or name> [--agent <email>] [--max 3]
//   /api/admin/scripts/brand-lanes-before-after?athlete=Tess%20Court&text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const job = require(ROOT + 'server/jobs/outreachQueue.js');
  const Scout = require(ROOT + 'server/services/scout.js');
  const SE = require(ROOT + 'server/services/signingEvidence.js');
  const who = arg('athlete', ''), agent = arg('agent', ''), max = Math.max(1, Math.min(10, parseInt(arg('max', '3'), 10) || 3));
  const rows = (await P.query(`
    SELECT a.id, a.agent_id, a.data, a.data->>'name' AS name, a.data->>'school' AS school, a.data->>'hometown' AS hometown, u.email AS agent_email
      FROM athletes a JOIN users u ON u.id = a.agent_id
     WHERE ($1 = '' OR a.id = $1 OR LOWER(a.data->>'name') = LOWER($1))
       AND ($2 = '' OR LOWER(u.email) = LOWER($2))
     ORDER BY a.created_at LIMIT $3`, [who, agent, who ? 1 : max])).rows;
  if (!rows.length) { console.log('No athlete matched.'); return; }
  for (const a of rows) {
    const profile = job.athleteProfile(a);
    const subject = Scout.athleteSubject(profile, a.agent_id);
    const reach = SE.reachOf(subject);
    console.log(`\n═══ ${a.name}  (${(a.data || {}).sport || '?'}, ${a.school || '?'}; reach ${reach.toLocaleString()}; tier ${subject.tier || '?'}; lanes: ${Object.entries(subject.lanes || {}).filter(([, v]) => v).map(([k]) => k).join(', ')})  agent ${a.agent_email}`);
    for (const lane of ['national', 'social']) {
      if (!subject.lanes || !subject.lanes[lane]) { console.log(`\n  ${lane.toUpperCase()}: closed for this athlete's tier`); continue; }
      const raw = lane === 'national'
        ? await Scout.nationalCandidates(P, { limit: 10, store, athlete: subject })
        : await Scout.socialCandidates(P, { limit: 10, store, athlete: subject });
      const { kept, refused } = await SE.filterAndRank(P, raw, subject);
      console.log(`\n  ${lane.toUpperCase()} BEFORE (${raw.length}): ${raw.slice(0, 12).map((c) => c.brand_name).join(', ') || 'nothing'}`);
      console.log(`  ${lane.toUpperCase()} AFTER (${kept.length}):`);
      for (const c of kept.slice(0, 10)) console.log(`    ${c.brand_name}  [${c.sizeBand}${c.hasProgram ? ', PROGRAM' : ''}${c.sameSportEvidence ? ', same sport' : ''}]  ${c.evidenceNote}`);
      if (!kept.length) console.log('    nothing: no brand in this lane has evidence it signs athletes like this one');
      console.log(`  ${lane.toUpperCase()} REFUSED (${refused.length}):`);
      for (const r of refused.slice(0, 15)) console.log(`    ${r.brand}: ${r.why}`);
    }
  }
}
main()
  .catch((e) => { console.error('brand-lanes-before-after FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
