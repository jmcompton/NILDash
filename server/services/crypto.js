// server/services/crypto.js
// AES-256-GCM token encryption for OAuth credentials.
// Uses Node.js built-in crypto — no new npm packages required.
// KEY is derived from EMAIL_ENCRYPTION_KEY env var (32 bytes / 64 hex chars).
// If the env var is missing we fall back to a key derived from SESSION_SECRET
// and warn.
//
// ── CHANGING THE KEY WITHOUT DISCONNECTING ANYONE ───────────────────────────
// Every agent's Gmail/Outlook tokens and every athlete's Instagram token are
// stored encrypted with this key. Swapping the key alone makes every stored
// token unreadable, and every agent would have to reconnect.
//
// So a key change is three steps:
//   1. Set EMAIL_ENCRYPTION_KEY to the NEW key and EMAIL_ENCRYPTION_KEY_PREVIOUS
//      to the OLD one (and SESSION_SECRET_PREVIOUS to the old session secret
//      if that is changing too). Deploy. New writes use the new key; reads try
//      the new key, then each old one.
//   2. Run /api/admin/scripts/reencrypt-tokens (dry run), then ?apply=1. Every
//      stored token is rewritten with the new key.
//   3. When the dry run reports nothing left on an old key, remove the
//      *_PREVIOUS variables.
// Encryption always uses the current key, never a previous one.

'use strict';
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

const fromHex = (raw) => (raw && /^[0-9a-f]{64}$/i.test(String(raw).trim()) ? Buffer.from(String(raw).trim(), 'hex') : null);
const fromSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest();

let _warned = false;
function getKey() {
  const k = fromHex(process.env.EMAIL_ENCRYPTION_KEY);
  if (k) return k;
  // Derive a consistent key from SESSION_SECRET so dev works without extra config
  if (!_warned) { console.warn('[crypto] EMAIL_ENCRYPTION_KEY not set — deriving key from SESSION_SECRET. Set EMAIL_ENCRYPTION_KEY in production.'); _warned = true; }
  return fromSecret(process.env.SESSION_SECRET || 'nildash-dev-secret');
}

// Every key a stored token may have been written with, current first, each
// once, with a label for reports (never the key itself).
function keyring() {
  const out = [];
  const seen = new Set();
  const add = (label, key) => {
    if (!key) return;
    const id = key.toString('hex');
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ label, key });
  };
  add('current', getKey());
  add('EMAIL_ENCRYPTION_KEY_PREVIOUS', fromHex(process.env.EMAIL_ENCRYPTION_KEY_PREVIOUS));
  // Tokens written before EMAIL_ENCRYPTION_KEY was set used SESSION_SECRET.
  if (process.env.SESSION_SECRET) add('SESSION_SECRET', fromSecret(process.env.SESSION_SECRET));
  if (process.env.SESSION_SECRET_PREVIOUS) add('SESSION_SECRET_PREVIOUS', fromSecret(process.env.SESSION_SECRET_PREVIOUS));
  return out;
}

/**
 * Encrypt a plaintext string.  Returns a single string: iv:authTag:ciphertext (all hex).
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function tryKey(key, ciphertext) {
  const [ivHex, authTagHex, encryptedHex] = String(ciphertext).split(':');
  if (!ivHex || !authTagHex || encryptedHex === undefined) throw new Error('not an encrypted token');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

/**
 * Decrypt with the key that wrote it. Returns { plaintext, keyLabel } or
 * { plaintext: null, error } when no key on the ring opens it.
 */
function open(ciphertext) {
  if (!ciphertext) return { plaintext: null, keyLabel: null };
  let lastErr = null;
  for (const { label, key } of keyring()) {
    try { return { plaintext: tryKey(key, ciphertext), keyLabel: label }; }
    catch (e) { lastErr = e; }
  }
  return { plaintext: null, keyLabel: null, error: lastErr ? lastErr.message : 'no key' };
}

/**
 * Decrypt a string produced by encrypt().  Returns plaintext or null on failure.
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const r = open(ciphertext);
  if (r.plaintext !== null) return r.plaintext;
  console.error('[crypto] Decrypt failed:', r.error);
  // OURS, NOT THE MAILBOX (services/ourFault). A token that will not decrypt
  // almost always means the key changed: EMAIL_ENCRYPTION_KEY, or
  // SESSION_SECRET when that is unset. Every agent then reads "reconnect",
  // which reconnecting only fixes one mailbox at a time.
  try {
    require('./ourFault').record('token-encryption',
      'a stored mailbox token could not be decrypted (' + r.error + ') with any key; did EMAIL_ENCRYPTION_KEY'
      + (process.env.EMAIL_ENCRYPTION_KEY ? '' : ' (unset, so SESSION_SECRET)')
      + ' change without EMAIL_ENCRYPTION_KEY_PREVIOUS set to the old one?', 'crypto.decrypt');
  } catch (_) { /* recording must never break a decrypt caller */ }
  return null;
}

module.exports = { encrypt, decrypt, open, keyring: () => keyring().map((k) => k.label) };
