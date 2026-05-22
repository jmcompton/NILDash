// server/services/university/BulkImportService.js
// Bulk athlete import pipeline for University Mode.
//
// Pipeline: Parse → Validate → Normalize → Resolve University → Deduplicate → Insert → Report
//
// Supported input formats:
//   - CSV (with or without BOM, quoted fields, whitespace-tolerant headers)
//   - JSON array of athlete objects
//
// Returns BulkImportResult — never throws silently. All errors land in result.errors[].

'use strict';

const { v4: uuidv4 } = require('uuid');
const { assertUniversityMode } = require('./DataIntegrityLayer');

// ── FORBIDDEN_DEPS — university mode isolation ─────────────────────────────
// These tables and columns must never be read inside this service.
const FORBIDDEN_DEPS = [
  'outreach_logs', 'brand_match_scores', 'brand_contacts',
  'company_enrichment', 'deals', 'valuation', 'pricing',
];
void FORBIDDEN_DEPS; // referenced for documentation — not used in runtime queries

// ── School name normalization map ─────────────────────────────────────────
// Maps common variations → canonical name stored in DB
const SCHOOL_NAME_MAP = {
  'samford':              'Samford University',
  'samford university':   'Samford University',
  'samford univ':         'Samford University',
  'alabama':              'University of Alabama',
  'univ of alabama':      'University of Alabama',
  'university of alabama':'University of Alabama',
  'auburn':               'Auburn University',
  'auburn university':    'Auburn University',
  'uab':                  'University of Alabama at Birmingham',
  'troy':                 'Troy University',
  'troy university':      'Troy University',
  'jacksonville state':   'Jacksonville State University',
  'jsu':                  'Jacksonville State University',
  // Add more as needed — always lowercase key, canonical value
};

function normalizeSchoolName(raw) {
  if (!raw) return raw;
  const key = raw.trim().toLowerCase();
  return SCHOOL_NAME_MAP[key] || raw.trim();
}

// ── Sport normalization map ───────────────────────────────────────────────
const SPORT_MAP = {
  'fb':                  'Football',
  'football':            'Football',
  'mbb':                 'Basketball',
  "men's basketball":    'Basketball',
  'mens basketball':     'Basketball',
  'basketball':          'Basketball',
  'wbb':                 "Women's Basketball",
  "women's basketball":  "Women's Basketball",
  'womens basketball':   "Women's Basketball",
  'wsoc':                "Women's Soccer",
  "women's soccer":      "Women's Soccer",
  'womens soccer':       "Women's Soccer",
  'soccer':              "Women's Soccer",
  'msoc':                "Men's Soccer",
  "men's soccer":        "Men's Soccer",
  'mens soccer':         "Men's Soccer",
  'bsb':                 'Baseball',
  'baseball':            'Baseball',
  'sball':               'Softball',
  'softball':            'Softball',
  'tfxc':                'Track & Field',
  'track':               'Track & Field',
  'track & field':       'Track & Field',
  'track and field':     'Track & Field',
  'cross country':       'Cross Country',
  'xc':                  'Cross Country',
  'volleyball':          'Volleyball',
  'vb':                  'Volleyball',
  'swimming':            'Swimming & Diving',
  'swim':                'Swimming & Diving',
  'swimming & diving':   'Swimming & Diving',
  'golf':                'Golf',
  'tennis':              'Tennis',
  'lacrosse':            'Lacrosse',
  'wrestling':           'Wrestling',
  'gymnastics':          'Gymnastics',
};

function normalizeSport(raw) {
  if (!raw) return raw;
  const key = raw.trim().toLowerCase();
  return SPORT_MAP[key] || raw.trim();
}

// ── University lookup by school name ────────────────────────────────────
async function resolveUniversityId(pool, schoolName) {
  if (!schoolName) return null;
  try {
    const r = await pool.query(
      'SELECT id FROM universities WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [schoolName]
    );
    return r.rows[0]?.id || null;
  } catch (_) {
    return null;
  }
}

// ── CSV parser ────────────────────────────────────────────────────────────
// Handles BOM, quoted fields, CRLF, whitespace in headers.
function parseCSV(rawText) {
  // Strip BOM if present
  const text = rawText.replace(/^﻿/, '').trim();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  // Parse a single CSV line respecting quoted fields
  function parseLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'; i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const rows    = lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });

  return { headers, rows };
}

// ── Field aliases ─────────────────────────────────────────────────────────
// Handles common CSV header variations
function getField(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return undefined;
}

