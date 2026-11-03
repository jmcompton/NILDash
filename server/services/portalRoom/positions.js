'use strict';
// ── POSITIONS AND CLASS YEARS, AS ROSTERS PRINT THEM ────────────────────────
//
// Every school writes these its own way: "WR", "Wide Receiver", "WR/KR";
// "R-Sr.", "Gr.", "Fifth Year", "5th". This turns them into a position GROUP
// (the room a transfer would join) and a CLASS (who is likely gone after the
// season).
//
// GROUPS. Corners and safeties are one room here (DB): half the FBS rosters
// print "DB" and there is no honest way to split those. Edge rushers are DL;
// stand-up outside backers (OLB, JACK, BUCK) are LB.
//
// LEAVING. Seniors, graduate students and fifth and sixth years are counted as
// likely leaving. Some seniors have a year left (a redshirt the roster does
// not show), so the page says "seniors and older", never "out of eligibility".

const GROUPS = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB', 'K', 'P', 'LS'];
const LABEL = { QB: 'Quarterbacks', RB: 'Running backs', WR: 'Wide receivers', TE: 'Tight ends', OL: 'Offensive line', DL: 'Defensive line', LB: 'Linebackers', DB: 'Defensive backs', K: 'Kickers', P: 'Punters', LS: 'Long snappers' };
const SIDE = { QB: 'offense', RB: 'offense', WR: 'offense', TE: 'offense', OL: 'offense', DL: 'defense', LB: 'defense', DB: 'defense', K: 'special', P: 'special', LS: 'special' };

const ABBR = {
  QB: 'QB',
  RB: 'RB', TB: 'RB', HB: 'RB', FB: 'RB',
  WR: 'WR', SB: 'WR', SE: 'WR', FL: 'WR', SLOT: 'WR', X: 'WR', Z: 'WR',
  TE: 'TE', Y: 'TE', HBACK: 'TE', 'H-BACK': 'TE',
  OL: 'OL', OT: 'OL', OG: 'OL', C: 'OL', T: 'OL', G: 'OL', IOL: 'OL', LT: 'OL', RT: 'OL', LG: 'OL', RG: 'OL',
  DL: 'DL', DT: 'DL', DE: 'DL', NT: 'DL', NG: 'DL', EDGE: 'DL', DI: 'DL', IDL: 'DL', BANDIT: 'DL',
  LB: 'LB', ILB: 'LB', OLB: 'LB', MLB: 'LB', WLB: 'LB', SLB: 'LB', MIKE: 'LB', WILL: 'LB', SAM: 'LB', JACK: 'LB', BUCK: 'LB', SPUR: 'LB', ROVER: 'LB',
  DB: 'DB', CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', SAF: 'DB', NB: 'DB', NICKEL: 'DB', STAR: 'DB', HUSKY: 'DB',
  K: 'K', PK: 'K', 'K/P': 'K',
  P: 'P',
  LS: 'LS', SNP: 'LS',
};
const WORDS = [
  [/quarterback/i, 'QB'], [/running back|tailback|fullback|halfback/i, 'RB'], [/wide receiver|receiver|slot/i, 'WR'],
  [/tight end/i, 'TE'],
  // Defensive line before offensive line: "Defensive Tackle" must not land on
  // the bare "tackle" below.
  [/defensive line|defensive tackle|defensive end|nose tackle|nose guard|edge/i, 'DL'],
  [/offensive line|offensive tackle|offensive guard|\bcenter\b|\btackle\b|\bguard\b/i, 'OL'], [/linebacker/i, 'LB'],
  [/defensive back|cornerback|corner|safety|nickel/i, 'DB'], [/long snap/i, 'LS'], [/place ?kicker|kicker/i, 'K'], [/punter/i, 'P'],
];

// The group a printed position belongs to, or null when it cannot be told
// (ATH, "Athlete", blank). The first listed position wins: "WR/KR" is a WR.
function groupOf(pos) {
  const raw = String(pos || '').trim();
  if (!raw) return null;
  const first = raw.split(/[\/,|]|\s+-\s+/)[0].trim();
  const key = first.toUpperCase().replace(/\./g, '');
  if (ABBR[key]) return ABBR[key];
  if (ABBR[raw.toUpperCase()]) return ABBR[raw.toUpperCase()];
  for (const [re, g] of WORDS) if (re.test(first)) return g;
  for (const [re, g] of WORDS) if (re.test(raw)) return g;
  // Sidearm prints the short and long forms side by side ("OLB OLB",
  // "WR Wide Receiver"): the first word alone.
  const tok = first.split(/\s+/)[0].toUpperCase().replace(/\./g, '');
  if (tok !== key && ABBR[tok]) return ABBR[tok];
  return null;
}

// "R-Sr." -> { cls: 'SR', redshirt: true }. cls is FR, SO, JR, SR, GR, 5TH,
// 6TH or null.
function classOf(year) {
  const y = String(year || '').trim().toLowerCase();
  if (!y) return { cls: null, redshirt: false };
  const redshirt = /^(r|rs)[\s.\-]|^redshirt|^r(fr|so|jr|sr)\b/.test(y);
  let cls = null;
  if (/grad|^gr\b|^gr\.|\bgs\b|graduate/.test(y)) cls = 'GR';
  else if (/6th|sixth/.test(y)) cls = '6TH';
  else if (/5th|fifth/.test(y)) cls = '5TH';
  else if (/\bsr\b|sr\.|senior|^r?sr/.test(y)) cls = 'SR';
  else if (/\bjr\b|jr\.|junior|^r?jr/.test(y)) cls = 'JR';
  else if (/\bso\b|so\.|soph|^r?so/.test(y)) cls = 'SO';
  else if (/\bfr\b|fr\.|fresh|^r?fr/.test(y)) cls = 'FR';
  // Years in the program ("3rd", "4th year", Iowa and New Mexico): the 4th
  // year counts with seniors, the same estimate a redshirt senior gets.
  else if (/^4th\b|fourth/.test(y)) cls = 'SR';
  else if (/^3rd\b|third/.test(y)) cls = 'JR';
  else if (/^2nd\b|second/.test(y)) cls = 'SO';
  else if (/^1st\b|first[ -]year/.test(y)) cls = 'FR';
  return { cls, redshirt };
}

const LEAVING = new Set(['SR', 'GR', '5TH', '6TH']);
function isLeaving(year) { return LEAVING.has(classOf(year).cls); }

// The coaching titles that run a room, for the contact book.
const COACH_RE = {
  QB: /quarterback/i, RB: /running back/i, WR: /wide receiver|receivers/i, TE: /tight end/i,
  OL: /offensive line|o-line/i, DL: /defensive line|d-line|defensive tackle|defensive end|edge|pass rush/i,
  LB: /linebacker/i, DB: /defensive back|secondary|cornerback|safet|nickel/i,
  K: /special teams|kicking/i, P: /special teams|punt/i, LS: /special teams/i,
};
const COORD_RE = { offense: /offensive coordinator/i, defense: /defensive coordinator/i, special: /special teams coordinator/i };

module.exports = { GROUPS, LABEL, SIDE, groupOf, classOf, isLeaving, COACH_RE, COORD_RE };
