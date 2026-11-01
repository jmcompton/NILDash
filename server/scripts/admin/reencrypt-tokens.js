'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/reencrypt-tokens
// After EMAIL_ENCRYPTION_KEY changes (old key in EMAIL_ENCRYPTION_KEY_PREVIOUS),
// rewrites every stored mailbox and Instagram token with the new key.
// Dry run unless apply=1. Never prints a token or a key.
//   /api/admin/scripts/reencrypt-tokens?text=1
//   /api/admin/scripts/reencrypt-tokens?apply=1&text=1
const def = { file: 'scripts/reencrypt-tokens.js', args: (q) => (q.apply === '1' ? ['--apply'] : []) };

module.exports = { name: 'reencrypt-tokens', file: def.file, args: def.args };
