'use strict';
// ── WHERE A FOLLOWER NUMBER CAME FROM, AND WHEN ──────────────────────────────
//
// THE PROBLEM. Follower counts are typed in by hand. They are right on the day
// they are entered and wrong from then on, and nothing on the media kit or in a
// pitch says which day that was. A business owner reading "128,400 followers"
// reasonably assumes it is current. If it was entered in March it might be off by
// half, and we would have asserted it as fact under the agent's name.
//
// Connecting the athlete's Instagram fixes this permanently -- the number comes
// from the Graph API and is current by construction. Until that ships, the honest
// move is not to hide the number, it is to DATE it. A dated number a reader can
// judge is worth more than an undated one they have to trust.
//
// ONE PLACE DECIDES. The media kit and the pitch fact-check both read this, so a
// number cannot be dated on the kit and bare in the email.
//
// WHEN INSTAGRAM CONNECT SHIPS: set source to 'instagram' on refresh and
// isLive becomes true, label becomes null, and every caller stops printing the
// caveat with no further change. That is the whole reason this returns a
// structured answer rather than a formatted string.

// Sources, weakest first. 'agent' and 'athlete' are both hand-entered; they are
// distinguished because "your athlete told us" carries different weight to "you
// typed it", and an agent chasing a stale number needs to know who to ask.
const SOURCES = {
  agent: { label: 'entered by their agent', live: false },
  athlete: { label: 'entered by the athlete', live: false },
  instagram: { label: 'from connected Instagram', live: true },
};

// Past this, a hand-entered number is old enough that presenting it without
// comment is misleading rather than merely imprecise. Roughly a season.
const STALE_DAYS = parseInt(process.env.REACH_STALE_DAYS, 10) || 120;

function _date(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// "14 Aug 2026". Deliberately not a relative string: "3 months ago" on a media
// kit that gets forwarded and read weeks later is wrong again immediately, and
// this is exactly the document that gets forwarded.
function formatAsOf(d) {
  const dt = _date(d);
  if (!dt) return null;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

// The whole judgement, in one call.
//   asOf      Date or null
//   source    'agent' | 'athlete' | 'instagram' | null
//   isLive    true only when it comes from a connected account
//   ageDays   null when we do not know when it was entered
//   stale     true when hand-entered and older than STALE_DAYS
//   label     the caveat to print, or null when none is needed
//   note      a longer sentence for the kit footer
function reachProvenance(athlete, now) {
  const a = athlete || {};
  const ref = _date(now) || new Date();
  const asOf = _date(a.reachAsOf || a.reach_as_of || null);
  const rawSource = String(a.reachSource || a.reach_source || '').toLowerCase().trim();
  const source = SOURCES[rawSource] ? rawSource : null;
  const spec = source ? SOURCES[source] : null;

  const ageDays = asOf ? Math.max(0, Math.floor((ref.getTime() - asOf.getTime()) / 86400000)) : null;
  const isLive = !!(spec && spec.live);
  const stale = !isLive && ageDays !== null && ageDays > STALE_DAYS;

  let label = null;
  if (isLive) {
    label = null;                                   // current by construction
  } else if (asOf) {
    label = `as of ${formatAsOf(asOf)}`;
  } else if (source) {
    // We know who typed it and not when. Say the weaker thing rather than
    // inventing a date -- an undated hand-entered number is the status quo, and
    // pretending otherwise is the failure this file exists to stop.
    label = `${spec.label}, date not recorded`;
  } else {
    label = 'date and source not recorded';
  }

  return {
    asOf, asOfText: formatAsOf(asOf), source, sourceLabel: spec ? spec.label : null,
    isLive, ageDays, stale, label,
    note: isLive
      ? 'Follower counts come from the athlete\'s connected Instagram and refresh automatically.'
      : `Follower counts are ${spec ? spec.label : 'hand-entered'}`
        + (asOf ? ` and were last updated on ${formatAsOf(asOf)}.` : ' and carry no recorded date.')
        + (stale ? ' They are old enough to be worth re-checking before sending.' : ''),
  };
}

// Append the caveat to a rendered figure. Returns the figure unchanged when the
// number is live, so the moment Instagram connect ships every caller cleans up on
// its own.
function withAsOf(text, athlete, now) {
  const p = reachProvenance(athlete, now);
  if (!text && text !== 0) return text;
  return p.label ? `${text} (${p.label})` : String(text);
}

// Does this text cite a reach figure? Used by the pitch fact-check: a pitch that
// names a follower count has to carry the date, and one that does not is
// unaffected. Matches "128,400 followers", "128k followers", "a following of
// 128,400" -- the shapes a pitch actually uses.
const CITES_REACH_RE = /(\d[\d,.]*\s*[km]?\s*(followers|following)|following of\s+\d)/i;
function citesReach(text) { return CITES_REACH_RE.test(String(text || '')); }

module.exports = { reachProvenance, withAsOf, formatAsOf, citesReach, SOURCES, STALE_DAYS };
