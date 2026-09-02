'use strict';
// ── THE WRITER ───────────────────────────────────────────────────────────────
//
// What this replaces:
//
//   "Hi! I work on the NIL side with Jeremiah Wilkinson, a college athlete here
//    in your area. I had an idea for a partnership with Wellness Professionals,
//    Inc. Would love to send over a short overview if you're open to it!"
//
// Two variables in a fixed sentence. It says nothing about the business, nothing
// about the athlete, and asks for nothing. A gym owner has read it a hundred
// times and can tell in one line that a person did not write it.
//
// THE MODEL DECIDES THE ANGLE BEFORE IT WRITES. The schema puts `angle` and
// `ask` ahead of `message`, and generation is autoregressive, so the reasoning
// is committed before the first word of copy exists rather than reverse-engineered
// from it. One call, not two: an angle chosen in a separate call has to be
// re-read by the writing call, and what comes back is a message about the angle
// instead of a message from it.
//
// IT MAY REFUSE. If nothing real connects this athlete to this business, it
// returns skip and no pitch is written. Five strong ones beat five where two are
// filler, and a filler pitch costs more than nothing -- it burns the one first
// impression this business will give us.
//
// VOICE IS ENFORCED TWICE. The prompt states the rules; lintMessage() then
// checks the output against them, because a prompt is a request and this is a
// requirement. The failure mode being defended against is not a bad message, it
// is an obviously-well-researched, obviously-machine-written message, which
// lands worse than a lazy template because it reads as uncanny rather than lazy.

// ── Category playbook ────────────────────────────────────────────────────────
// A restaurant wants people through the door tonight. A dealership wants a face
// its 18-24 buyers recognise. A gym wants signups it can count. A retailer wants
// the product worn where people see it. Same athlete, different ask.
// Keyed on the Google primaryType we already store.
const CATEGORY_PLAYBOOK = [
  { match: /restaurant|cafe|coffee|bakery|bar|pizza|food|meal|diner|brunch|ice_cream|deli/i,
    key: 'foot-traffic',
    wants: 'people through the door on a specific day',
    ask: 'a post or story tied to a named day or game, so the traffic is countable' },
  { match: /car_dealer|auto|motorcycle|truck|rv_|boat/i,
    key: 'face-of-brand',
    wants: 'a face their 18-24 buyers recognise, since that buyer ignores their usual advertising',
    ask: 'an appearance plus content, positioned as the young face of the dealership' },
  { match: /gym|fitness|health_club|yoga|pilates|martial_arts|sports_club|athletic/i,
    key: 'signups',
    wants: 'memberships they can attribute, not brand awareness',
    ask: 'a trackable code or a training-session post that drives signups' },
  { match: /clothing|apparel|shoe|store|shop|retail|boutique|jewel|sporting_goods|supplement|nutrition/i,
    key: 'product-worn',
    wants: 'the product worn and seen by people who live nearby',
    ask: 'product in exchange for wear-and-post content, then a paid follow-up if it works' },
  { match: /dentist|dental|orthodont|chiropract|physical_therapy|medical|clinic|doctor|physician|optometr|spa|salon|barber/i,
    key: 'local-trust',
    wants: 'local trust and new patients from families who follow local sport',
    ask: 'a straightforward endorsement post plus a visit, kept low-key and credible' },
  { match: /real_estate|insurance|bank|financial|accounting|law|attorney|agency/i,
    key: 'community-standing',
    wants: 'to be seen backing local athletes, which is how this category buys goodwill',
    ask: 'a sponsorship credit and a post, framed as supporting a local athlete' },
];
const DEFAULT_PLAY = {
  key: 'local-visibility',
  wants: 'visibility with people who actually live near them',
  ask: 'one small, specific, named piece of content',
};

function playbookFor(category) {
  const c = String(category || '');
  return CATEGORY_PLAYBOOK.find((p) => p.match.test(c)) || DEFAULT_PLAY;
}

// ── Voice lint ───────────────────────────────────────────────────────────────
// Each rule is a rejection with a NAMED reason, so a retry can be told what to
// fix rather than asked again and hoped at.
const BANNED_OPENERS = [
  /^\s*i hope (this|you)/i, /^\s*hope (this|you|your)/i, /^\s*i wanted to reach out/i,
  /^\s*i'?m reaching out/i, /^\s*just reaching out/i, /^\s*i am writing to/i,
  /^\s*my name is [a-z]+ and i/i, /^\s*hope all is well/i,
];
// ── Money never appears in outreach ──────────────────────────────────────────
// Naming a price in a cold message starts a negotiation before there is anything
// to negotiate about, and it anchors the business at whatever we guessed. The
// deliverable is the ask; the money is a conversation the agent has after they
// reply. Follower counts and "two feed posts" are numbers and stay welcome --
// these patterns match CURRENCY, not counting.
const PRICE_PATTERNS = [
  /\$\s*\d/,                                       // $500, $ 500
  /\b\d[\d,.]*\s*(dollars|usd|bucks|k\b)/i,          // 500 dollars, 2k
  /\bdollars?\b/i, /\busd\b/i,
  /\b(rate|fee|pricing|price|budget|compensation|payment|honorarium)s?\b/i,
  /\bpaid?\s+\$?\d/i,                              // "paid 500"
  /\bper\s+(post|story|reel|appearance|video)\s*[:,]?\s*\$?\d/i,
];
function containsPrice(text) {
  const t = String(text || '');
  for (const re of PRICE_PATTERNS) { const m = t.match(re); if (m) return m[0]; }
  return null;
}

