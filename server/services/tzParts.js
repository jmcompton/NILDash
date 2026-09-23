'use strict';
// ── WALL-CLOCK PARTS IN A TIMEZONE ──────────────────────────────────────────
//
// Used to time the agent's OWN reports (the shift report and the deliverable
// digest go out at an hour on the agent's clock). This lived in sendWindow.js,
// which held pitches for Tuesday-to-Thursday mornings; that window is gone --
// approving an email sends it -- and these two helpers are what was left worth
// keeping.

const DEFAULT_TZ = 'America/Chicago';

// Read a UTC instant as wall-clock parts in a zone, without pulling in a date
// library. Intl is in Node and is the authority on DST.
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

module.exports = { partsIn, DEFAULT_TZ };
