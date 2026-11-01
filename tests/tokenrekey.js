'use strict';
// ── CHANGING THE TOKEN KEY WITHOUT DISCONNECTING ANYONE ──────────────────────
// services/crypto keyring + services/tokenRekey. Local test Postgres.
//
//   - with only the new key set, an old token is unreadable (today's failure);
//   - with the old key in EMAIL_ENCRYPTION_KEY_PREVIOUS it reads, and new
//     writes use the new key only;
//   - tokens from before EMAIL_ENCRYPTION_KEY existed (SESSION_SECRET) read too;
//   - the dry run counts and changes nothing; apply rewrites onto the new key,
//     leaves unreadable tokens untouched, and never prints a token or a key;
//   - a second run finds nothing left; the admin descriptor is wired.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('tokenrekeytest', { schema: true });
require('./helpers/offlineDns').install();

const OLD = 'a'.repeat(64), NEW = 'b'.repeat(64), SESS = 'old-session-secret-xyz';
process.env.SESSION_SECRET = SESS;
delete process.env.EMAIL_ENCRYPTION_KEY;
delete process.env.EMAIL_ENCRYPTION_KEY_PREVIOUS;
delete process.env.SESSION_SECRET_PREVIOUS;

const store = require(REPO + 'server/store.js');
const C = require(REPO + 'server/services/crypto.js');
const R = require(REPO + 'server/services/tokenRekey.js');
const fs = require('fs');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const P = () => store.pool;

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await require(REPO + 'server/services/instagramConnect.js').ensureTables?.(P()).catch(() => {});
  await P().query(`CREATE TABLE IF NOT EXISTS instagram_connections (athlete_id TEXT PRIMARY KEY, agent_id TEXT, access_token_enc TEXT, status TEXT NOT NULL DEFAULT 'connected', connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  // Written before EMAIL_ENCRYPTION_KEY existed: SESSION_SECRET.
  const fromSession = C.encrypt('session-era-refresh');
  // Written with the old key.
  process.env.EMAIL_ENCRYPTION_KEY = OLD;
  const oldA = C.encrypt('old-access'), oldR = C.encrypt('old-refresh'), oldIg = C.encrypt('old-ig');
  const garbage = '00:11:22';
  await P().query(`INSERT INTO email_accounts (id, user_id, provider, email_address, access_token_enc, refresh_token_enc) VALUES
    ('ea1', 'u1', 'gmail', 'a@x.test', $1, $2), ('ea2', 'u2', 'gmail', 'b@x.test', $3, $4)`, [oldA, oldR, garbage, fromSession]);
  await P().query(`INSERT INTO instagram_connections (athlete_id, agent_id, access_token_enc) VALUES ('ath1', 'u1', $1)`, [oldIg]);

  OUT.push('-- the key changes --');
  process.env.EMAIL_ENCRYPTION_KEY = NEW;
  process.env.SESSION_SECRET = 'new-session-secret';
  const blind = C.open(oldA);
  ok('only the new key set: an old token is unreadable (what a plain swap does)', blind.plaintext === null);
  process.env.EMAIL_ENCRYPTION_KEY_PREVIOUS = OLD;
  process.env.SESSION_SECRET_PREVIOUS = SESS;
  ok('old key kept as PREVIOUS: the old token reads', C.decrypt(oldA) === 'old-access' && C.open(oldA).keyLabel === 'EMAIL_ENCRYPTION_KEY_PREVIOUS');
  ok('a SESSION_SECRET-era token reads through SESSION_SECRET_PREVIOUS', C.decrypt(fromSession) === 'session-era-refresh');
  const fresh = C.encrypt('new-write');
  ok('new writes use the new key only', C.open(fresh).keyLabel === 'current');
  ok('the ring is labelled, current first, never the key itself', C.keyring()[0] === 'current' && !C.keyring().some((l) => /[0-9a-f]{32}/.test(l)), C.keyring());

  OUT.push('-- dry run --');
  const dry = await R.run(P());
  const rows0 = (await P().query(`SELECT access_token_enc, refresh_token_enc FROM email_accounts ORDER BY id`)).rows;
  ok('dry run changes nothing', rows0[0].access_token_enc === oldA && rows0[0].refresh_token_enc === oldR);
  ok('dry run counts what would move', dry.leftOnOldKeys === 4 && dry.unreadable === 1, { left: dry.leftOnOldKeys, un: dry.unreadable });
  const text = R.format(dry);
  ok('the report never prints a token or a key', !text.includes('old-access') && !text.includes(OLD) && !text.includes(NEW) && !text.includes(oldA.split(':')[2]));
  ok('the report says what to do next', /apply=1/.test(text) && /1 token\(s\) open with no key/.test(text), text);

  OUT.push('-- apply --');
  const done = await R.run(P(), { apply: true });
  const rows1 = (await P().query(`SELECT id, access_token_enc, refresh_token_enc FROM email_accounts ORDER BY id`)).rows;
  const ig1 = (await P().query(`SELECT access_token_enc FROM instagram_connections`)).rows[0].access_token_enc;
  ok('apply rewrites every readable token', done.columns.reduce((t, s) => t + s.rewritten, 0) === 4, done.columns);
  ok('  each now opens with the current key and the same value',
    C.open(rows1[0].access_token_enc).keyLabel === 'current' && C.decrypt(rows1[0].access_token_enc) === 'old-access'
    && C.decrypt(rows1[0].refresh_token_enc) === 'old-refresh' && C.decrypt(rows1[1].refresh_token_enc) === 'session-era-refresh'
    && C.open(ig1).keyLabel === 'current' && C.decrypt(ig1) === 'old-ig');
  ok('  an unreadable token is left exactly as it was', rows1[1].access_token_enc === garbage);

  delete process.env.EMAIL_ENCRYPTION_KEY_PREVIOUS;
  delete process.env.SESSION_SECRET_PREVIOUS;
  ok('after removing the old keys, everything rewritten still reads', C.decrypt(rows1[0].access_token_enc) === 'old-access' && C.decrypt(ig1) === 'old-ig');
  const again = await R.run(P());
  ok('a second dry run finds nothing left on an old key', again.leftOnOldKeys === 0 && /0 would be rewritten/.test(R.format(again)));

  OUT.push('-- wiring --');
  const D = require(REPO + 'server/scripts/admin/reencrypt-tokens.js');
  ok('admin script: dry run by default, apply=1 applies', D.name === 'reencrypt-tokens' && D.args({}).length === 0 && D.args({ apply: '1' })[0] === '--apply');
  ok('the script file exists', fs.existsSync(REPO + D.file));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