// ── A CONCRETE ASK NAMES WHAT THE ATHLETE WOULD DO ───────────────────────────
//
// This was the single largest rejection cause on the audit: five good pitches
// thrown away by our own lint. It used to demand a QUANTIFIER followed by a noun
// -- "two feed posts", "a visit" -- which meant "I'd post about you on game day"
// and "she'd come by the shop" both failed for naming the deliverable in a
// perfectly normal way.
//
// The rule is now what it always should have been: the message says what the
// athlete would DO. Format is not the writer's problem. A count is welcome and
// not required, and the verb forms are accepted alongside the nouns, because
// "post about you" and "a post about you" are the same offer.
//
// It is still a real check -- "would love to send over an overview" names no
// action and still fails, which is the case this exists for.
const DELIVERABLE_NOUNS = 'post|posts|story|stories|reel|reels|video|videos|appearance|appearances|'
  + 'visit|visits|session|sessions|shoutout|shoutouts|shout[- ]out|mention|mentions|photo|photos|'
  + 'takeover|takeovers|signing|signings|clinic|clinics|drop-?in|meet[- ]and[- ]greet|'
  + 'giveaway|giveaways|collab|collabs|feature|features|tag|tags|content|demo|demos';
// The same offers, said as verbs. A pitch is not less concrete for using one.
const DELIVERABLE_VERBS = 'post(ing|s)?|share|sharing|shares|shout(ing)? (?:you )?out|film(ing|s)?|'
  + 'record(ing|s)?|wear(ing|s)?|show up|come (?:by|in|out)|stop by|drop by|appear(ing|s)?|'
  + 'sign(ing)? autographs|tag(ging|s)?|feature(s|d)?|mention(ing|s)?|rep(ping|s)?|'
  + 'bring(ing)? (?:her|his|their)|hand out|host(ing|s)?';
const DELIVERABLE_RE = new RegExp(
  '\\b(?:(?:a|an|one|two|three|four|five|six|couple of|\\d+)\\s+(?:\\w+[- ]){0,2}(?:' + DELIVERABLE_NOUNS + ')'
  + '|(?:' + DELIVERABLE_VERBS + ')'
  + '|(?:' + DELIVERABLE_NOUNS + ')\\s+(?:about|for|at|with|of)\\b)', 'i');

const CORPORATE_FILLER = [
  /\bleverag(e|es|ing)\b/i, /\bseamless(ly)?\b/i, /\bcircle(s|d)? back\b/i,
  /\bsynerg(y|ies|istic)\b/i, /\btouch base\b/i, /\breach out\b/i, /\bbandwidth\b/i,
  /\bdeliverables?\b/i, /\becosystem\b/i, /\balign(ed|ment|s)? with your brand\b/i,
  /\bexcited to (partner|explore)\b/i, /\bvalue[- ]add\b/i, /\bmoving forward\b/i,
  /\bat your earliest convenience\b/i, /\bunlock\b/i, /\bempower\b/i, /\belevate\b/i,
  /\bgame[- ]?changer\b/i, /\bwin[- ]win\b/i, /\bpassionate about\b/i,
];

