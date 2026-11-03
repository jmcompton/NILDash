'use strict';
// ── WHAT HIS POSITION PAYS ──────────────────────────────────────────────────
//
// The College Sports Commission's football pay data (published Oct 30, 2026):
// revenue share plus third-party NIL, combined, for players who are paid,
// split Power 4 and everyone else in Division I. The median and the 90th
// percentile ("top 10%") by position. It is the one public, league-wide
// answer to "what is a receiver worth", so the Portal Room uses it as the
// market and says where it came from.
//
// Not a valuation of one player. A starter with production sits toward the
// top; a backup toward the median or below.

const SOURCE = {
  text: 'College Sports Commission pay data, Oct 30, 2026 (revenue share plus NIL, paid players)',
  url: 'https://www.footballscoop.com/2026/10/30/college-sports-commission-nil-rev-share-cheat-sheet',
};

// [P4 median, P4 top 10%, non-P4 median, non-P4 top 10%]; null = not published.
const TABLE = {
  QB: [296000, 2607000, 33000, 282000],
  RB: [135000, 596000, 18000, 108000],
  WR: [141000, 702000, 17000, 105000],
  TE: [113000, 459000, 16000, 69000],
  OL: [155000, 726000, 19000, 115000],
  DL: [177000, 742000, 20000, 106000],
  LB: [135000, 654000, 19000, 104000],
  DB: [140000, 616000, 17000, 92000],
  K: [57000, null, 12000, null],
  P: [57000, null, 12000, null],
  LS: [57000, null, 12000, null],
};

function forGroup(group) {
  const t = TABLE[group];
  if (!t) return null;
  return {
    group,
    p4: { median: t[0], top10: t[1] },
    other: { median: t[2], top10: t[3] },
    source: SOURCE,
    kickerNote: ['K', 'P', 'LS'].includes(group) ? 'Kickers and punters are published together, median only; long snappers are not published and use the same line.' : null,
  };
}

const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');

function line(group) {
  const v = forGroup(group);
  if (!v) return null;
  const p4 = v.p4.top10 ? `Power 4 median ${usd(v.p4.median)} a year, top 10% ${usd(v.p4.top10)}` : `Power 4 median about ${usd(v.p4.median)}`;
  const ot = v.other.top10 ? `elsewhere in Division I median ${usd(v.other.median)}, top 10% ${usd(v.other.top10)}` : `elsewhere about ${usd(v.other.median)}`;
  return `${p4}; ${ot}.`;
}

// Where one offer's yearly total sits in that market, for a school of that level.
function place(perYear, group, level) {
  const v = forGroup(group);
  if (!v || !perYear) return null;
  const m = level === 'P4' ? v.p4 : v.other;
  const where = level === 'P4' ? 'Power 4' : 'non-Power 4';
  if (m.top10 && perYear >= m.top10) return { level: 'warn', text: `${usd(perYear)} a year is above the top 10% of ${where} ${group}s (${usd(m.top10)}). Great if it is real; under the PCSA, collective money this far above comparable players gets scrutiny.` };
  if (perYear >= m.median) return { level: 'ok', text: `${usd(perYear)} a year is above the ${where} median for a ${group} (${usd(m.median)}).` };
  return { level: 'warn', text: `${usd(perYear)} a year is below the ${where} median for a ${group} (${usd(m.median)}).` };
}

module.exports = { forGroup, line, place, TABLE, SOURCE };
