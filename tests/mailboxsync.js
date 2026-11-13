'use strict';
// Runs against the local test Postgres.
//
//   node tests/mailboxsync.js
//
// ── ONE BAD POLL MUST NOT DISCONNECT A MAILBOX
// Nov 12: Microsoft answered one inbox poll for an agent's Outlook with a 504
// and no message. emailSync set the mailbox to 'error', and the poller only
// ever read 'active' rows, so his inbox was never read again. Now only a
// refused login parks a mailbox; anything else stays active and is retried,
// a parked mailbox is retried hourly, and a good nightly token check puts it
// straight back.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };

function graphError(statusCode, code, message) {
  const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const P = store.pool;
  const outlook = require(REPO + 'server/services/providers/outlook.js');
  const S = require(REPO + 'server/services/emailSync.js');
  const { encrypt } = require(REPO + 'server/services/crypto.js');

  // ── The classifier ──────────────────────────────────────────────────────
  ok('Graph 504 with an empty message is temporary', S.authFailure(graphError(504, 'UnknownError', '')) === false);
  ok('Graph 503 is temporary', S.authFailure(graphError(503, 'ServiceNotAvailable', 'Service unavailable')) === false);
  ok('429 throttle is temporary', S.authFailure(graphError(429, 'TooManyRequests', 'Too many requests')) === false);
  ok('a network reset is temporary', S.authFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })) === false);
  ok('a timeout is temporary', S.authFailure(new Error('request timed out after 30000ms')) === false);
  ok('Graph 401 InvalidAuthenticationToken is a refused login', S.authFailure(graphError(401, 'InvalidAuthenticationToken', 'Lifetime validation failed, the token is expired.')) === true);
  ok('invalid_grant from the token endpoint is a refused login',
    S.authFailure(Object.assign(new Error('Microsoft token endpoint HTTP 400: invalid_grant: AADSTS700082: The refresh token has expired'), { status: 400, code: 'invalid_grant' })) === true);
  ok('Gmail invalid_grant is a refused login', S.authFailure(new Error('invalid_grant')) === true);
  ok('the empty 504 is described, not blank', /HTTP 504/.test(S.describeError(graphError(504, 'UnknownError', ''))) && /UnknownError/.test(S.describeError(graphError(504, 'UnknownError', ''))));

  // ── The poller, end to end, against the database ─────────────────────────
  const U = 'u-mbsync-agent';
  const ids = ['ea-mbsync-temp', 'ea-mbsync-auth', 'ea-mbsync-parked'];
  const clean = async () => {
    await P.query(`DELETE FROM email_sync_logs WHERE account_id = ANY($1)`, [ids]).catch(() => {});
    await P.query(`DELETE FROM email_accounts WHERE id = ANY($1)`, [ids]);
    await P.query(`DELETE FROM users WHERE id = $1`, [U]);
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'Sync Agent','sync@mbsync.example','x','agent')`, [U]);
  const future = new Date(Date.now() + 3600 * 1000);
  const ins = (id, addr, status, lastSync) => P.query(
    `INSERT INTO email_accounts (id, user_id, provider, email_address, access_token_enc, refresh_token_enc, token_expiry, status, last_sync)
     VALUES ($1,$2,'outlook',$3,$4,$5,$6,$7,$8)`,
    [id, U, addr, encrypt('acc'), encrypt('ref'), future, status, lastSync]);
  await ins('ea-mbsync-temp', 'temp@mbsync.example', 'active', null);
  await ins('ea-mbsync-auth', 'auth@mbsync.example', 'active', null);
  await ins('ea-mbsync-parked', 'parked@mbsync.example', 'error', new Date(Date.now() - 2 * 3600 * 1000));

  const realFetch = outlook.fetchMessages;
  const realAvail = outlook.isAvailable;
  outlook.isAvailable = () => true;
  const status = async (id) => (await P.query(`SELECT status FROM email_accounts WHERE id = $1`, [id])).rows[0].status;
  const acct = async (id) => (await P.query(`SELECT * FROM email_accounts WHERE id = $1`, [id])).rows[0];

  // A 504 with no message: stays active.
  outlook.fetchMessages = async () => { throw graphError(504, 'UnknownError', ''); };
  await S.syncAccount(await acct('ea-mbsync-temp'));
  ok('a 504 leaves the mailbox active', (await status('ea-mbsync-temp')) === 'active', await status('ea-mbsync-temp'));
  const log = (await P.query(`SELECT error_message FROM email_sync_logs WHERE account_id = 'ea-mbsync-temp' ORDER BY started_at DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0];
  ok('the sync log says what happened, not nothing', !log || /HTTP 504/.test(log.error_message || ''), log);

  // A refused login: parked in 'error'.
  outlook.fetchMessages = async () => { throw graphError(401, 'InvalidAuthenticationToken', 'Access token has expired or is not yet valid.'); };
  await S.syncAccount(await acct('ea-mbsync-auth'));
  ok('a refused login parks the mailbox in error', (await status('ea-mbsync-auth')) === 'error', await status('ea-mbsync-auth'));

  // The poller picks up active rows AND a parked row last tried over an hour ago,
  // and a parked row that now syncs goes back to active.
  const seen = [];
  outlook.fetchMessages = async (_a, _r, _c, _n, o) => { seen.push(o.ownAddress); return { messages: [], nextCursor: null }; };
  await S.syncAllAccounts();
  await new Promise((r) => setTimeout(r, 1500));
  ok('the poller retries a mailbox parked over an hour ago', seen.includes('parked@mbsync.example'), seen);
  ok('the poller does not retry one parked a minute ago', !seen.includes('auth@mbsync.example'), seen);
  ok('a parked mailbox that syncs is active again', (await status('ea-mbsync-parked')) === 'active', await status('ea-mbsync-parked'));

  // A parked mailbox that fails again keeps its hourly clock (last_sync moves).
  await P.query(`UPDATE email_accounts SET status = 'error', last_sync = $2 WHERE id = $1`, ['ea-mbsync-parked', new Date(Date.now() - 2 * 3600 * 1000)]);
  outlook.fetchMessages = async () => { throw graphError(503, 'ServiceNotAvailable', 'busy'); };
  await S.syncAccount(await acct('ea-mbsync-parked'));
  const pk = await acct('ea-mbsync-parked');
  ok('a parked mailbox that fails again stays parked with a fresh retry clock',
    pk.status === 'error' && new Date(pk.last_sync).getTime() > Date.now() - 60 * 1000, { status: pk.status, last_sync: pk.last_sync });

  // A temporary failure at the token endpoint does not park the mailbox.
  await P.query(`UPDATE email_accounts SET token_expiry = $2 WHERE id = $1`, ['ea-mbsync-temp', new Date(Date.now() - 60 * 1000)]);
  const realRefresh = outlook.refreshAccessToken;
  outlook.refreshAccessToken = async () => { const e = new Error('Microsoft token endpoint HTTP 503: temporarily_unavailable'); e.status = 503; throw e; };
  outlook.fetchMessages = async () => { throw graphError(401, 'InvalidAuthenticationToken', 'expired'); };
  await S.syncAccount(await acct('ea-mbsync-temp'));
  ok('a 503 from the token endpoint leaves the mailbox active', (await status('ea-mbsync-temp')) === 'active', await status('ea-mbsync-temp'));
  outlook.refreshAccessToken = realRefresh;

  outlook.fetchMessages = realFetch;
  outlook.isAvailable = realAvail;
  await clean();
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