// The sign-off is a line, not a sentence. Counting "JohnMark" as one let a
// two-sentence message pass the minimum and pushed a legitimate five-sentence
// message over the maximum -- the rule was wrong in both directions at once.
function stripSignOff(text) {
  return String(text || '').replace(/\n+[ \t]*[A-Za-z][A-Za-z.'\- ]{0,30}[ \t]*$/, '').trim();
}

function sentenceCount(text) {
  return stripSignOff(text).split(/(?<=[.?])\s+/).map((s) => s.trim()).filter((s) => s.length > 1).length;
}

function lintMessage(msg, opts = {}) {
  const problems = [];
  const t = String(msg || '').trim();
  if (!t) return { ok: false, problems: ['empty message'] };

  if (/—|–/.test(t)) problems.push('contains an em or en dash');
  if (/!/.test(t)) problems.push('contains an exclamation mark');
  // The opener is tested AFTER any greeting. "Hi Dave, I hope this finds you
  // well" opens with a banned phrase just as surely as the bare version does,
  // and anchoring on the raw string missed exactly that case.
  const afterGreeting = t.replace(/^\s*(hi|hey|hello|good morning|good afternoon)\b[^,.!\n]{0,30}[,.!]?\s*/i, '');
  for (const re of BANNED_OPENERS) {
    if (re.test(t) || re.test(afterGreeting)) { problems.push('opens with a banned phrase'); break; }
  }
  for (const re of CORPORATE_FILLER) {
    if (re.test(t)) { problems.push('contains corporate filler: ' + (t.match(re) || [''])[0]); break; }
  }
  const n = sentenceCount(t);
  if (n > 5) problems.push(`${n} sentences, maximum is five`);
  if (n < 3) problems.push(`${n} sentences, minimum is three`);
  if (t.length > 700) problems.push('too long for a DM');
  // NO MONEY. Checked here rather than trusted to the prompt, because this is
  // the one rule where a single slip reaches a real business as a real number.
  const price = containsPrice(t);
  if (price) problems.push(`names a price ("${price.trim()}") — outreach names the deliverable, never the money`);
  // A concrete ask names something countable that gets made or done.
  if (opts.requireDeliverable !== false && !DELIVERABLE_RE.test(t)) {
    problems.push('the message never says what the athlete would actually do');
  }
  // The sign-off has to be the agent's own first name.
  // THE SIGN-OFF IS REPAIRED, NOT REJECTED. See repairSignOff: losing a business
  // because a name did not match a regex is not a trade worth making, and this
  // check threw away two good pitches for exactly that.
  if (opts.signOff && !signsOffAs(t, opts.signOff)) {
    problems.push('does not sign off as ' + opts.signOff);
  }
  return { ok: problems.length === 0, problems };
}

// Repairs that cannot change meaning. Anything that WOULD change meaning is left
// for the retry: silently rewriting a sentence to pass a lint is how a checker
// starts certifying its own edits.
// ── THE SIGN-OFF ─────────────────────────────────────────────────────────────
//
// The old check was `new RegExp('\\b' + name + '\\b', 'i')`. It was already
// case-insensitive, so case was never the problem -- the TRAILING \\b was. The
// account name was "john", the model signed "JohnMark" (the name it sees as the
// example throughout its own prompt), and \bjohn\b does not match "JohnMark"
// because M is a word character and there is no boundary after "john". Same for
// an account named "Jonathan" signed "Jon".
//
// So two perfectly good pitches to real businesses were thrown away over a word
// boundary. A name is not a correctness property of a pitch: it is a string we
// control, at the end, on its own line. It gets FIXED.
function firstNameOf(s) {
  return String(s || '').trim().split(/\s+/)[0] || '';
}

// Does the message already end with something that reads as this person? Matched
// leniently on purpose: a leading-prefix match in either direction accepts
// "John" for "JohnMark", "JohnMark" for "John", and "Jon" for "Jonathan".
function signsOffAs(text, signOff) {
  const want = firstNameOf(signOff).toLowerCase();
  if (!want) return true;
  const lines = String(text || '').trim().split(/\n/).map((x) => x.trim()).filter(Boolean);
  const tail = lines.slice(-2).join(' ').toLowerCase();
  if (!tail) return false;
  const words = tail.match(/[a-z][a-z.'\-]*/g) || [];
  return words.some((w) => w.startsWith(want) || want.startsWith(w) && w.length >= 3);
}

// Put the right name on the end. Replaces a wrong sign-off line rather than
// stacking a second one, and appends when there is none at all.
function repairSignOff(text, signOff) {
  const name = firstNameOf(signOff);
  if (!name) return String(text || '').trim();
  let t = String(text || '').trim();
  if (signsOffAs(t, name)) return t;
  // A short trailing line with no sentence punctuation is a sign-off with the
  // wrong name on it; anything else is the last sentence and must be kept.
  const lines = t.split(/\n/);
  const last = (lines[lines.length - 1] || '').trim();
  if (lines.length > 1 && last.length <= 32 && !/[.?!]$/.test(last) && /^[A-Za-z][A-Za-z.'\- ]*$/.test(last)) {
    lines.pop();
    t = lines.join('\n').trim();
  }
  return t + '\n\n' + name;
}

function autoRepair(msg) {
  let t = String(msg || '');
  t = t.replace(/\s*—\s*/g, ', ').replace(/\s*–\s*/g, ', ');
  t = t.replace(/!+/g, '.');
  // Horizontal whitespace only. Collapsing ALL whitespace destroyed the blank
  // line before the sign-off, which the voice rules require to be on its own
  // line -- a repair that broke the thing it was repairing toward.
  t = t.replace(/\.{2,}/g, '.').replace(/,[ \t]*,/g, ',');
  t = t.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

// ── NO INVENTED ATHLETE FACTS ────────────────────────────────────────────────
//
// The prompt asks the model to use what it was given. This CHECKS the result,
// because "use only the facts provided" is a request and a fabricated hometown
// is a lie told to a real business under an athlete's name.
//
// The rule: every fact about the athlete in the copy must trace to a stored
// field. If we hold no hometown, the pitch may not name one -- not a plausible
// one, not the school's city, none. The absence of a field is not an invitation
// to fill it.
//
// HOW IT IS ENFORCED. Each class of claim has a closed vocabulary or a numeric
// shape, so a claim can be FOUND in the text and then checked against the
// profile:
//
//   position   a fixed list of position words. Any that appears must match the
//              stored position. No stored position -> any of them is invented.
//   sport      same, against the stored sport.
//   class year freshman/sophomore/junior/senior/etc, against the stored year.
//   reach      any number >= 1,000 must match a stored follower figure (IG,
//              TikTok, or their sum) within 10%, or a number we were given about
//              the BUSINESS. No stored followers -> any big number is invented.
//   stats      a number next to a stat noun must appear in the stored stats
//              string. No stored stats -> any stat claim is invented.
//
// Small numbers that are not next to a stat noun are left alone: "two feed
// posts", "4.8 stars", "nine years on University Drive" are not athlete facts.
const POSITION_WORDS = [
  'quarterback', 'qb', 'running back', 'runningback', 'rb', 'wide receiver', 'receiver', 'wr',
  'tight end', 'te', 'offensive lineman', 'lineman', 'linebacker', 'lb', 'cornerback', 'corner',
  'safety', 'defensive end', 'defensive back', 'kicker', 'punter', 'edge rusher',
  'point guard', 'shooting guard', 'small forward', 'power forward', 'center', 'forward', 'guard',
  'pitcher', 'catcher', 'shortstop', 'outfielder', 'infielder', 'first baseman', 'second baseman',
  'third baseman', 'designated hitter',
  'goalkeeper', 'keeper', 'goalie', 'midfielder', 'striker', 'winger', 'defender', 'fullback',
  'setter', 'libero', 'outside hitter', 'middle blocker',
  'sprinter', 'distance runner', 'thrower', 'jumper', 'swimmer', 'diver', 'wrestler', 'golfer',
];
const SPORT_WORDS = [
  'football', 'basketball', 'baseball', 'softball', 'soccer', 'volleyball', 'track', 'cross country',
  'swimming', 'diving', 'tennis', 'golf', 'wrestling', 'gymnastics', 'lacrosse', 'hockey',
  'rowing', 'bowling', 'beach volleyball', 'water polo',
];
const YEAR_WORDS = [
  'freshman', 'sophomore', 'junior', 'senior', 'redshirt', 'graduate student', 'grad student',
  'true freshman', 'fifth year', 'fifth-year',
];
const STAT_NOUNS = /\b(tackles?|sacks?|yards?|touchdowns?|tds?|points?|rebounds?|assists?|goals?|saves?|steals?|blocks?|kills?|aces?|strikeouts?|home runs?|rbis?|era|batting average|interceptions?|catches|receptions?)\b/i;

function _words(s) { return String(s || '').toLowerCase(); }

// Longest-first so "wide receiver" is matched before "receiver".
function _findVocab(text, vocab) {
  const t = _words(text);
  const hits = [];
  for (const w of vocab.slice().sort((a, b) => b.length - a.length)) {
    const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(t) && !hits.some((h) => h.includes(w))) hits.push(w);
  }
  return hits;
}

// Numbers of 1,000 or more, however written: 35,000 / 35000 / 35k / 35K.
// A DATE IS NOT A FOLLOWER COUNT. The reach rule now REQUIRES a hand-entered
// count to be dated ("35,000 followers as of 14 Aug 2026"), and the year in that
// date is a four-digit number that this scanner would otherwise read as a reach
// claim -- refusing the pitch for citing "2026", which matches no stored count.
// The rule that makes pitches honest would have made every honest pitch fail.
// Dates come out before any number is judged.
const _DATE_SHAPES = [
  /\b(?:as of\s+)?\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi,
  /\b(?:as of\s+)?(?:19|20)\d{2}\b/gi,   // a bare year, e.g. "since 2016"
];
function _stripDates(text) {
  let s = String(text || '');
  for (const re of _DATE_SHAPES) s = s.replace(re, ' ');
  return s;
}

function _bigNumbers(text) {
  const out = [];
  const re = /\b(\d{1,3}(?:,\d{3})+|\d{4,}|\d+(?:\.\d+)?\s*[kK])\b/g;
  let m;
  while ((m = re.exec(_stripDates(text)))) {
    const raw = m[1];
    const n = /[kK]\s*$/.test(raw)
      ? Math.round(parseFloat(raw) * 1000)
      : parseInt(raw.replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n >= 1000) out.push({ raw, n });
  }
  return out;
}

function _near(a, b, tol) { return b > 0 && Math.abs(a - b) / b <= (tol === undefined ? 0.1 : tol); }

// opts.businessNumbers: figures we legitimately gave the model about the
// business (review count, years in operation), which are not athlete claims.
function verifyAthleteFacts(message, athlete, opts = {}) {
  const a = athlete || {};
  const t = String(message || '');
  const problems = [];

  // ── position ──────────────────────────────────────────────────────────────
  const storedPos = _words(a.position);
  for (const hit of _findVocab(t, POSITION_WORDS)) {
    if (!storedPos) { problems.push(`claims a position ("${hit}") and we hold none`); break; }
    if (!storedPos.includes(hit) && !hit.includes(storedPos)) {
      problems.push(`says "${hit}" but the stored position is "${a.position}"`); break;
    }
  }
  // ── sport ─────────────────────────────────────────────────────────────────
  const storedSport = _words(a.sport);
  for (const hit of _findVocab(t, SPORT_WORDS)) {
    if (!storedSport) { problems.push(`names a sport ("${hit}") and we hold none`); break; }
    if (!storedSport.includes(hit) && !hit.includes(storedSport)) {
      problems.push(`says "${hit}" but the stored sport is "${a.sport}"`); break;
    }
  }
  // ── class year ────────────────────────────────────────────────────────────
  const storedYear = _words(a.year);
  for (const hit of _findVocab(t, YEAR_WORDS)) {
    if (!storedYear) { problems.push(`calls them a "${hit}" and we hold no class year`); break; }
    if (!storedYear.includes(hit) && !hit.includes(storedYear)) {
      problems.push(`says "${hit}" but the stored year is "${a.year}"`); break;
    }
  }
  // ── hometown and school ───────────────────────────────────────────────────
  // Checked the other way round: rather than trying to spot every place name in
  // English, the copy is scanned for the STORED values, and a "grew up in X" /
  // "from X" construction whose X is not the stored hometown is the fabrication
  // this catches.
  const homeRe = /\b(?:grew up in|from|hometown of|native of|raised in)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})/g;
  const storedHome = _words(a.hometown);
  let hm;
  while ((hm = homeRe.exec(t))) {
    const claimed = _words(hm[1]).replace(/[.,]$/, '');
    if (!storedHome) { problems.push(`says they are ${hm[0].trim()} and we hold no hometown`); break; }
    const ok2 = storedHome.split(/[,\s]+/).filter(Boolean).some((tok) => claimed.includes(tok));
    if (!ok2) { problems.push(`says "${hm[1]}" but the stored hometown is "${a.hometown}"`); break; }
  }

  // ── reach ─────────────────────────────────────────────────────────────────
  const ig = Number(a.instagram) || 0, tt = Number(a.tiktok) || 0;
  const allowed = [ig, tt, ig + tt].filter((n) => n > 0);
  const bizNums = (opts.businessNumbers || []).map(Number).filter((n) => Number.isFinite(n));
  for (const b of _bigNumbers(t)) {
    if (bizNums.some((n) => _near(b.n, n, 0.02))) continue;          // a business figure
    if (!allowed.length) { problems.push(`cites "${b.raw}" as reach and we hold no follower counts`); break; }
    if (!allowed.some((n) => _near(b.n, n))) {
      problems.push(`cites "${b.raw}" which matches no stored follower count (${allowed.join(', ')})`); break;
    }
  }

  // A HAND-ENTERED FOLLOWER COUNT MUST NOT BE ASSERTED AS CURRENT. Matching a
  // stored figure only proves we did not invent it; it says nothing about
  // whether it is still true. A number typed in months ago, stated flat to a
  // business owner under the agent's name, is a claim we cannot stand behind.
  //
  // The pitch must either date it or not cite it. This lifts on its own when the
  // number starts coming from a connected Instagram: reachProvenance reports it
  // live and the rule stops applying.
  const RP = require('./reachProvenance');
  if (RP.citesReach(t)) {
    const prov = RP.reachProvenance(a, opts.now);
    if (!prov.isLive) {
      const dated = prov.asOfText && t.indexOf(prov.asOfText) !== -1;
      // "as of" in any form the writer might use, not only our exact rendering.
      const hedged = /\bas of\b|\bcurrently\b|\bat last count\b|\blast checked\b/i.test(t);
      if (!dated && !hedged) {
        problems.push('cites a follower count as if it were live. It is '
          + (prov.sourceLabel || 'hand-entered')
          + (prov.asOfText ? ` and dates from ${prov.asOfText}` : ' with no recorded date')
          + ' — say when it was measured or leave the number out');
      }
    }
  }

  // ── stats ─────────────────────────────────────────────────────────────────
  const storedStats = _words(a.stats);
  const statClaim = /(\d[\d,.]*)\s*(?:\+\s*)?([a-z ]{0,14}?)\b(tackles?|sacks?|yards?|touchdowns?|tds?|points?|rebounds?|assists?|goals?|saves?|steals?|blocks?|kills?|aces?|strikeouts?|home runs?|rbis?|interceptions?|catches|receptions?)\b/gi;
  let sm;
  while ((sm = statClaim.exec(t))) {
    const num = sm[1].replace(/,/g, '');
    if (!storedStats) { problems.push(`claims a stat ("${sm[0].trim()}") and we hold no stats`); break; }
    if (!storedStats.replace(/,/g, '').includes(num)) {
      problems.push(`claims "${sm[0].trim()}" which is not in the stored stats`); break;
    }
  }

  // ── the name ──────────────────────────────────────────────────────────────
  if (a.name) {
    const first = String(a.name).trim().split(/\s+/)[0];
    if (first && first.length > 2 && !new RegExp('\\b' + first + '\\b', 'i').test(t)) {
      problems.push(`never names the athlete (${a.name})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── Context ──────────────────────────────────────────────────────────────────
// Everything we hold about both sides, as prose rather than JSON: a model reads
// "4.7 stars from 312 reviews" better than {"rating":4.7,"userRatingCount":312},
// and the difference shows up in the copy.
function describeBusiness(b) {
  const L = [];
  const name = b.name || b.brandName || 'this business';
  L.push('Name: ' + name);
  if (b.category) L.push('Google category: ' + String(b.category).replace(/_/g, ' '));
  if (b.address) L.push('Where: ' + b.address);
  if (b.rating != null && b.userRatingCount != null) {
    L.push(`Reviews: ${b.rating} stars from ${b.userRatingCount} reviews`
      + (b.userRatingCount >= 300 ? ' (well established locally)'
        : b.userRatingCount < 40 ? ' (few reviews, may be new or small)' : ''));
  }
  // ── THE NAME, AND WHAT TO DO WITH IT ─────────────────────────────────────
  // The ladder finds these people -- Ronda Perkins, Daniel Eggers -- and the
  // prompt listed the name without ever saying to USE it, so pitches opened
  // "Hi," to a business whose owner we could name. Naming the reader is the
  // single biggest close-rate lever a brand-side reader identified.
  //
  // greetFirstName is set by the caller ONLY when the greeting guard has cleared
  // the contact, so this instruction and the enforcement downstream cannot
  // disagree. Absent means we could not verify who they are, and the model is
  // told to open "Hi," rather than left to guess.
  if (b.ownerName) L.push('Person to write to: ' + b.ownerName + (b.ownerTitle ? ', ' + b.ownerTitle : ''));
  if (b.greetFirstName) {
    L.push('OPEN THE MESSAGE WITH: "Hi ' + b.greetFirstName + ',"  — this name is verified, use it.');
  } else if (b.ownerName) {
    L.push('We could not verify this person well enough to greet them by name. Open with "Hi," '
      + 'and do not use their name anywhere in the message.');
  } else {
    L.push('No verified name. Open with "Hi," exactly.');
  }
  if (b.siteSummary) L.push('What their own website says: ' + b.siteSummary);
  if (b.sponsorsLocal) L.push('They already sponsor local teams or events.');
  if (b.isFranchise || b.corporate) L.push('Part of a chain, so the local operator may not control the budget.');
  if (b.recentlyOpened) L.push('Recently opened or expanded.');
  if (b.notes) L.push('Other: ' + b.notes);
  return L.join('\n');
}

function describeAthlete(a) {
  const L = [];
  L.push('Name: ' + (a.name || 'the athlete'));
  const bits = [a.year, a.position, a.sport].filter(Boolean).join(' ');
  if (bits) L.push('Plays: ' + bits + (a.school ? ' at ' + a.school : ''));
  else if (a.school) L.push('School: ' + a.school);
  if (a.hometown) L.push('From: ' + a.hometown);
  const ig = Number(a.instagram) || 0, tt = Number(a.tiktok) || 0;
  if (ig || tt) {
    const parts = [];
    if (ig) parts.push(ig.toLocaleString() + ' on Instagram');
    if (tt) parts.push(tt.toLocaleString() + ' on TikTok');
    // THE DATE TRAVELS WITH THE NUMBER. The lint refuses a follower count stated
    // as if it were live, so the model has to be TOLD when it was measured --
    // otherwise the instruction and the enforcement disagree and every pitch that
    // mentions reach burns a retry before being refused.
    // THE DATE TRAVELS WITH THE NUMBER, or the number does not travel at all.
    //
    // A count we cannot date cannot be cited honestly, so it is NOT HANDED TO THE
    // MODEL. Telling it "here is a number, please do not use it" is an invitation
    // to use it, and the fact-check would then refuse the whole pitch -- losing a
    // good pitch to save a number. Every athlete on the roster is in exactly this
    // state today, because the date field did not exist until now, so this is the
    // common case and not an edge one.
    //
    // Withholding it costs a sentence. Citing it would state an unknown-age
    // figure to a real business as current, under the agent's name.
    const RP = require('./reachProvenance');
    const prov = RP.reachProvenance(a);
    if (prov.isLive) {
      L.push('Following: ' + parts.join(', ') + ' (' + (ig + tt).toLocaleString() + ' combined)');
    } else if (prov.asOfText) {
      L.push('Following: ' + parts.join(', ') + ' (' + (ig + tt).toLocaleString() + ' combined)'
        + ` — measured ${prov.asOfText}, NOT live. If you cite it, write "as of ${prov.asOfText}".`);
    } else {
      L.push('Following: not usable. We hold counts but no date for them, so they cannot be '
        + 'quoted as current. Write the pitch without a follower number.');
    }
  }
  if (a.stats) L.push('On the field: ' + a.stats);
  if (Array.isArray(a.tags) && a.tags.length) L.push('Posts about: ' + a.tags.join(', '));
  if (a.productWants) L.push('Wants to work with: ' + a.productWants);
  if (a.notes) L.push('Notes: ' + a.notes);
  return L.join('\n');
}

const SYSTEM = `You write short outreach messages for a sports agent pitching local businesses on partnering with a college athlete.

You are not a copywriter and you are not a chatbot. You are a sales manager who did the homework and respects the reader's time. The person reading has a business to run and thirty seconds.

Before writing anything, decide the ANGLE: the one real connection between what this specific athlete uniquely offers and what this specific business actually needs. If there is no real connection, say so and write nothing. A weak pitch costs more than no pitch, because this business only gives one first impression.

HARD RULES FOR THE MESSAGE:
- Three to five sentences. Never longer.
- No em dashes. No exclamation marks.
- Never open with "I hope this finds you well", "I wanted to reach out", or "my name is".
- No corporate words. Nothing leverages, nothing is seamless, nobody circles back, nothing is a game-changer.
- Do not compliment the business before getting to the point. One short specific observation is fine; a paragraph of flattery is not.
- One idea per message. Do not stack offers.
- Use contractions. Write how a person talks.
- Name the DELIVERABLE, never the price. "Two feed posts and an appearance at your location" is a real ask. "Would love to send over a short overview" is not.
- NEVER put a dollar amount, a rate, a fee or a budget in the message. Not a range, not "starting at", not "around". Money comes up after they reply, and the agent handles it from there. A number in a cold message turns a conversation into a negotiation before there is anything to negotiate about.
- Sign off with the agent's first name on its own line.
- THE GREETING IS DICTATED, NOT CHOSEN. THE BUSINESS block above tells you exactly
  what to open with. Follow it literally. A name you were not given is a name you
  invented, and it reaches a real business under the agent's own name.

NEVER invent a fact about the athlete. Use only what is listed under THE ATHLETE. If no hometown is listed, do not name one. If no position is listed, do not name one. If no follower count is listed, do not cite one. A missing field is not a gap to fill, and a plausible guess is still a lie told to a real business under this athlete's name.

The message must be answerable yes or no without a follow-up question.`;

function buildPrompt(ctx) {
  const play = playbookFor(ctx.business && ctx.business.category);
  const learned = (ctx.learnedAngles && ctx.learnedAngles.length)
    ? `\nANGLES THAT HAVE ACTUALLY GOT REPLIES from this category, most replied-to first: `
      + ctx.learnedAngles.map((a) => `${a.angle} (${a.replied}/${a.sent} replied)`).join('; ')
      + `\nTreat this as evidence, not instruction. Use one only if it genuinely fits this pairing.\n`
    : '';
  // THE VALUATION IS DELIBERATELY NOT HERE. It stays on the Deal Scan card for
  // the agent, and it is never shown to the model: a number in the context window
  // ends up in the copy, whatever the instruction above it says. The cheapest way
  // to guarantee no price in the outreach is for the writer never to learn one.
  const deal = ctx.deal || {};
  const dealLines = [];
  if (deal.reasoning) dealLines.push('Why the scan surfaced this business: ' + deal.reasoning);
  if (Array.isArray(deal.campaignIdeas) && deal.campaignIdeas.length) {
    dealLines.push('Campaign ideas already generated: ' + deal.campaignIdeas.slice(0, 3).join('; '));
  }

  return `THE BUSINESS
${describeBusiness(ctx.business || {})}

THE ATHLETE
${describeAthlete(ctx.athlete || {})}

WHAT THIS CATEGORY TYPICALLY WANTS
${play.wants}. A fitting ask looks like: ${play.ask}.
${dealLines.length ? '\nWHAT WE ALREADY WORKED OUT\n' + dealLines.join('\n') + '\n' : ''}${learned}
The agent's first name, for the sign-off: ${ctx.agentFirstName || 'JohnMark'}
The channel: ${ctx.channel === 'email' ? 'email' : 'an Instagram DM'}

Return ONLY JSON, in exactly this order:
{
  "angle": "one sentence naming the real connection between THIS athlete and THIS business",
  "angleKey": "two-to-four word slug for the angle, lowercase, hyphenated",
  "ask": "the concrete deliverable and number you are asking for",
  "confidence": "strong" | "thin",
  "message": "the message itself, three to five sentences, signed off"
}

If there is no real connection worth pitching, return instead:
{ "skip": true, "reason": "one sentence saying what is missing" }`;
}

// ── The call ─────────────────────────────────────────────────────────────────
// oneShot is INJECTED so this module never imports ai.js: it stays testable
// without a network and without a key.
async function writePitch(ctx, opts = {}) {
  const oneShot = opts.oneShot;
  if (typeof oneShot !== 'function') throw new Error('writePitch requires opts.oneShot');
  const agentFirst = String(ctx.agentFirstName || 'JohnMark').trim().split(/\s+/)[0];
  const lintOpts = { signOff: agentFirst, requireDeliverable: opts.requireDeliverable !== false };

  const attempt = async (extra) => {
    const raw = await oneShot(buildPrompt(ctx) + (extra || ''), SYSTEM, 900, opts.model);
    let j = null;
    try {
      const s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '');
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) j = JSON.parse(s.slice(a, b + 1));
    } catch (_) { j = null; }
    return j;
  };

  let j = await attempt('');
  if (!j) return { skipped: true, reason: 'the writer returned nothing usable', error: true };
  if (j.skip) {
    return { skipped: true, reason: String(j.reason || 'no real connection to pitch').trim() };
  }

  const factsOf = (m) => verifyAthleteFacts(m, ctx.athlete, {
    businessNumbers: [ctx.business && ctx.business.userRatingCount].filter(Boolean),
  });

  // REPAIRED BEFORE IT IS JUDGED. The sign-off is a string we control at the end
  // of the message; there is no reason for it to be able to fail a pitch.
  let message = repairSignOff(autoRepair(j.message), agentFirst);
  let lint = lintMessage(message, lintOpts);
  // A FABRICATED FACT IS A LINT FAILURE. Same path, same retry, same refusal:
  // an invented hometown is worse than an em dash, not softer.
  let facts = factsOf(message);
  if (!facts.ok) lint = { ok: false, problems: lint.problems.concat(facts.problems) };
  if (!lint.ok) {
    // ONE retry, told exactly what was wrong. Asking again unchanged just spends
    // a second call on the same mistake.
    const j2 = await attempt(`\n\nYour previous attempt was rejected for: ${lint.problems.join('; ')}. `
      + `Rewrite the message fixing every one of those. Keep the same angle and the same ask. `
      + `Use ONLY facts listed in THE ATHLETE above. If a detail is not listed there, leave it out entirely.`);
    if (j2 && j2.skip) return { skipped: true, reason: String(j2.reason || 'no real connection').trim() };
    if (j2 && j2.message) {
      const m2 = repairSignOff(autoRepair(j2.message), agentFirst);
      const l2 = lintMessage(m2, lintOpts);
      const f2 = factsOf(m2);
      if (l2.ok && f2.ok) { j = j2; message = m2; lint = l2; }
      else lint = { ok: false, problems: l2.problems.concat(f2.problems) };
    }
  }
  if (!lint.ok) {
    // Twice rejected. NOT sent as-is: a message that breaks the voice rules is
    // the failure this rewrite exists to remove.
    return { skipped: true, reason: 'could not write it in voice: ' + lint.problems.join('; '), lintFailed: true };
  }
  if (!facts.ok && (facts = factsOf(message)) && !facts.ok) {
    return { skipped: true, reason: 'invented a fact about the athlete: ' + facts.problems.join('; '), factsFailed: true };
  }

  const play = playbookFor(ctx.business && ctx.business.category);
  return {
    skipped: false,
    message,
    angle: String(j.angle || '').trim() || null,
    angleKey: String(j.angleKey || play.key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
    ask: String(j.ask || '').trim() || null,
    confidence: j.confidence === 'thin' ? 'thin' : 'strong',
    categoryKey: play.key,
  };
}

// ── Learning from replies ────────────────────────────────────────────────────
// Reply capture works, so which angles get answered is a fact rather than a
// theory. Below MIN_SAMPLE this returns nothing: weighting on four sends is
// superstition, and a prompt told "this angle works" on that evidence will
// dutifully overuse it.
const MIN_SAMPLE = 12;

async function learnedAngles(pool, categoryKey, opts = {}) {
  const min = opts.minSample === undefined ? MIN_SAMPLE : opts.minSample;
  try {
    const r = await pool.query(
      `SELECT angle_key AS angle,
              COUNT(*)::int                                  AS sent,
              COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
         FROM outreach_queue
        WHERE angle_key IS NOT NULL AND category_key = $1 AND sent_at IS NOT NULL
        GROUP BY angle_key
        HAVING COUNT(*) >= 3
        ORDER BY (COUNT(*) FILTER (WHERE replied_at IS NOT NULL))::float / COUNT(*) DESC,
                 COUNT(*) DESC
        LIMIT 3`, [categoryKey]);
    const rows = r.rows || [];
    const total = rows.reduce((n, x) => n + Number(x.sent), 0);
    if (total < min) return [];        // not enough to weight on yet
    return rows.filter((x) => Number(x.replied) > 0)
      .map((x) => ({ angle: x.angle, sent: Number(x.sent), replied: Number(x.replied) }));
  } catch (e) {
    console.error('[pitchWriter] learnedAngles:', e.message);
    return [];
  }
}

module.exports = {
  writePitch, lintMessage, autoRepair, containsPrice, verifyAthleteFacts,
  playbookFor, describeBusiness, describeAthlete,
  buildPrompt, sentenceCount, stripSignOff, learnedAngles,
  signsOffAs, repairSignOff, firstNameOf,
  CATEGORY_PLAYBOOK, DEFAULT_PLAY, BANNED_OPENERS, CORPORATE_FILLER, PRICE_PATTERNS,
  DELIVERABLE_RE, DELIVERABLE_NOUNS, DELIVERABLE_VERBS, SYSTEM, MIN_SAMPLE,
  POSITION_WORDS, SPORT_WORDS, YEAR_WORDS,
};
