'use strict';
// REWRITE STORED MAILBOX AND INSTAGRAM TOKENS WITH THE CURRENT KEY
// (services/tokenRekey). Use after EMAIL_ENCRYPTION_KEY changes, with the old
// key in EMAIL_ENCRYPTION_KEY_PREVIOUS.
//
//   node scripts/reencrypt-tokens.js            dry run
//   node scripts/reencrypt-tokens.js --apply    do it
//   /api/admin/scripts/reencrypt-tokens?text=1          dry run
//   /api/admin/scripts/reencrypt-tokens?apply=1&text=1  do it
//
// Never prints a token or a key.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const R = require(ROOT + 'server/services/tokenRekey.js');
  const out = await R.run(store.pool, { apply: process.argv.includes('--apply') });
  console.log(R.format(out));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
