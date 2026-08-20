'use strict';
// ── WHEN AN OUTREACH IS ALLOWED TO LEAVE ─────────────────────────────────────
//
// The team drafts overnight. It must not SEND overnight. An email that lands at
// 3:07am local time is read at 8am on top of everything else that arrived
// overnight, it looks automated because nothing a person sends arrives then, and
// for a local business owner it is the difference between a note from an agent
// and a blast.
//
// So a draft cleared to send is stamped with a release time instead of going out
// immediately, and the release time is computed in the RECIPIENT'S timezone:
//
//   - Tuesday, Wednesday or Thursday only. Monday is spent clearing the weekend
//     and Friday is spent leaving; both are where cold outreach goes to die.
//   - Mid-morning, 9:30-11:00, which is after the inbox triage and before lunch.
//   - Never Saturday or Sunday, in any timezone, for any reason.
//
// THE AGENT DOES NOT CONFIGURE THIS. It is not a preference, it is how the
// product behaves, and an agent who could set it to 3am would.
//
// Timezone comes from the business's own state when we know it, because the
// recipient's morning is the only morning that matters. Where we do not know it,
// the athlete's school state is the next best guess -- a local business scanned
// for an Auburn athlete is almost certainly in Alabama -- and Central is the
// final fallback, being the modal US timezone.

const SEND_DAYS = [2, 3, 4];          // Tue, Wed, Thu (JS getDay: Sun=0)
const WINDOW_START_MIN = 9 * 60 + 30; // 09:30
const WINDOW_END_MIN = 11 * 60;       // 11:00

// US state/territory -> IANA zone. Only the zone matters, not the exact county:
// a business 40 miles inside a split state is at most an hour off, and an hour
// inside a 90-minute window is still business hours.
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Denver', IL: 'America/Chicago', IN: 'America/New_York', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver', PR: 'America/Puerto_Rico',
};
const DEFAULT_TZ = 'America/Chicago';

// Pull a two-letter state out of an address or "City, ST 12345" tail.
function stateFrom(text) {
  const s = String(text || '').toUpperCase();
  const m = s.match(/\b([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*USA?)?\s*$/)
    || s.match(/,\s*([A-Z]{2})\b/);
  const code = m && m[1];
  return code && STATE_TZ[code] ? code : null;
}

function zoneFor(opts = {}) {
  const st = stateFrom(opts.businessAddress) || stateFrom(opts.athleteSchoolState) || stateFrom(opts.fallbackAddress);
  if (st) return STATE_TZ[st];
  if (opts.timezone && /^[A-Za-z]+\/[A-Za-z_]+$/.test(opts.timezone)) return opts.timezone;
  return DEFAULT_TZ;
}

// Read a UTC instant as wall-clock parts in a zone, without pulling in a
// date library. Intl is in Node and is the authority on DST.
function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  });
  const out = {};
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute,
    dow: DAY[out.weekday],
    minutes: (+out.hour % 24) * 60 + (+out.minute),
  };
}

// The UTC instant matching a wall-clock time in a zone. Solved by probing rather
// than by offset arithmetic, so DST transitions cannot skew it.
function utcForWallClock(y, mo, d, hh, mm, tz) {
  let guess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), tz);
    const have = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const want = Date.UTC(y, mo - 1, d, hh, mm, 0);
    if (have === want) break;
    guess += want - have;
  }
  return new Date(guess);
}

// Deterministic minute inside the window, spread by a key so a hundred sends do
// not all land on :30. Not random: the same draft must always resolve to the
// same slot, or a retry moves it.
function slotMinute(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return WINDOW_START_MIN + (h % (WINDOW_END_MIN - WINDOW_START_MIN));
}

// The next moment this may be sent. `from` defaults to now; opts carries what we
// know about where the recipient is.
function nextSendSlot(from, opts = {}) {
  const tz = zoneFor(opts);
  const start = from instanceof Date ? from : new Date(from || Date.now());
  const minute = slotMinute(opts.key || opts.id || '');
  // Walk forward day by day. Ten days is more than enough to clear any weekend.
  for (let i = 0; i < 10; i++) {
    const probe = new Date(start.getTime() + i * 86400e3);
    const p = partsIn(probe, tz);
    if (SEND_DAYS.indexOf(p.dow) === -1) continue;      // never Mon/Fri/Sat/Sun
    const when = utcForWallClock(p.year, p.month, p.day,
      Math.floor(minute / 60), minute % 60, tz);
    if (when.getTime() <= start.getTime()) continue;    // today's window has passed
    return { at: when, timezone: tz, localMinute: minute };
  }
  return null;
}

// Is this instant inside a legal send window in that zone? Used by the release
// job so a stamped time cannot fire on a weekend if it was computed wrongly.
function isSendable(at, opts = {}) {
  const tz = zoneFor(opts);
  const p = partsIn(at instanceof Date ? at : new Date(at), tz);
  if (SEND_DAYS.indexOf(p.dow) === -1) return false;
  return p.minutes >= WINDOW_START_MIN && p.minutes <= WINDOW_END_MIN + 90;
}

module.exports = {
  nextSendSlot, isSendable, zoneFor, stateFrom, partsIn, utcForWallClock, slotMinute,
  SEND_DAYS, WINDOW_START_MIN, WINDOW_END_MIN, STATE_TZ, DEFAULT_TZ,
};
