'use strict';
// ── THE LINKEDIN EXPORT, IN THE DATABASE ────────────────────────────────────
//
// The prospecting brief filters ~1,700 LinkedIn connections down to the people
// worth an opener. Until now that export lived at ~/nildash-briefs/Connections.csv
// on one Mac, which meant the brief could only run on that Mac: a server has
// no such file, and the one workaround (BRIEFS_CONNECTIONS_URL, a public
// download link) puts a list of real people's names, employers and email
// addresses behind a URL anybody who finds it can fetch.
//
// So the export lives here instead. It is uploaded through an admin page, kept
// in Postgres, and read by the brief wherever it runs. Same file, same parser,
// no shared filesystem.
//
// ── EVERY UPLOAD IS KEPT ────────────────────────────────────────────────────
// A new export does not overwrite the old one; it is a new row and the brief
// reads the newest. That is what makes "did my upload actually land?"
// answerable -- the admin page lists what is stored with its size, its row
// count and when it arrived -- and it means a truncated or wrong-file upload
// is one delete away from the previous good copy rather than a re-export from
// LinkedIn. They are a few hundred KB each.
//
// ── IT IS A LIST OF REAL PEOPLE ─────────────────────────────────────────────
// Names, employers, titles and sometimes personal email addresses. Nothing
// here is exposed to an agent, an athlete or any logged-in user: the read is
// the brief's, and the admin routes are behind the admin check like every
// other admin page. The CSV body is never returned by the summary the page
// renders -- only the counts -- so the page cannot leak the list to a browser
// session that merely loaded it.

// ── THE PARSER ──────────────────────────────────────────────────────────────
// LinkedIn's export starts with a few lines of notes before the real header,
// quotes fields containing commas, and doubles embedded quotes. This is the
// ONE parser: tools/briefs/prospecting.js imports it rather than keeping a
// second copy, so the count the admin page shows is the count the brief
// filters and the two can never disagree.
function parseCsv(text) {
  const s = String(text == null ? '' : text);
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const hi = rows.findIndex((r) => r.some((x) => /^first name$/i.test(String(x).trim())));
  if (hi < 0) return [];
  const header = rows[hi].map((h) => String(h).trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const ix = { first: col('first name'), last: col('last name'), url: col('url'), email: col('email address'), company: col('company'), position: col('position'), on: col('connected on') };
  return rows.slice(hi + 1).filter((r) => r.length >= 2 && (r[ix.first] || r[ix.last])).map((r) => ({
    first: (r[ix.first] || '').trim(), last: (r[ix.last] || '').trim(),
    url: (r[ix.url] || '').trim(), email: (r[ix.email] || '').trim().toLowerCase(),
    company: (r[ix.company] || '').trim(), position: (r[ix.position] || '').trim(),
    connectedOn: (r[ix.on] || '').trim(),
  }));
}

// ── WHAT A GOOD UPLOAD LOOKS LIKE ───────────────────────────────────────────
// Checked before anything is stored, and the answer is a sentence rather than
// a code: the person uploading is about to re-export from LinkedIn if they
// picked the wrong file, and "invalid" does not tell them which mistake they
// made. Returns null when the file is fine.
const MAX_BYTES = 12 * 1024 * 1024;
function problemWith(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return 'that file is empty.';
  if (Buffer.byteLength(s, 'utf8') > MAX_BYTES) return `that file is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB, which is not a LinkedIn connections export.`;
  if (/^\s*[[{]/.test(s)) return 'that looks like JSON, not a CSV. LinkedIn exports Connections.csv.';
  if (s.slice(0, 8).indexOf('PK') === 0) return 'that is a zip file. Unzip the LinkedIn export and upload Connections.csv from inside it.';
  if (!/first name/i.test(s.slice(0, 8000))) {
    return 'no "First Name" header row in the first few thousand characters. '
      + 'That header is what makes it a LinkedIn connections export -- check you picked Connections.csv and not another file from the export.';
  }
  const people = parseCsv(s);
  if (!people.length) return 'the header row was found but no connection rows came after it. Is the file truncated?';
  return null;
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brief_connections (
      id           SERIAL PRIMARY KEY,
      filename     TEXT,
      csv          TEXT NOT NULL,
      rows         INT  NOT NULL DEFAULT 0,
      bytes        INT  NOT NULL DEFAULT 0,
      uploaded_by  TEXT,
      uploaded_at  TIMESTAMPTZ DEFAULT NOW()
    )`).catch((e) => console.error('[briefConnections] ensureTable:', e.message));
}

// save(pool, { csv, filename, uploadedBy }) -> { ok, id, rows, bytes } or
// { ok:false, error }. Validates BEFORE it writes: a rejected upload leaves
// the stored export exactly as it was, so a bad file cannot silently replace
// a good one and take the next morning's brief down with it.
async function save(pool, { csv, filename, uploadedBy } = {}) {
  const problem = problemWith(csv);
  if (problem) return { ok: false, error: problem };
  const text = String(csv);
  const rows = parseCsv(text).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  try {
    await ensureTable(pool);
    const r = await pool.query(
      `INSERT INTO brief_connections (filename, csv, rows, bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, uploaded_at`,
      [String(filename || 'Connections.csv').slice(0, 200), text, rows, bytes,
       uploadedBy ? String(uploadedBy).slice(0, 200) : null]);
    return { ok: true, id: r.rows[0].id, uploadedAt: r.rows[0].uploaded_at, rows, bytes };
  } catch (e) {
    console.error('[briefConnections] save:', e.message);
    return { ok: false, error: 'could not write to the database: ' + e.message };
  }
}

// The newest export, WITH the CSV body. This is the brief's read.
async function latest(pool) {
  try {
    const r = await pool.query(
      `SELECT id, filename, csv, rows, bytes, uploaded_by, uploaded_at
         FROM brief_connections ORDER BY uploaded_at DESC, id DESC LIMIT 1`);
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, filename: row.filename, csv: row.csv, rows: row.rows,
      bytes: row.bytes, uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at };
  } catch (e) {
    // A table that does not exist yet is "nothing uploaded", not a crash: the
    // brief falls back to the filesystem and says so in its own output.
    console.error('[briefConnections] latest:', e.message);
    return null;
  }
}

// Every upload, newest first, WITHOUT the CSV body. What the admin page shows.
async function history(pool, limit) {
  const n = Math.min(50, Math.max(1, Number(limit) || 10));
  try {
    await ensureTable(pool);
    const r = await pool.query(
      `SELECT id, filename, rows, bytes, uploaded_by, uploaded_at
         FROM brief_connections ORDER BY uploaded_at DESC, id DESC LIMIT $1`, [n]);
    return r.rows.map((row) => ({ id: row.id, filename: row.filename, rows: row.rows,
      bytes: row.bytes, uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at }));
  } catch (e) {
    console.error('[briefConnections] history:', e.message);
    return [];
  }
}

// Remove one older upload. The newest cannot be deleted from the page: that
// is the one the brief reads, and a page with a delete button next to the
// live export is a page that breaks tomorrow's brief by accident.
async function remove(pool, id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return { ok: false, error: 'no such upload' };
  try {
    const cur = await latest(pool);
    if (cur && cur.id === n) {
      return { ok: false, error: 'that is the export the brief is using. Upload a newer one first, then delete this.' };
    }
    const r = await pool.query(`DELETE FROM brief_connections WHERE id = $1`, [n]);
    return { ok: true, removed: r.rowCount || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { MAX_BYTES, parseCsv, problemWith, ensureTable, save, latest, history, remove };