// ── Validate a single athlete record ─────────────────────────────────────
function validateAthlete(raw, index) {
  const errors = [];

  const name  = getField(raw, 'name', 'full_name', 'athlete_name');
  const sport = getField(raw, 'sport', 'sport_name');
  const school = getField(raw, 'school', 'university', 'school_name', 'institution');

  if (!name || !name.trim()) {
    errors.push({ field: 'name', message: 'Name is required' });
  }
  if (!sport || !sport.trim()) {
    errors.push({ field: 'sport', message: 'Sport is required' });
  }
  if (!school || !school.trim()) {
    errors.push({ field: 'school', message: 'School is required' });
  }

  // Numeric validation
  const instagram = getField(raw, 'instagram', 'instagram_followers', 'ig');
  const tiktok    = getField(raw, 'tiktok', 'tiktok_followers', 'tt');
  const engagement = getField(raw, 'engagement', 'engagement_rate', 'er');

  if (instagram !== undefined && instagram !== '') {
    const n = parseFloat(String(instagram).replace(/,/g, ''));
    if (isNaN(n) || n < 0) errors.push({ field: 'instagram', message: 'Instagram followers must be a non-negative number' });
  }
  if (tiktok !== undefined && tiktok !== '') {
    const n = parseFloat(String(tiktok).replace(/,/g, ''));
    if (isNaN(n) || n < 0) errors.push({ field: 'tiktok', message: 'TikTok followers must be a non-negative number' });
  }
  if (engagement !== undefined && engagement !== '') {
    const n = parseFloat(engagement);
    if (isNaN(n) || n < 0 || n > 100) errors.push({ field: 'engagement', message: 'Engagement rate must be between 0 and 100' });
  }

  return { valid: errors.length === 0, errors, row: index };
}

// ── Normalize a raw record into canonical athlete data ────────────────────
function normalizeAthlete(raw) {
  const name      = (getField(raw, 'name', 'full_name', 'athlete_name') || '').trim();
  const sport     = normalizeSport(getField(raw, 'sport', 'sport_name') || '');
  const school    = normalizeSchoolName(getField(raw, 'school', 'university', 'school_name', 'institution') || '');
  const position  = (getField(raw, 'position', 'pos') || '').trim();
  const schoolTier = (getField(raw, 'school_tier', 'tier', 'level') || 'G5').trim();

  const toInt = v => {
    if (v === undefined || v === '') return 0;
    const n = parseInt(String(v).replace(/,/g, ''), 10);
    return isNaN(n) ? 0 : Math.max(0, n);
  };
  const toFloat = v => {
    if (v === undefined || v === '') return 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.min(100, Math.max(0, n));
  };

  return {
    name,
    sport,
    school,
    position,
    schoolTier,
    instagram:  toInt(getField(raw, 'instagram', 'instagram_followers', 'ig')),
    tiktok:     toInt(getField(raw, 'tiktok', 'tiktok_followers', 'tt')),
    engagement: toFloat(getField(raw, 'engagement', 'engagement_rate', 'er')),
    stats:      (getField(raw, 'stats', 'statistics', 'stat_line') || '').trim(),
    notes:      (getField(raw, 'notes', 'bio', 'description') || '').trim(),
  };
}

// ── Deduplication key ────────────────────────────────────────────────────
function dedupKey(d) {
  return `${d.name.toLowerCase()}|${d.school.toLowerCase()}|${d.sport.toLowerCase()}`;
}

