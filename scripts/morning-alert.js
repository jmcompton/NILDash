'use strict';
// ── WHAT THIS MORNING'S ALERT SAYS ──────────────────────────────────────────
//
// Prints the admin alert services/morningAlert would send today: agents with
// athletes who got no cards last night, and Places market builds that failed
// in the last 24 hours. Prints only, unless --send.
//
//   node scripts/morning-alert.js           print it
//   node scripts/morning-alert.js --send    send it now, at any hour, unless
//                                           today's alert has already gone
//   /api/admin/scripts/morning-alert?text=1  (&send=1 to send)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const MA = require(ROOT + 'server/services/morningAlert.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  if (process.argv.includes('--send')) {
    const r = await MA.runOnce(P, { force: true });
    console.log(r.status ? `Alert ${r.status}${r.error ? ': ' + r.error : ''}.` : `Nothing sent: ${r.skipped}.`);
    if (r.msg) console.log('\n' + r.msg.text);
  } else {
    const report = await MA.collect(P);
    if (!report.problemCount) {
      console.log(`All clear for ${report.runDate}: ${report.cardsLastNight} card(s) last night, `
        + `${report.builds.total} market build(s) in 24h and none failed, ${report.newBusinesses24h} new business(es). Nothing would be sent.`);
    } else {
      console.log('WOULD SEND (not sent; add --send):\n\n' + MA.render(report).text);
    }
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('morning-alert: FAILED', e.message); process.exit(1); });
