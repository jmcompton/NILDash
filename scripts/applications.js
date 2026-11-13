'use strict';
// ── READY TO APPLY: EVERY QUEUED PROGRAM CARD, WITH ITS APPLICATION ─────────
// What Home's "Ready to apply" shows each agent (services/applyPacket), for
// every agent at once: the brand, the athlete, the link, every answer, and
// what is missing on the athlete. Read-only.
//
//   node scripts/applications.js [--agent <email>] [--limit N] [--close-bad]
//   /api/admin/scripts/applications?text=1&agent=<email>&limit=5   (&closebad=1)
// --close-bad closes the queued program cards whose link is not an
// application page (a homepage, a product page), as the nightly run does.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const AP = require(ROOT + 'server/services/applyPacket');
  const agentEmail = arg('--agent');
  const limit = parseInt(arg('--limit'), 10) || 50;
  const agents = (await P.query(
    `SELECT DISTINCT u.id, u.name, u.email FROM outreach_queue q JOIN users u ON u.id = q.agent_id
      WHERE q.state = 'queued' AND q.channel = 'program' ${agentEmail ? 'AND LOWER(u.email) = LOWER($1)' : ''}
      ORDER BY u.email`, agentEmail ? [agentEmail] : [])).rows;
  const bad = await AP.expireBadLinks(P, { apply: process.argv.includes('--close-bad') });
  console.log(`LINKS: ${bad.checked} queued program card(s) checked, ${bad.bad.length} not an application page${process.argv.includes('--close-bad') ? ' (closed)' : ' (dry run: add closebad=1 to close them)'}`);
  for (const b of bad.bad) console.log(`  ${b.brand}: ${b.url || 'no link'} (${b.why})`);
  console.log('');
  const tot = (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE state = 'queued' AND channel = 'program'`)).rows[0].n;
  console.log(`READY TO APPLY ${new Date().toISOString().slice(0, 10)}: ${tot} queued program card(s), ${agents.length} agent(s)\n`);
  let shown = 0;
  for (const u of agents) {
    const list = await AP.listForAgent(P, u.id);
    console.log(`== ${u.name || '?'} <${u.email}>: ${list.length}`);
    for (const a of list) {
      if (shown++ >= limit) break;
      console.log(`\n-- ${a.brand} for ${a.athleteName}${a.verified ? ' (Instagram verified)' : ''}`);
      if (a.offer) console.log(`   offer: ${a.offer}`);
      console.log(`   link: ${a.programUrl || 'NONE'}   send to athlete: ${a.mailto ? 'yes' : 'no athlete email on file'}`);
      if (a.missing.length) console.log(`   missing on the athlete: ${a.missing.join(', ')}`);
      for (const f of a.fields) console.log(`   ${f.label}: ${f.value}`);
    }
    console.log('');
  }
}

main().then(() => store.pool.end().catch(() => {})).then(() => process.exit(0))
  .catch((e) => { console.error('applications failed:', e && e.stack || e); process.exit(1); });