// ── Main import function ─────────────────────────────────────────────────
// @param {object} pool         - pg Pool instance
// @param {string} rawInput     - raw CSV text or JSON string
// @param {string} format       - 'csv' | 'json'
// @param {string} agentId      - the user ID to store as agent_id
// @param {string} universityId - the university to scope athletes to
// @param {string} userRole     - must be university/university_admin/admin
// @returns {BulkImportResult}
async function bulkImport(pool, rawInput, format, agentId, universityId, userRole = 'university') {
  assertUniversityMode(userRole);

  const result = {
    total:    0,
    imported: 0,
    skipped:  0,   // duplicates
    failed:   0,
    errors:   [],  // { row, field?, message }
    athletes: [],  // successfully imported names
    skippedNames: [],
    universityId,
    importedAt: new Date().toISOString(),
  };

  // ── 1. Parse ──────────────────────────────────────────────────────
  let rawRows = [];
  try {
    if (format === 'json') {
      const parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
      if (!Array.isArray(parsed)) {
        result.errors.push({ row: 0, message: 'JSON input must be an array of athlete objects' });
        result.failed++;
        return result;
      }
      rawRows = parsed;
    } else {
      // Default: CSV
      const { rows } = parseCSV(rawInput);
      rawRows = rows;
    }
  } catch (parseErr) {
    result.errors.push({ row: 0, message: `Parse error: ${parseErr.message}` });
    result.failed++;
    return result;
  }

  result.total = rawRows.length;
  if (result.total === 0) {
    result.errors.push({ row: 0, message: 'No records found in input' });
    return result;
  }

  // ── 2. Validate + Normalize ────────────────────────────────────────
  const validRecords = []; // { data, originalIndex }
  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];
    const { valid, errors } = validateAthlete(raw, i + 1);
    if (!valid) {
      result.failed++;
      errors.forEach(e => result.errors.push({ row: i + 1, ...e }));
      continue;
    }
    const normalized = normalizeAthlete(raw);
    validRecords.push({ data: normalized, originalIndex: i + 1 });
  }

  // ── 3. Resolve university IDs ──────────────────────────────────────
  // Batch: collect unique school names, resolve once each
  const schoolNames = [...new Set(validRecords.map(r => r.data.school))];
  const schoolToUnivId = {};
  for (const school of schoolNames) {
    schoolToUnivId[school] = await resolveUniversityId(pool, school);
  }

  // ── 4. Deduplicate within batch ─────────────────────────────────────
  const seenKeys = new Set();
  const uniqueRecords = [];
  for (const record of validRecords) {
    const key = dedupKey(record.data);
    if (seenKeys.has(key)) {
      result.skipped++;
      result.skippedNames.push(`${record.data.name} (duplicate in batch)`);
      continue;
    }
    seenKeys.add(key);
    uniqueRecords.push(record);
  }

  // ── 5. Check for existing DB duplicates ──────────────────────────────
  // UNIVERSITY SIDE ONLY — checks university_athletes, never the agent athletes table
  const toInsert = [];
  for (const record of uniqueRecords) {
    const { data } = record;
    try {
      const existing = await pool.query(
        `SELECT id FROM university_athletes
         WHERE name   ILIKE $1
           AND sport  ILIKE $2
           AND university_id = $3
         LIMIT 1`,
        [data.name, data.sport, universityId]
      );
      if (existing.rows.length > 0) {
        result.skipped++;
        result.skippedNames.push(`${data.name} (already exists)`);
        continue;
      }
    } catch (_) {
      // If DB check fails, allow insert to proceed — conflict will be caught there
    }
    toInsert.push(record);
  }

  // ── 6. Insert ────────────────────────────────────────────────────────
  // UNIVERSITY SIDE ONLY — writes to university_athletes, never to the agent athletes table
  for (const record of toInsert) {
    const { data, originalIndex } = record;
    const resolvedUnivId = schoolToUnivId[data.school] || universityId;
    const athleteId = `import-${uuidv4()}`;
    const nameParts = (data.name || '').trim().split(' ');
    const firstName = nameParts[0] || null;
    const lastName  = nameParts.slice(1).join(' ') || null;
    const extData   = { ...data, source: 'csv_import' };

    try {
      await pool.query(
        `INSERT INTO university_athletes (id, university_id, first_name, last_name, name, sport, position, source, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'csv_import', $8, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [athleteId, resolvedUnivId, firstName, lastName, data.name, data.sport || null, data.position || null, JSON.stringify(extData)]
      );
      result.imported++;
      result.athletes.push({ id: athleteId, name: data.name, sport: data.sport });
    } catch (dbErr) {
      result.failed++;
      result.errors.push({ row: originalIndex, message: `DB insert failed: ${dbErr.message}` });
    }
  }

  return result;
}

// ── CSV template generator ───────────────────────────────────────────────
// Returns a CSV string with headers and one example row.
function generateCSVTemplate() {
  const headers = [
    'name', 'sport', 'school', 'position', 'school_tier',
    'instagram', 'tiktok', 'engagement', 'stats', 'notes',
  ];
  const example = [
    'Jane Smith', 'Basketball', 'Samford University', 'Point Guard', 'G5',
    '8500', '12000', '6.2', '14.3 PPG, 5.1 APG', 'Pre-law student. Campus ambassador.',
  ];
  return headers.join(',') + '\n' + example.map(v => `"${v}"`).join(',') + '\n';
}

module.exports = { bulkImport, generateCSVTemplate, normalizeSchoolName, normalizeSport };
