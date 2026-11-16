'use strict';
// No database. Run:  node tests/adminlink.js
//
// ── A SET-PASSWORD LINK FOR TEXTING (POST /api/admin/set-password-link) ─────
// JohnMark invites an agent and wants to text the link, not email it. The
// route is admin-only, returns the link without sending anything, and goes
// through passwordReset.issueResetToken so the token is hashed at rest and
// earlier unused links for that address stop working.
const fs = require('fs');
const path = require('path');
const IX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
let OUT = [], F = 0;
const ok = (n, c) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n); } };
const i = IX.indexOf("app.post('/api/admin/set-password-link'");
const body = i >= 0 ? IX.slice(i, IX.indexOf('\n});', i)) : '';
ok('the route exists', i >= 0);
ok('admin only', /if \(!admin \|\| admin\.email !== ADMIN_EMAIL\) return res\.status\(403\)/.test(body));
ok('issued through issueResetToken (hashed, earlier links retired), with the invite lifetime', /pwReset\.issueResetToken\(store\.pool, \{ email, ttlMs: ttl \}\)/.test(body) && /pwReset\.agentInviteTtlMs\(\)/.test(body));
ok('returns the link and sends nothing', /resetUrl: pwReset\.resetUrl\(process\.env\.APP_URL, token\)/.test(body) && !/resend\.|emails\.send|sendMail/.test(body));
ok('refuses an unknown email and an admin account', /status\(404\)\.json\(\{ error: 'No account with that email' \}\)/.test(body) && /user\.role === 'admin'/.test(body));
ok('never logs the token', !/console\.log\([^)]*token/.test(body));
console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
