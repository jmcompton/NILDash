'use strict';
// ── A CUSTOMER'S OWN MAILBOX (Territory and Done For You) ───────────────────
//
// Prospector sends a paying IT company's leads from that company's own
// Microsoft 365 mailbox, so the emails are theirs: their name, their domain,
// replies in their inbox. They connect it once from their leads page
// (/p/<token>): Microsoft's sign-in, the same app and callback as NILDash's
// Outlook connection, with the customer token in the state instead of a
// NILDash login. The token is the secret that proves which customer it is.
//
// Permissions: Mail.Send (send as them) and Mail.Read (see replies and
// bounces, so a sequence stops the moment someone answers). Nothing else.
// Tokens are stored encrypted with NILDash's email key (services/crypto),
// refreshed here when they are about to expire.

const outlook = require('../providers/outlook');
const { encrypt, decrypt } = require('../crypto');
const Billing = require('./billing');

const lc = (s) => String(s || '').trim().toLowerCase();

let _ensured = false;
async function ensureTables(pool) {
  if (_ensured) return;
  await Billing.ensureTables(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_mailboxes (
    customer_id INT PRIMARY KEY REFERENCES prospector_customers(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'outlook', address TEXT NOT NULL, display_name TEXT,
    access_token_enc TEXT, refresh_token_enc TEXT, token_expiry TIMESTAMPTZ, granted_scopes TEXT,
    can_send BOOLEAN, can_read BOOLEAN, status TEXT NOT NULL DEFAULT 'active', last_error TEXT,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  _ensured = true;
}

// The Microsoft sign-in link for one customer. The state says "Prospector"
// and carries their token; routes/email.js hands the callback here.
function connectUrl(token, deps = {}) {
  const state = Buffer.from(JSON.stringify({ prospector: String(token || ''), provider: 'outlook' })).toString('base64url');
  return (deps.outlook || outlook).getAuthUrl(state, { read: true });
}

// The callback: exchange the code, save the mailbox. -> { customer, mailbox }.
async function onCallback(pool, st, code, deps = {}) {
  await ensureTables(pool);
  const c = await Billing.byToken(pool, st && st.prospector);
  if (!c) throw Object.assign(new Error('That link has expired. Open your leads page and connect again.'), { status: 404 });
  const t = await (deps.outlook || outlook).exchangeCode(code, { read: true });
  if (!t.email) throw new Error('Microsoft did not say which mailbox this is.');
  await pool.query(`INSERT INTO prospector_mailboxes (customer_id, provider, address, display_name, access_token_enc, refresh_token_enc, token_expiry,
      granted_scopes, can_send, can_read, status, last_error, connected_at, updated_at)
    VALUES ($1,'outlook',$2,$3,$4,$5,$6,$7,$8,$9,'active',NULL,NOW(),NOW())
    ON CONFLICT (customer_id) DO UPDATE SET address = EXCLUDED.address, display_name = EXCLUDED.display_name,
      access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc, token_expiry = EXCLUDED.token_expiry,
      granted_scopes = EXCLUDED.granted_scopes, can_send = EXCLUDED.can_send, can_read = EXCLUDED.can_read, status = 'active',
      last_error = NULL, connected_at = NOW(), updated_at = NOW()`,
  [c.id, lc(t.email), t.displayName || null, encrypt(t.accessToken), encrypt(t.refreshToken), t.expiry || null,
    (t.grantedScopes || []).join(' '), t.canSend !== false, t.canRead !== false]);
  return { customer: c, mailbox: await get(pool, c.id) };
}

// What the customer and the admin may see: never a token.
async function get(pool, customerId) {
  await ensureTables(pool);
  const r = (await pool.query(`SELECT customer_id, provider, address, display_name, can_send, can_read, status, last_error, connected_at
    FROM prospector_mailboxes WHERE customer_id = $1`, [customerId])).rows[0];
  return r || null;
}

// The mailbox in the shape services/salesMailbox works with: getToken
// instead of an email_accounts id.
async function account(pool, customerId, deps = {}) {
  await ensureTables(pool);
  const row = (await pool.query(`SELECT * FROM prospector_mailboxes WHERE customer_id = $1`, [customerId])).rows[0];
  if (!row) return { ok: false, why: 'mailbox not connected' };
  if (row.status !== 'active') return { ok: false, address: row.address, why: row.last_error || 'mailbox disconnected; reconnect it from the leads page' };
  const ol = deps.outlook || outlook;
  return {
    ok: true, address: row.address, customerId, canSend: row.can_send !== false, canRead: row.can_read !== false, canMove: false,
    async getToken() {
      const cur = (await pool.query(`SELECT * FROM prospector_mailboxes WHERE customer_id = $1`, [customerId])).rows[0];
      const exp = cur && cur.token_expiry ? new Date(cur.token_expiry).getTime() : 0;
      if (cur && cur.access_token_enc && exp - Date.now() > 5 * 60000) return decrypt(cur.access_token_enc);
      try {
        const t = await ol.refreshAccessToken(decrypt(cur.refresh_token_enc));
        await pool.query(`UPDATE prospector_mailboxes SET access_token_enc = $2, refresh_token_enc = $3, token_expiry = $4, updated_at = NOW()
          WHERE customer_id = $1`, [customerId, encrypt(t.accessToken), encrypt(t.refreshToken), t.expiry || null]);
        return t.accessToken;
      } catch (e) {
        // A refresh Microsoft refuses (password changed, access removed): the
        // mailbox is marked disconnected and the customer is asked to reconnect.
        if (Number(e.status) === 400 || Number(e.status) === 401 || /invalid_grant|interaction_required/i.test(`${e.code || ''} ${e.message}`)) {
          await pool.query(`UPDATE prospector_mailboxes SET status = 'disconnected', last_error = $2, updated_at = NOW() WHERE customer_id = $1`,
            [customerId, String(e.message || '').slice(0, 300)]);
        }
        throw e;
      }
    },
  };
}

async function disconnect(pool, customerId) {
  await ensureTables(pool);
  await pool.query(`UPDATE prospector_mailboxes SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL,
    last_error = 'disconnected by the customer', updated_at = NOW() WHERE customer_id = $1`, [customerId]);
}

module.exports = { ensureTables, connectUrl, onCallback, get, account, disconnect, _reset() { _ensured = false; } };
