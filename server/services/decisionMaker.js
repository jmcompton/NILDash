'use strict';
// Who on a football staff page is worth an agent's attention.
//
// A full staff page runs to 80 or 110 people. Most of them are quality control
// assistants, video interns and student assistants. An agent scrolling on a phone
// between calls does not need them, and a list that long buries the four people who
// actually decide roster spots.
//
// This filters the VIEW, never the storage. Every person stays in program_staff:
// the roster is still searchable by any query that wants it, and a title we
// misjudge today is recoverable tomorrow by changing this file alone.
//
// EMAIL IS NEVER A CRITERION. Alabama has 19 staff and 0 published emails, and its
// General Manager is still the real General Manager. Filtering on contactability
// would delete the most useful row on that page. Name, title and the office line
// are enough to make a call.

// ── Precedence, which is where the difficulty actually lives ─────────────────
// "Video Coordinator" and "Offensive Coordinator" share a word. "Recruiting
// Analyst" and "Director of Recruiting" share a word. So a flat keep-list cannot
// work; the rules have to be ordered:
//
//   1. HARD_DROP   never shown, whatever else the title says
//   2. STRONG_KEEP a genuine football decision seat, survives a support word
//   3. SUPPORT     a support department, dropped unless STRONG_KEEP rescued it
//   4. WEAK_KEEP   coaching titles, only when no support word is present
//   5. default     drop

// The training-and-development seats and the desk-research seats. Real jobs, no
// authority over a roster spot. Analyst is here rather than in SUPPORT because an
// analyst with a directorship is still an analyst.
const HARD_DROP = /\bquality control\b|\bq\.?c\.?\b|\bstudent (assistant|manager|aide|worker)\b|\bgraduate assistant\b|\bgrad assistant\b|\bintern(ship)?s?\b|\bvolunteer\b|\banalyst\b|\banalytics\b/i;

// Support departments. Dropped unless a STRONG_KEEP also matches.
const SUPPORT = /\bvideo\b|\bphotograph|\bvideograph|\bcreative\b|\bgraphic|\bcontent\b|\bsocial media\b|\bcommunications?\b|\bmedia relations\b|\bsports information\b|\bbroadcast\b|\bequipment\b|\bnutrition|\bdietit|\bfuel(ing)?\b|\bsports medicine\b|\bathletic trainer\b|\btrainer\b|\btraining room\b|\bphysical therap|\bstrength\b|\bconditioning\b|\bperformance\b|\bacademic|\bcompliance\b|\btravel\b|\bfacilit|\bgrounds\b|\bcustodial\b|\bhvac\b|\bticket|\bbusiness office\b|\baccounting\b|\bfinance\b|\bhuman resources\b|\bcamp\b|\bevent\b|\bhospitality\b|\bletterwinner\b|\balumni\b/i;

// A genuine football decision seat. These survive a support word in the same title.
const STRONG_KEEP = [
  /\bgeneral manager\b|\bgm\b/i,
  /\bchief of staff\b/i,
  /\bfootball operations\b|\bfootball administration\b|\bfootball management\b/i,
  /\bpresident of football\b|\bexecutive director of football\b/i,
  /\bplayer personnel\b|\bpersonnel\b/i,
  /\bscout(ing|s)?\b/i,
  /\brecruit(ing|ment)\b/i,
  /\bhead (football )?coach\b/i,
  /\bplayer development\b|\bplayer engagement\b|\bplayer relations\b|\bplayer experience\b/i,
  /\bstudent[- ]athlete development\b/i,
  /\bnil\b|\bname,? image\b|\bcollective\b/i,
];

// Coaching and commercial titles. Only apply when no support word is present, which
// is what keeps "Offensive Coordinator" while dropping "Video Coordinator".
const WEAK_KEEP = [
  /\bcoordinator\b/i,
  /\bposition coach\b/i,
  // Position groups, singular or plural. The plural is the common form on a staff
  // page ("Quarterbacks Coach", "Tight Ends Coach"), so the s is optional, not absent.
  /\b(quarterbacks?|running ?backs?|wide ?receivers?|receivers?|tight ?ends?|offensive line(men)?|o-?line|defensive line(men)?|d-?line|linebackers?|cornerbacks?|safet(y|ies)|secondary|defensive backs?|special teams|edge|nickel|tackles?|guards?|centers?|running game|passing game|run game|pass game)\b/i,
  /\bbrand\b|\bmarketing\b|\bpartnership|\brevenue\b|\bsponsorship\b/i,
  /\bassociate head coach\b|\bassistant head coach\b/i,
];

// Is this person worth showing to an agent?
// Returns { keep, reason } so a wrong call is diagnosable rather than mysterious.
function classifyTitle(title) {
  const t = String(title || '').trim();
  if (!t) return { keep: false, reason: 'no title published' };

  if (HARD_DROP.test(t)) return { keep: false, reason: 'development, student or analyst seat' };

  const strong = STRONG_KEEP.some((re) => re.test(t));
  if (strong) return { keep: true, reason: 'football decision maker' };

  if (SUPPORT.test(t)) return { keep: false, reason: 'support department' };

  if (WEAK_KEEP.some((re) => re.test(t))) return { keep: true, reason: 'coaching or commercial role' };

  // Default is DROP. The target is 15 to 25 people per school, not 80, and an
  // unrecognised title is far more often a support seat than a hidden GM.
  return { keep: false, reason: 'title does not indicate a decision-making role' };
}

function isDecisionMaker(title) {
  return classifyTitle(title).keep;
}

// Split a staff list into what to show and what to keep in storage but hide.
function partition(staff) {
  const shown = [], hidden = [];
  for (const p of (staff || [])) {
    (isDecisionMaker(p && p.title) ? shown : hidden).push(p);
  }
  return { shown, hidden };
}

module.exports = {
  classifyTitle, isDecisionMaker, partition,
  HARD_DROP, SUPPORT, STRONG_KEEP, WEAK_KEEP,
};
