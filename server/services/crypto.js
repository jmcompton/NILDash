// server/services/crypto.js
// AES-256-GCM token encryption for OAuth credentials.
// Uses Node.js built-in crypto — no new npm packages required.
// KEY is derived from EMAIL_ENCRYPTION_KEY env var (32 bytes / 64 hex chars).
// If the env var is missing we fall back to a deterministic dev key and warn.

'use strict';
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const raw = process.env.EMAIL_ENCRYPTION_KEY;
  if (raw && raw.length === 64) return Buffer.from(raw, 'hex');
  // Derive a consistent key from SESSION_SECRET so dev works without extra config
  console.warn('[crypto] EMAIL_ENCRYPTION_KEY not set — deriving key from SESSION_SECRET. Set EMAIL_ENCRYPTION_KEY in production.');
  const secret = process.env.SESSION_SECRET || 'nildash-dev-secret';
  return crypto.createHash('sha256').update(secret).digest();
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

/**
 * Decrypt a string produced by encrypt().  Returns plaintext or null on failure.
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const key = getKey();
    const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    console.error('[crypto] Decrypt failed:', e.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
