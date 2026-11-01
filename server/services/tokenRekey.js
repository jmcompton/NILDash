'use strict';
// ── REWRITE EVERY STORED TOKEN WITH THE CURRENT KEY ─────────────────────────
// After EMAIL_ENCRYPTION_KEY changes (services/crypto: set the new key, keep
// the old one in EMAIL_ENCRYPTION_KEY_PREVIOUS), every token still written
// with the old key is read with the old key, re-encrypted with the new one,
// and saved. Dry run unless apply. Never prints a token or a key.
//
// A token no key opens is left exactly as it is and counted: rewriting it
// would only lose it for good. The agent will be asked to reconnect, as today.

const C = require('./crypto');

// Every encrypted column: table, id column, token column.
const COLUMNS = [
  { table: 'email_accounts', id: 'id', col: 'access_token_enc' },
  { table: 'email_accounts', id: 'id', col: 'refresh_token_enc' },
  { table: 'instagram_connections', id: 'athlete_id', col: 'access_token_enc' },
];

async function tableExists(pool, table) {
  const r = await pool.query(`SELECT to_regclass($1) AS t`, [table]);
  return !!(r.rows[0] && r.rows[0].t);
}

async function run(pool, opts = {}) {
  const apply = opts.apply === true;
  const out = { apply, keys: C.keyring(), columns: [] };
  for (const c of COLUMNS) {
    const s = { table: c.table, col: c.col, total: 0, current: 0, rewritten: 0, wouldRewrite: 0, unreadable: 0, byOldKey: {} };
    out.columns.push(s);
    if (!(await tableExists(pool, c.table))) { s.missing = true; continue; }
    const rows = (await pool.query(`SELECT ${c.id} AS id, ${c.col} AS enc FROM ${c.table} WHERE ${c.col} IS NOT NULL AND ${c.col} <> ''`)).rows;
    for (const r of rows) {
      s.total++;
      const o = C.open(r.enc);
      if (o.plaintext === null) { s.unreadable++; continue; }
      if (o.keyLabel === 'current') { s.current++; continue; }
      s.byOldKey[o.keyLabel] = (s.byOldKey[o.keyLabel] || 0) + 1;
      if (!apply) { s.wouldRewrite++; continue; }
      // Only rewrite the value we read: a token refreshed meanwhile is left
      // for the next run instead of being overwritten with a stale one.
      const u = await pool.query(`UPDATE ${c.table} SET ${c.col} = $2 WHERE ${c.id} = $1 AND ${c.col} = $3`, [r.id, C.encrypt(o.plaintext), r.enc]);
      if (u.rowCount) s.rewritten++; else s.wouldRewrite++;
    }
  }
  out.leftOnOldKeys = out.columns.reduce((t, s) => t + s.wouldRewrite, 0);
  out.unreadable = out.columns.reduce((t, s) => t + s.unreadable, 0);
  return out;
}

function format(out) {
  const L = [];
  L.push(`TOKEN RE-ENCRYPTION ${out.apply ? '(APPLIED)' : '(dry run: nothing changed; add apply=1)'}`);
  L.push(`Keys on the ring, in order tried: ${out.keys.join(', ')}`);
  L.push('');
  for (const s of out.columns) {
    if (s.missing) { L.push(`${s.table}.${s.col}: table not present`); continue; }
    const old = Object.entries(s.byOldKey).map(([k, n]) => `${n} on ${k}`).join(', ') || 'none';
    L.push(`${s.table}.${s.col}: ${s.total} stored, ${s.current} already on the current key, `
      + (out.apply ? `${s.rewritten} rewritten` : `${s.wouldRewrite} would be rewritten`)
      + `, ${s.unreadable} unreadable with any key (old keys found: ${old})`);
  }
  L.push('');
  if (out.unreadable) L.push(`${out.unreadable} token(s) open with no key on the ring. They are untouched; those agents or athletes must reconnect. If this is new, an old key is missing from EMAIL_ENCRYPTION_KEY_PREVIOUS / SESSION_SECRET_PREVIOUS.`);
  if (!out.apply && out.leftOnOldKeys) L.push(`Next: open this again with apply=1 to rewrite ${out.leftOnOldKeys} token(s).`);
  if (out.apply && !out.leftOnOldKeys) L.push('Done. When a dry run shows 0 left on old keys, remove EMAIL_ENCRYPTION_KEY_PREVIOUS and SESSION_SECRET_PREVIOUS.');
  if (out.apply && out.leftOnOldKeys) L.push(`${out.leftOnOldKeys} changed while this ran; run apply=1 once more.`);
  return L.join('\n');
}

module.exports = { run, format, COLUMNS };
