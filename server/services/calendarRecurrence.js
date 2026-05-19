// server/services/calendarRecurrence.js
// RFC5545-style RRULE recurrence engine for NIL contract deliverables.
//
// Supported frequencies: DAILY, WEEKLY, MONTHLY
// Supported modifiers:   INTERVAL, COUNT, UNTIL
// Hard cap: 104 instances per rule (2-year safety ceiling)
//
// Also accepts legacy plain-text recurrence strings:
//   "monthly", "weekly", "daily", "biweekly", "bi-weekly"

'use strict';

const MAX_INSTANCES = 104; // 2-year cap

// ── Parse an RRULE string → structured object ─────────────────────────────
function parseRRule(rule) {
  if (!rule || typeof rule !== 'string') return null;
  const s = rule.trim().toUpperCase();

  // Legacy plain-text shorthand
  const legacyMap = {
    'MONTHLY':   'FREQ=MONTHLY;INTERVAL=1',
    'WEEKLY':    'FREQ=WEEKLY;INTERVAL=1',
    'DAILY':     'FREQ=DAILY;INTERVAL=1',
    'BIWEEKLY':  'FREQ=WEEKLY;INTERVAL=2',
    'BI-WEEKLY': 'FREQ=WEEKLY;INTERVAL=2',
  };
  const normalized = legacyMap[s] || s;

  const parts = {};
  for (const token of normalized.split(';')) {
    const [k, v] = token.split('=');
    if (k && v !== undefined) parts[k.trim()] = v.trim();
  }

  const freq     = parts['FREQ']     || null;
  const interval = parseInt(parts['INTERVAL'] || '1', 10) || 1;
  const count    = parts['COUNT']    ? parseInt(parts['COUNT'], 10) : null;
  const until    = parts['UNTIL']    ? parseUntilDate(parts['UNTIL']) : null;

  if (!freq) return null;
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return null;

  return { freq, interval, count, until };
}

// Parse UNTIL date — RFC5545 format: YYYYMMDD[THHmmssZ]
function parseUntilDate(s) {
  if (!s) return null;
  const d = s.replace(/T.*$/, ''); // strip time component
  if (d.length !== 8) return null;
  const y = parseInt(d.slice(0, 4), 10);
  const m = parseInt(d.slice(4, 6), 10) - 1;
  const day = parseInt(d.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, day));
  return isNaN(dt.getTime()) ? null : dt;
}

// ── Advance a date by one recurrence interval ──────────────────────────────
function advanceDate(date, freq, interval) {
  const d = new Date(date);
  switch (freq) {
    case 'DAILY':
      d.setUTCDate(d.getUTCDate() + interval);
      break;
    case 'WEEKLY':
      d.setUTCDate(d.getUTCDate() + 7 * interval);
      break;
    case 'MONTHLY':
      // Preserve day-of-month where possible (Jan 31 + 1 month → Feb 28)
      d.setUTCMonth(d.getUTCMonth() + interval);
      break;
  }
  return d;
}

// ── Format a Date as YYYY-MM-DD ───────────────────────────────────────────
function toISO(date) {
  return date.toISOString().split('T')[0];
}

// ── Generate calendar event dates from a recurrence rule ─────────────────
// @param {string} rrule   - RRULE string or legacy shorthand
// @param {string} startDate - ISO date string (YYYY-MM-DD) of first occurrence
// @param {object} opts    - { durationMonths?: number } — fallback COUNT from legacy contracts
// @returns {string[]} array of ISO date strings
function generateDates(rrule, startDate, opts = {}) {
  const parsed = parseRRule(rrule);
  if (!parsed) return startDate ? [startDate] : [];

  const start = new Date(startDate + 'T00:00:00Z');
  if (isNaN(start.getTime())) return [];

  // Determine termination condition
  let maxCount = parsed.count;
  if (!maxCount && !parsed.until) {
    // Fallback: use durationMonths if provided (from AI extraction)
    maxCount = opts.durationMonths
      ? Math.max(1, parseInt(opts.durationMonths, 10))
      : 6; // sensible default: 6 occurrences
  }
  maxCount = Math.min(maxCount || MAX_INSTANCES, MAX_INSTANCES);

  const dates = [];
  let cursor = new Date(start);

  while (dates.length < maxCount) {
    // Check UNTIL boundary
    if (parsed.until && cursor > parsed.until) break;

    dates.push(toISO(cursor));

    cursor = advanceDate(cursor, parsed.freq, parsed.interval);
    if (dates.length >= MAX_INSTANCES) break; // hard cap
  }

  return dates;
}

// ── Convert AI-extracted recurrence to RRULE string ───────────────────────
// Maps the legacy plain-text values the AI returns → canonical RRULE
function toRRule(aiRecurrence, durationMonths) {
  if (!aiRecurrence || aiRecurrence === 'one-time' || aiRecurrence === 'none') {
    return null;
  }
  const map = {
    'monthly':   `FREQ=MONTHLY;INTERVAL=1${durationMonths ? ';COUNT=' + durationMonths : ''}`,
    'weekly':    `FREQ=WEEKLY;INTERVAL=1${durationMonths ? ';COUNT=' + (durationMonths * 4) : ''}`,
    'biweekly':  `FREQ=WEEKLY;INTERVAL=2${durationMonths ? ';COUNT=' + (durationMonths * 2) : ''}`,
    'bi-weekly': `FREQ=WEEKLY;INTERVAL=2${durationMonths ? ';COUNT=' + (durationMonths * 2) : ''}`,
    'daily':     `FREQ=DAILY;INTERVAL=1${durationMonths ? ';COUNT=' + (durationMonths * 30) : ''}`,
    'quarterly': `FREQ=MONTHLY;INTERVAL=3${durationMonths ? ';COUNT=' + Math.ceil(durationMonths / 3) : ''}`,
  };
  return map[(aiRecurrence || '').toLowerCase().trim()] || null;
}

// ── Human-readable label for a recurrence rule ───────────────────────────
function describeRRule(rrule) {
  const p = parseRRule(rrule);
  if (!p) return 'One-time';
  const freqLabel = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly' }[p.freq] || p.freq;
  const ivl = p.interval > 1 ? `every ${p.interval} ` : '';
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' }[p.freq] || '';
  const plural = p.interval > 1 ? 's' : '';
  const tail = p.count ? ` × ${p.count}` : p.until ? ` until ${toISO(p.until)}` : '';
  return `${ivl}${unit}${plural}${tail}`.trim() || freqLabel;
}

module.exports = { parseRRule, generateDates, toRRule, describeRRule, toISO };
