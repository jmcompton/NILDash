'use strict';
// ── RUN THE PREFLIGHT NOW ───────────────────────────────────────────────────
//
// One real call to every external service the night depends on
// (services/preflight), printed and written to service_checks. Nothing is
// emailed unless --alert.
//
//   node scripts/preflight.js
//   node scripts/preflight.js --alert
//   /api/admin/scripts/preflight?text=1   (&alert=1)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const PF = require(ROOT + 'server/services/preflight.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const run = await PF.runAll(P);
  console.log(`PREFLIGHT  ${new Date().toISOString()}\n`);
  for (const r of run.results) {
    console.log(`  ${r.ok ? 'ok    ' : 'FAILED'}  ${r.service.padEnd(22)} ${String(r.ms).padStart(6)}ms  `
      + (r.ok ? (typeof r.detail === 'string' ? r.detail : '') : r.error));
  }
  if (run.failed.length) {
    const msg = PF.render(run);
    console.log('\n' + msg.text);
    if (process.argv.includes('--alert')) {
      try {
        const to = process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL;
        if (!to) throw new Error('no alert destination: set ADMIN_ALERT_EMAIL');
        const resend = require(ROOT + 'server/services/resendChecked.js').makeResend(process.env.RESEND_API_KEY);
        await resend.emails.send({ from: process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>',
          to, subject: msg.subject, text: msg.text, html: msg.html });
        console.log('\nAlert sent to ' + to + '.');
      } catch (e) { console.log('\nAlert NOT sent: ' + e.message); }
    }
  } else {
    console.log('\nEvery service answered.');
  }
  try { await P.end(); } catch (_) {}
  process.exit(run.failed.length ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error('preflight: FAILED', e.message); process.exit(1); });
