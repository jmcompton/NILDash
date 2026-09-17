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

// ── THE SEASON IS USUALLY WRONG ─────────────────────────────────────────────
// A pitch that anchors on "before the season starts" or "during spring practice"
// is guessing at a calendar we do not hold, and agents report it is wrong more
// often than not. Wrong once, to a business that follows the team, costs the
// pitch. The athlete's value does not depend on what week it is.
const SEASON_TIMING = [
  /\bbefore (?:the )?season\b/i, /\b(?:this|next|the) season starts\b/i,
  /\bspring (?:practice|ball|game)\b/i, /\bfall camp\b/i, /\btwo[- ]a[- ]days\b/i,
  /\bduring (?:the )?(?:season|preseason|offseason|off[- ]season)\b/i,
  /\b(?:home|away) (?:game|games) (?:this|next)\b/i, /\bgame week\b/i,
  /\bbowl (?:game|season)\b/i, /\bmarch madness\b/i, /\bkicks? off (?:in|on|next)\b/i,
  /\bahead of (?:the )?(?:season|opener)\b/i, /\bpractice schedule\b/i,
];

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

// The athlete's Instagram link is a REFERENCE, not a sentence, exactly as the
// sign-off is a line rather than a sentence. Counting it pushed a correctly
// structured five-part pitch over the maximum and lost it to a retry.
function stripProfileLink(text) {
  return String(text || '')
    .replace(/^[ \t]*(?:https?:\/\/)?(?:www\.)?instagram\.com\/[A-Za-z0-9._]+\/?[ \t]*$/gim, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function sentenceCount(text) {
  return stripProfileLink(stripSignOff(text))
    .split(/(?<=[.?])\s+/).map((s) => s.trim()).filter((s) => s.length > 1).length;
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
  // We do not hold this athlete's schedule, so any sentence that depends on it is
  // a guess made to a business that very likely knows the real answer.
  for (const re of SEASON_TIMING) {
    if (re.test(t)) {
      problems.push('anchors on the season or practice schedule ("'
        + (t.match(re) || [''])[0] + '"), which we do not hold and get wrong');
      break;
    }
  }
  const n = sentenceCount(t);
  if (n > 5) problems.push(`${n} sentences, maximum is five`);
  // Four, not three: the prescribed shape is opener, where they are, what they
  // post, and the closing question. A three-sentence version has dropped one of
  // them, and the one it usually drops is the content line -- the part a business
  // is actually buying.
  if (n < 4) problems.push(`${n} sentences, minimum is four`);
  if (t.length > 700) problems.push('too long for a DM');
  // NO MONEY. Checked here rather than trusted to the prompt, because this is
  // the one rule where a single slip reaches a real business as a real number.
  const price = containsPrice(t);
  if (price) problems.push(`names a price ("${price.trim()}") — outreach names the deliverable, never the money`);
  // ── THE DELIVERABLE LINT IS OFF FOR THIS VOICE, DELIBERATELY ────────────
  // It demanded a countable deliverable, and the voice agents asked for sells
  // POTENTIAL rather than a package: a first message that hands over a menu can
  // be declined in one word. So requireDeliverable now defaults OFF and the
  // callers that still want it opt in.
  //
  // This is also the rule that rejected 5 pitches in the run that paused six
  // athletes for nine days (f1b11aa), so it is worth saying plainly that it is
  // now off by default rather than merely loosened again.
  if (opts.requireDeliverable === true && !DELIVERABLE_RE.test(t)) {
    problems.push('the message never says what the athlete would actually do');
  }
  // The sign-off has to be the agent's own first name.
  // THE SIGN-OFF IS REPAIRED, NOT REJECTED. See repairSignOff: losing a business
  // because a name did not match a regex is not a trade worth making, and this
  // check threw away two good pitches for exactly that.
  if (opts.signOff && !signsOffAs(t, opts.signOff)) {
    problems.push('does not sign off as ' + opts.signOff);
  }
  // THE FIRST LINE NAMES THE READER. "Hi," "Hi there," "Hello," or no greeting
  // at all is a rejected draft when we know who we are writing to.
  if (opts.greetFirstName) {
    const first = t.split('\n').map((x) => x.trim()).find(Boolean) || '';
    const want = new RegExp('^(hi|hello|hey|dear|good (morning|afternoon|evening))\\s+' + opts.greetFirstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,!.:—-]', 'i');
    if (!want.test(first)) problems.push('does not open with "Hi ' + opts.greetFirstName + ',"');
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
  'tight end', 'te', 'offensive lineman', 'offensive tackle', 'offensive guard', 'lineman', 'linebacker', 'lb',
  'cornerback', 'corner', 'safety', 'free safety', 'strong safety', 'defensive end', 'defensive tackle',
  'defensive lineman', 'nose tackle', 'defensive back', 'kicker', 'punter', 'edge rusher', 'long snapper', 'returner',
  'point guard', 'shooting guard', 'small forward', 'power forward', 'center', 'forward', 'guard', 'wing',
  'pitcher', 'catcher', 'shortstop', 'outfielder', 'infielder', 'first baseman', 'second baseman',
  'third baseman', 'designated hitter', 'utility player', 'center fielder', 'left fielder', 'right fielder',
  'goalkeeper', 'keeper', 'goalie', 'midfielder', 'striker', 'winger', 'defender', 'fullback',
  'center back', 'centre back', 'wing back', 'defenseman', 'defenceman',
  'setter', 'libero', 'outside hitter', 'middle blocker', 'opposite hitter', 'defensive specialist',
  'attackman', 'attacker', 'faceoff specialist',
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

// ── ONE POSITION, SEVERAL NAMES ─────────────────────────────────────────────
//
// The prescribed opener is "[athlete], [position] on the [team]" and positions
// are STORED as abbreviations -- "WR", "QB", "RB". So the voice we asked for
// says "a wide receiver" about an athlete whose stored position is "WR", and the
// check compared the two as strings: 'wr'.includes('wide receiver') is false and
// so is the reverse, so the pitch was refused for saying the right thing.
//
// That rejected essentially every football pitch written in the new voice.
// Compared by GROUP now, so any name for a position matches any other.
const POSITION_GROUPS = [
  ['quarterback', 'qb'],
  ['running back', 'runningback', 'rb', 'tailback', 'halfback'],
  ['wide receiver', 'receiver', 'wr', 'wideout'],
  ['tight end', 'te'],
  ['offensive lineman', 'lineman', 'offensive tackle', 'offensive guard'],
  ['linebacker', 'lb'],
  ['cornerback', 'corner'],
  ['defensive back'], ['defensive end'], ['defensive tackle', 'nose tackle'], ['defensive lineman'],
  ['safety', 'free safety', 'strong safety'], ['edge rusher'],
  ['kicker'], ['punter'], ['long snapper'], ['returner'],
  ['point guard'], ['shooting guard'], ['small forward'], ['power forward'],
  ['center'], ['forward'], ['guard'], ['wing'],
  ['pitcher'], ['catcher'], ['shortstop'], ['outfielder', 'center fielder', 'left fielder', 'right fielder'], ['infielder'],
  ['first baseman'], ['second baseman'], ['third baseman'], ['designated hitter'], ['utility player'],
  ['goalkeeper', 'keeper', 'goalie'], ['midfielder'], ['striker'], ['winger'],
  ['defender', 'center back', 'centre back', 'wing back'], ['fullback'], ['defenseman', 'defenceman'],
  ['setter'], ['libero'], ['outside hitter'], ['middle blocker'], ['opposite hitter'], ['defensive specialist'],
  ['attackman', 'attacker'], ['faceoff specialist'],
  ['sprinter'], ['distance runner'], ['thrower'], ['jumper'], ['swimmer'],
  ['diver'], ['wrestler'], ['golfer'],
];
const _POS_KEY = new Map();
for (const g of POSITION_GROUPS) for (const w of g) _POS_KEY.set(w, g[0]);

// ── ABBREVIATIONS, BY SPORT ─────────────────────────────────────────────────
//
// The roster lookup stores what ESPN stores: the ABBREVIATION. "CB", "S",
// "OL", "PG". The model, handed "Junior CB football", writes "cornerback",
// because that is the word -- and the check, knowing only QB/RB/WR/TE/LB,
// called that a fabrication and bought a second Sonnet call on 71 of 73
// writes one night. The same letters mean different things by sport: C is a
// center in football and basketball and a catcher in baseball; P is a punter
// or a pitcher; F and G are basketball or soccer or hockey; SS is a shortstop
// or a strong safety; CB, RB and LB are football positions or soccer backs.
// So the abbreviation is resolved THROUGH THE ATHLETE'S SPORT, and a letter
// that means two things is left unresolved when the sport is unknown rather
// than guessed.
const POSITION_ABBR = {
  football: {
    qb: 'quarterback', rb: 'running back', hb: 'running back', tb: 'running back', fb: 'fullback',
    wr: 'wide receiver', te: 'tight end',
    ol: 'offensive lineman', ot: 'offensive lineman', og: 'offensive lineman', g: 'offensive lineman', t: 'offensive lineman', c: 'center',
    dl: 'defensive lineman', de: 'defensive end', dt: 'defensive tackle', nt: 'defensive tackle',
    lb: 'linebacker', olb: 'linebacker', ilb: 'linebacker', mlb: 'linebacker', edge: 'edge rusher',
    cb: 'cornerback', db: 'defensive back', s: 'safety', fs: 'safety', ss: 'safety',
    k: 'kicker', pk: 'kicker', p: 'punter', ls: 'long snapper', kr: 'returner', pr: 'returner', ath: null,
  },
  basketball: {
    pg: 'point guard', sg: 'shooting guard', sf: 'small forward', pf: 'power forward', c: 'center',
    g: 'guard', f: 'forward', w: 'wing', 'g/f': 'wing', 'f/c': 'forward',
  },
  baseball: {
    p: 'pitcher', sp: 'pitcher', rp: 'pitcher', rhp: 'pitcher', lhp: 'pitcher', c: 'catcher',
    '1b': 'first baseman', '2b': 'second baseman', '3b': 'third baseman', ss: 'shortstop',
    if: 'infielder', inf: 'infielder', of: 'outfielder', lf: 'outfielder', cf: 'outfielder', rf: 'outfielder',
    dh: 'designated hitter', ut: 'utility player', util: 'utility player',
  },
  soccer: {
    gk: 'goalkeeper', g: 'goalkeeper', d: 'defender', def: 'defender', cb: 'defender', lb: 'defender', rb: 'defender',
    fb: 'defender', wb: 'defender', m: 'midfielder', mf: 'midfielder', mid: 'midfielder', cm: 'midfielder',
    cdm: 'midfielder', cam: 'midfielder', dm: 'midfielder', am: 'midfielder', lm: 'midfielder', rm: 'midfielder',
    f: 'forward', fw: 'forward', fwd: 'forward', st: 'forward', w: 'winger', lw: 'winger', rw: 'winger',
  },
  volleyball: {
    s: 'setter', oh: 'outside hitter', mb: 'middle blocker', mh: 'middle blocker', opp: 'opposite hitter',
    rs: 'opposite hitter', l: 'libero', ds: 'defensive specialist', dsl: 'libero',
  },
  hockey: {
    c: 'center', lw: 'winger', rw: 'winger', w: 'winger', f: 'forward', d: 'defenseman', g: 'goalkeeper', gk: 'goalkeeper',
  },
  lacrosse: {
    a: 'attackman', att: 'attackman', m: 'midfielder', mid: 'midfielder', d: 'defender', lsm: 'defender',
    g: 'goalkeeper', gk: 'goalkeeper', fo: 'faceoff specialist', fogo: 'faceoff specialist',
  },
};
// Abbreviations that mean the same thing in every sport that uses them, for
// the caller who does not know the sport. Anything that differs by sport is
// deliberately absent, so "C" with no sport resolves to nothing rather than
// to a guess.
const _ABBR_ANY = (() => {
  const seen = new Map();
  for (const table of Object.values(POSITION_ABBR)) {
    for (const [k, v] of Object.entries(table)) {
      if (!seen.has(k)) seen.set(k, v);
      else if (seen.get(k) !== v) seen.set(k, false);
    }
  }
  const out = new Map();
  for (const [k, v] of seen) if (v) out.set(k, v);
  return out;
})();

// A sport string ("Football", "women's soccer", "Men's Ice Hockey") to the
// family whose abbreviation table applies, or null.
function sportFamily(sport) {
  const s = _words(sport);
  if (!s) return null;
  if (/soccer|futbol/.test(s)) return 'soccer';
  if (/football/.test(s)) return 'football';
  if (/basketball/.test(s)) return 'basketball';
  if (/baseball|softball/.test(s)) return 'baseball';
  if (/volleyball/.test(s)) return 'volleyball';
  if (/hockey/.test(s)) return 'hockey';
  if (/lacrosse/.test(s)) return 'lacrosse';
  return null;
}

// ── ONE SPORT, SEVERAL NAMES ────────────────────────────────────────────────
// The same problem as positions: a roster feed or an agent stores "MBB",
// "WSOC", "T&F" or "Ice Hockey", the model says "basketball", "soccer",
// "track" or "hockey", and the fact check refused it as a different sport
// ("says X but the stored sport is Y"). The stored value is EXPANDED before it
// reaches the model, the prompt says what word to use, and the check compares
// by canonical sport. Gender prefixes are not identity: "women's soccer" and
// "soccer" are the same sport to a business owner. Baseball and softball are
// NOT the same sport.
const SPORT_ABBR = {
  fb: 'football', cfb: 'football', 'american football': 'football',
  mbb: 'basketball', wbb: 'basketball', bb: 'basketball', bball: 'basketball', hoops: 'basketball',
  bsb: 'baseball', sb: 'softball', fastpitch: 'softball',
  soc: 'soccer', msoc: 'soccer', wsoc: 'soccer', futbol: 'soccer',
  vb: 'volleyball', mvb: 'volleyball', wvb: 'volleyball', 'beach vb': 'beach volleyball',
  xc: 'cross country', 'cross-country': 'cross country',
  tf: 'track and field', 't&f': 'track and field', track: 'track and field', 'track & field': 'track and field',
  lax: 'lacrosse', mlax: 'lacrosse', wlax: 'lacrosse',
  hky: 'ice hockey', ih: 'ice hockey', mhky: 'ice hockey', whky: 'ice hockey', hockey: 'ice hockey',
  fh: 'field hockey',
  mgolf: 'golf', wgolf: 'golf', ten: 'tennis', swim: 'swimming', 'swimming and diving': 'swimming', 'swim & dive': 'swimming', sd: 'swimming',
  gym: 'gymnastics', wr: 'wrestling', wres: 'wrestling', row: 'rowing', crew: 'rowing', wp: 'water polo', 'water polo': 'water polo',
  cheer: 'cheer', cheerleading: 'cheer', dance: 'dance', ski: 'skiing', tri: 'triathlon',
};
const SPORT_CANON = new Set(['football', 'basketball', 'baseball', 'softball', 'soccer', 'volleyball', 'beach volleyball',
  'cross country', 'track and field', 'lacrosse', 'ice hockey', 'field hockey', 'golf', 'tennis', 'swimming', 'diving',
  'gymnastics', 'wrestling', 'rowing', 'water polo', 'bowling', 'cheer', 'dance', 'skiing', 'triathlon']);
// The canonical sport for a stored value or a word the model wrote, or null
// when it is not one we know (the caller then compares strings).
function sportKey(s) {
  let k = _words(s).replace(/[’']/g, '').replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  if (!k) return null;
  // Gender is not identity.
  k = k.replace(/^(mens|womens|men|women|m|w|boys|girls)\s+/, '').replace(/\s*\((?:m|w|men|women|mens|womens)\)\s*$/, '').trim();
  if (SPORT_ABBR[k]) return SPORT_ABBR[k];
  if (SPORT_CANON.has(k)) return k;
  // "D1 Softball", "Football (P4)": exactly one known sport inside a phrase.
  const hits = [...SPORT_CANON].filter((c) => new RegExp('\\b' + c.replace(/ /g, '\\s+') + '\\b').test(k));
  if (hits.length === 1) return hits[0];
  const ab = Object.keys(SPORT_ABBR).filter((a) => /^[a-z&]+$/.test(a) && new RegExp('\\b' + a.replace(/[&]/g, '\\$&') + '\\b').test(k));
  if (ab.length === 1) return SPORT_ABBR[ab[0]];
  return null;
}
// What the model is told to say: the canonical name, or the stored value
// itself when we do not recognise it (so an unusual sport still reaches the
// model as typed rather than being dropped).
function sportLabel(s) {
  const raw = String(s || '').trim();
  const k = sportKey(s);
  if (!k) return raw || null;
  // A stored value that already IS the sport, however capitalised
  // ("Football", "Women's Soccer"), reaches the model as typed; only an
  // abbreviation or a variant ("MBB", "hockey", "T&F") is expanded.
  const bare = _words(raw).replace(/[\u2019']/g, '').replace(/^(mens|womens|men|women|boys|girls)\s+/, '').trim();
  return bare === k ? raw : k;
}
function _sportRule(a) {
  const label = sportLabel(a.sport);
  if (!label) return a.sport ? '' : ' (no sport on file: do not name one)';
  return ` (sport: say "${label}" or nothing; do not rename or abbreviate it)`;
}
// The class year the model may name, or told there is none. A pro never has
// one and the pro block says so on its own line.
function _yearRule(a) {
  if (a.athleteType === 'pro') return '';
  if (a.year) return ` (class year: say "${String(a.year).trim()}" or nothing)`;
  return ' (no class year on file: do not call them a freshman, sophomore, junior, senior or graduate)';
}

// Sport-specific WORD overrides: in football a "guard" or a "tackle" is a
// lineman, not a basketball guard; in soccer a "forward" and a "striker" are
// the same job to a business owner.
const _WORD_BY_SPORT = {
  football: { guard: 'offensive lineman', tackle: 'offensive lineman', 'offensive guard': 'offensive lineman' },
  soccer: { striker: 'forward', 'centre forward': 'forward', 'center forward': 'forward', fullback: 'defender', 'full back': 'defender' },
};

// The group name for a position however it is written, or null if we do not
// recognise it -- in which case the caller falls back to comparing the strings,
// so an unusual stored value still works rather than matching nothing.
// `sport` picks the abbreviation table; without one, only abbreviations that
// mean the same thing everywhere resolve.
function positionKey(s, sport) {
  const t = _words(s).replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const fam = sportFamily(sport);
  const abbr = fam && POSITION_ABBR[fam] ? POSITION_ABBR[fam] : null;
  const wordOverride = fam && _WORD_BY_SPORT[fam] ? _WORD_BY_SPORT[fam] : {};
  // THE SPORT'S TABLE OUTRANKS THE WORD TABLE: "RB" is a running back in the
  // word table and a right back in soccer, and the sport decides.
  const lookup = (tok) => {
    if (!tok) return null;
    if (wordOverride[tok]) return wordOverride[tok];
    if (abbr && Object.prototype.hasOwnProperty.call(abbr, tok)) return abbr[tok] || null;
    if (_POS_KEY.has(tok)) return _POS_KEY.get(tok);
    if (!abbr && _ABBR_ANY.has(tok)) return _ABBR_ANY.get(tok);
    return null;
  };
  const whole = lookup(t);
  if (whole) return whole;
  // "WR/KR" -> the first job listed; "Jr WR" / "starting quarterback" -- try
  // each token and each pair, in order.
  const parts = t.split(/[ /]+/).filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i++) {
    const k2 = lookup(parts[i] + ' ' + parts[i + 1]);
    if (k2) return k2;
  }
  for (const p of parts) { const k = lookup(p); if (k) return k; }
  return null;
}

// What the athlete block SAYS the position is: the word, never the letters.
// A stored "CB" on a football player reads "cornerback"; "WR/KR" reads "wide
// receiver"; a value we cannot resolve is handed over exactly as stored, and
// the model is told to use it verbatim.
function positionLabel(s, sport) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  const key = positionKey(raw, sport);
  if (!key) return raw;
  // If the stored value already IS a word for that group, keep the agent's
  // wording; only a letter code is replaced.
  const t = _words(raw).replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (_POS_KEY.has(t) || /[a-z]{5,}/.test(t)) return raw;
  return key;
}

// ── A WORD THAT IS ALSO AN ORDINARY WORD ────────────────────────────────────
//
// The match has always been on a word boundary, so this was never a substring
// problem: "forward" in "looking forward to hearing from you" IS a whole token.
// It is a CONTEXT problem. Every one of these is both a position (or a sport, or
// a class year) and a perfectly ordinary thing to write to a local business:
//
//   "I am looking forward to hearing what you think"   -> forward
//   "your shop on the corner of Highland"              -> corner
//   "the community center down the road"               -> center
//   "nine years of food safety inspections"            -> safety
//   "your bowling alley"  "your golf shop"             -> bowling, golf
//   "Junior's Diner"  "your senior discount"           -> junior, senior
//
// A pitch to a bowling alley would have been refused for the word "bowling".
const SOFT_WORDS = new Set([
  'forward', 'center', 'guard', 'safety', 'corner', 'keeper', 'pitcher', 'kicker',
  'lineman', 'receiver', 'setter', 'defender', 'striker', 'thrower', 'jumper',
  'track', 'bowling', 'golf', 'diving', 'rowing', 'tennis', 'hockey',
  'junior', 'senior', 'redshirt',
]);

// Split into sentences so a claim can be attributed to the thing it is about.
function _sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

// ── WHICH SENTENCES ARE ABOUT THE ATHLETE ───────────────────────────────────
//
// The check exists to catch the model asserting a FACT ABOUT THE ATHLETE. In the
// prescribed voice every such sentence names them or refers back to them; the
// rest of the pitch is about the business and the ask. A sentence that mentions
// neither is not a claim about the athlete and is not this check's business.
function _athleteScoped(text, athlete) {
  const name = String((athlete && athlete.name) || '').trim();
  const first = name.split(/\s+/)[0] || '';
  const named = new RegExp('\\b(' + [name, first].filter((x) => x.length > 1)
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
  const out = [];
  let seenName = false;
  for (const s of _sentencesOf(text)) {
    const hasName = !!name && named.test(s);
    if (hasName) seenName = true;
    // A third-person reference AFTER the athlete has been named is still about
    // them -- "She already has several NIL partnerships" is the voice's own
    // second line and names nobody. "I" and "you" are the agent and the
    // business, and never scope a claim to the athlete.
    const refersBack = seenName && /\b(he|she|they|his|her|their|him|them)\b/i.test(s);
    if (hasName || refersBack || !name) out.push(s);
  }
  return out;
}

// Does the term sit where a claim about a person actually sits? Used only for
// SOFT_WORDS, so an unambiguous position still matches anywhere in an
// athlete sentence and an invented one is still caught.
const _FRAME_BEFORE = /(?:,|\b(?:a|an|the|is|as|was|plays|playing|played|starting|backup|starter|star|standout|his|her|their))\s+(?:[a-z-]+\s+){0,2}$/i;
// "on the Auburn football team", "for the Tigers", end of clause -- and "at
// Auburn", but only when what follows is a PROPER NOUN. "a senior at Auburn" is
// a class-year claim; "trains at the community center at 6am" is not, and the
// capital is what separates a school or a team from a time and a place.
const _FRAME_AFTER = /^(?:\s*[,.;:]|\s+(?:on|for|who|and|with)\b|\s+(?:at|in)\s+(?:the\s+)?[A-Z]|\s*$)/;

function _framed(sentence, word) {
  const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'ig');
  let m;
  while ((m = re.exec(sentence))) {
    const before = sentence.slice(0, m.index);
    const after = sentence.slice(m.index + m[0].length);
    if (_FRAME_BEFORE.test(before) && _FRAME_AFTER.test(after)) return true;
  }
  return false;
}

// Longest-first so "wide receiver" is matched before "receiver".
//
// `athlete` scopes the search to the sentences that are about them; passing none
// searches the whole text, which is what the non-athlete callers want.
function _findVocab(text, vocab, athlete) {
  const scope = athlete === undefined ? [String(text || '')] : _athleteScoped(text, athlete);
  const hits = [];
  for (const w of vocab.slice().sort((a, b) => b.length - a.length)) {
    const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    const found = scope.some((s) => re.test(s)
      // An ordinary English word needs to sit in a claim frame as well as in an
      // athlete sentence. Both gates, because either alone still misfires:
      // "Amari trains at the community center" is athlete-scoped, and "on the
      // corner for nine years" is framed.
      && (!SOFT_WORDS.has(w) || _framed(s, w)));
    if (found && !hits.some((h) => h.includes(w))) hits.push(w);
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
  // Scoped to the sentences about the athlete, and compared BY GROUP so that
  // "wide receiver" and a stored "WR" are the same position. Falls back to the
  // string comparison when we do not recognise the stored value, so an unusual
  // one still matches itself.
  const storedPos = _words(a.position);
  const storedPosKey = positionKey(a.position, a.sport);
  for (const hit of _findVocab(t, POSITION_WORDS, a)) {
    if (!storedPos) { problems.push(`claims a position ("${hit}") and we hold none`); break; }
    const hitKey = positionKey(hit, a.sport);
    const same = storedPosKey && hitKey
      ? storedPosKey === hitKey
      : (storedPos.includes(hit) || hit.includes(storedPos));
    if (!same) {
      problems.push(`says "${hit}" but the stored position is "${a.position}"`); break;
    }
  }
  // ── sport ─────────────────────────────────────────────────────────────────
  // Compared BY SPORT, so "basketball" and a stored "MBB" are the same, and
  // "hockey" and a stored "Ice Hockey" are the same. Falls back to the string
  // comparison when we do not recognise the stored value.
  const storedSport = _words(a.sport);
  const storedSportKey = sportKey(a.sport);
  for (const hit of _findVocab(t, SPORT_WORDS, a)) {
    if (!storedSport) { problems.push(`names a sport ("${hit}") and we hold none`); break; }
    const hitKey = sportKey(hit);
    const same = storedSportKey && hitKey
      ? storedSportKey === hitKey
      : (storedSport.includes(hit) || hit.includes(storedSport));
    if (!same) {
      problems.push(`says "${hit}" but the stored sport is "${a.sport}"`); break;
    }
  }
  // ── class year (college only) ─────────────────────────────────────────────
  // A pro has no class year, and the college framing itself is the fabrication
  // to catch on a pro: a message calling a 29-year-old on the Broncos a
  // "student-athlete" reaches a real business under the agent's name.
  const isPro = a.athleteType === 'pro';
  if (isPro) {
    // Class-year words are looked for the same scoped way as for a college
    // athlete (so "Junior's Pizza" in the business name is not a hit), and
    // any hit at all is the problem.
    const yr = _findVocab(t, YEAR_WORDS, a)[0];
    if (yr) problems.push(`calls them a "${yr}" and this athlete is a pro`);
    const cm = t.match(/\b(?:college athlete|student[- ]athletes?|NCAA|on campus|NIL)\b/);
    if (cm) problems.push(`uses college wording ("${cm[0]}") and this athlete is a pro`);
  } else {
    const storedYear = _words(a.year);
    for (const hit of _findVocab(t, YEAR_WORDS, a)) {
      if (!storedYear) { problems.push(`calls them a "${hit}" and we hold no class year`); break; }
      if (!storedYear.includes(hit) && !hit.includes(storedYear)) {
        problems.push(`says "${hit}" but the stored year is "${a.year}"`); break;
      }
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
  // THE MESSAGE OPENS WITH THE PERSON'S FIRST NAME, ALWAYS. A business with no
  // named person never reaches the writer any more (the queue refuses the
  // card), so "Open with 'Hi,'" is no longer an instruction this prompt gives:
  // a draft that opens "Hi," is rejected by lintMessage below and rewritten.
  if (b.greetFirstName) {
    L.push('OPEN THE MESSAGE WITH: "Hi ' + b.greetFirstName + ',"  — this name is verified, use it. '
      + 'Never open "Hi," or "Hi there," or any greeting without the name.');
  } else if (b.ownerName) {
    const fn = firstNameOf(b.ownerName);
    L.push('OPEN THE MESSAGE WITH: "Hi ' + fn + '," — the person to write to. Never open with a greeting that has no name.');
  }
  if (b.siteSummary) L.push('What their own website says: ' + b.siteSummary);
  if (b.sponsorsLocal) L.push('They already sponsor local teams or events.');
  if (b.isFranchise || b.corporate) L.push('Part of a chain, so the local operator may not control the budget.');
  if (b.recentlyOpened) L.push('Recently opened or expanded.');
  if (b.notes) L.push('Other: ' + b.notes);
  return L.join('\n');
}

// The position the model may name, spelled out once. The block used to hand
// over the stored letters ("CB") and the model wrote the word; the check then
// refused the word. Now the block hands over the word, and says so.
function _positionRule(a) {
  const label = positionLabel(a.position, a.sport);
  // positionLabel returns the stored value itself when it is not one we
  // recognise, so a stored position is always named here, expanded or not.
  if (label) return ` (position: say "${label}" or nothing; do not rename or abbreviate it)`;
  // NOTHING ON FILE. This was silent, and the model filled the gap: nineteen
  // pitches in one night named a position for an athlete whose record holds
  // none, and every one was refused and rewritten. Now it is told.
  return ' (no position on file: do not name, guess or imply one)';
}

function describeAthlete(a) {
  const L = [];
  const isPro = a.athleteType === 'pro';
  L.push('Name: ' + (a.name || 'the athlete'));
  if (isPro) {
    // ── THE PRO VARIANT: name, position, team, and what they are known for ──
    // No class year and no school, ever: a year left over on the record from
    // college must not reach the model, and there is no campus to name.
    L.push('This athlete is a PROFESSIONAL, not a college athlete. Never call them a '
      + 'student-athlete, never mention college, NCAA, a class year or NIL.');
    const bits = [positionLabel(a.position, a.sport), sportLabel(a.sport)].filter(Boolean).join(' ');
    if (bits) L.push('Plays: ' + bits + (a.team ? ' for the ' + a.team : '') + _positionRule(a) + _sportRule(a));
    else if (a.team) L.push('Team: ' + a.team + _positionRule(a));
    if (a.city) L.push('Based in: ' + a.city);
    // "Known for" is what the agent typed into stats or notes. It is offered as
    // the hook, and only what is listed may be said -- the model is not asked to
    // recall anything about a public figure from memory.
    const known = [a.stats, a.knownFor].filter(Boolean).join('; ');
    if (known) L.push('Known for: ' + known + ' (use this, and nothing you remember about them)');
    else L.push('Known for: nothing on file. Do not draw on what you may remember about this player; pitch on position, team and what they post.');
  } else {
    const bits = [a.year, positionLabel(a.position, a.sport), sportLabel(a.sport)].filter(Boolean).join(' ');
    if (bits) L.push('Plays: ' + bits + (a.school ? ' at ' + a.school : '') + _positionRule(a) + _sportRule(a) + _yearRule(a));
    else if (a.school) L.push('School: ' + a.school + _positionRule(a) + _sportRule(a) + _yearRule(a));
    else L.push('Plays: nothing on file' + _positionRule(a) + _sportRule(a) + _yearRule(a));
  }
  // ── A BLANK FIELD IS SAID TO BE BLANK ────────────────────────────────────
  // The fact-check refuses a hometown, a position, a sport or a class year we
  // do not hold, and a model that is simply not told about a field fills it
  // in. Every one of those refusals was a retry, and most retries were this.
  // So each blank is named as blank, in the block itself, with the one
  // instruction that matters: do not mention it.
  if (a.hometown) L.push('From: ' + a.hometown);
  else L.push('From: not on file. Do not say where they are from, grew up or call them a native of anywhere.');
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
  if (a.stats && !isPro) L.push('On the field: ' + a.stats);
  // ── WHAT MAY BE SAID ABOUT EXISTING PARTNERSHIPS ─────────────────────────
  // "already has several NIL partnerships and is looking to expand" is the line
  // agents asked for, and it is a CLAIM about a real athlete made to a real
  // business. So it is only offered when we hold deals to back it. With none on
  // file the athlete is still worth pitching and the honest version still sells
  // forward motion -- it just does not assert a track record that does not exist.
  // A pro has endorsement partnerships, not NIL ones: NIL is the college term.
  const kind = isPro ? 'endorsement' : 'NIL';
  const deals = Number(a.partnershipCount) || 0;
  if (deals >= 2) {
    L.push(`Existing partnerships: SAY EXACTLY "already has several ${kind} partnerships `
      + 'and is looking to expand". We hold ' + deals + ' on file.');
  } else if (deals === 1) {
    L.push(`Existing partnerships: SAY EXACTLY "already has an ${kind} partnership and is `
      + 'looking to expand". We hold 1 on file. Do not say "several".');
  } else {
    L.push(`Existing partnerships: NONE on file. Say "is building out their ${kind} `
      + 'partnerships for this year" or similar. Do NOT claim they already have any.');
  }
  if (Array.isArray(a.tags) && a.tags.length) L.push('Posts about: ' + a.tags.join(', '));
  // The content line. Concrete and schedule-free: what they post, not when.
  if (a.contentThemes) L.push('Content they make: ' + a.contentThemes);
  if (a.instagramHandle) {
    L.push('Instagram link, to go on its own line at the end of the message: '
      + 'https://instagram.com/' + String(a.instagramHandle).replace(/^@+/, ''));
  }
  if (a.productWants) L.push('Wants to work with: ' + a.productWants);
  if (a.notes) L.push('Notes: ' + a.notes);
  return L.join('\n');
}

// The college prompt is a HEAD (who the athlete is, the shape of the message)
// plus SHARED_RULES (everything that is true of any message that leaves under
// the agent's name). The pro prompt below swaps the head and keeps the rules,
// so a rule added once applies to both.
const SYSTEM_COLLEGE_HEAD = `You write short outreach messages for a sports agent pitching local businesses on partnering with a college athlete.

You are not a copywriter and you are not a chatbot. You are a sales manager who did the homework and respects the reader's time. The person reading has a business to run and thirty seconds.

Before writing anything, decide the ANGLE: the one real connection between what this specific athlete uniquely offers and what this specific business actually needs. If there is no real connection, say so and write nothing. A weak pitch costs more than no pitch, because this business only gives one first impression.

── THE SHAPE OF THE MESSAGE ──────────────────────────────────────────────────

This structure comes from agents who send these for a living. Follow it in order.

1. OPEN BY NAMING THE ATHLETE, not yourself and not the business:
   "I wanted to call your attention to [athlete], [position] on the [team]."
2. ONE LINE ON WHERE THEY ARE: the ATHLETE block tells you exactly what may be
   said about their existing partnerships. Use its wording. Do not upgrade it.
3. ONE LINE ON WHAT THEY POST: training, game days, day in the life, whatever
   the ATHLETE block actually lists. This is what a business is buying.
4. THE CLOSE, as a question:
   "Would you like to learn more about this NIL opportunity with [athlete]?"
   When the prompt says a scheduling link is present, the close may point at it:
   "...or use my scheduling link below to set up a call." Only say that when you
   are told there is one. Referring a business to a link that is not there is
   worse than not offering a call at all.
5. The athlete's Instagram link on its own line, when one is given.
`;

const SHARED_RULES = `DO NOT WRITE ABOUT THE BRAND. Not what they do, not how long they have been
there, not how well reviewed they are, not why they would be a good fit. They
know their own business better than we do and every sentence spent describing it
back to them is a sentence that says we are padding. The business details in
this prompt are for YOUR judgement about whether to pitch at all, and for the
angle field. They are not material for the message.

SELL THE POTENTIAL, NOT A PACKAGE. Do not offer "a small number of posts" or
enumerate a deliverable. This is a first message; the point is to open a
conversation about what this athlete could do for them, not to hand them a
menu they can decline in one word.

DO NOT REFERENCE THE SEASON, practice, game week, or any date. We do not hold
this athlete's schedule and it is wrong more often than it is right.

HARD RULES FOR THE MESSAGE:
- Four to five sentences, plus the link line. Never longer.
- No em dashes. No exclamation marks.
- Never open with "I hope this finds you well", "I wanted to reach out", or "my name is".
- No corporate words. Nothing leverages, nothing is seamless, nobody circles back, nothing is a game-changer.
- Use contractions. Write how a person talks.
- NEVER put a dollar amount, a rate, a fee or a budget in the message. Not a range, not "starting at", not "around". Money comes up after they reply, and the agent handles it from there. A number in a cold message turns a conversation into a negotiation before there is anything to negotiate about.
- Sign off with the agent's first name on its own line.
- DO NOT WRITE A SIGNATURE, a title, a company, a phone number or any link other
  than the athlete's Instagram. The agent's signature block is appended after you,
  exactly as they typed it. Anything you invent there is a second signature on the
  same email.
- THE GREETING IS DICTATED, NOT CHOSEN. THE BUSINESS block above tells you exactly
  what to open with. Follow it literally. A name you were not given is a name you
  invented, and it reaches a real business under the agent's own name.

NEVER invent a fact about the athlete. Use only what is listed under THE ATHLETE. If no hometown is listed, do not name one. If no position is listed, do not name one. If no follower count is listed, do not cite one. A missing field is not a gap to fill, and a plausible guess is still a lie told to a real business under this athlete's name.
A LINE THAT SAYS "not on file" IS AN INSTRUCTION, NOT A GAP. Never mention that field at all: not a guess, not a hedge ("wherever they're from"), not a general version of it ("a talented athlete" for a missing sport is fine; "a talented ballplayer" is not). The message must read as if the field does not exist.

The message must be answerable yes or no without a follow-up question.`;

const SYSTEM = SYSTEM_COLLEGE_HEAD + '\n' + SHARED_RULES;

// ── THE PRO VARIANT ──────────────────────────────────────────────────────────
// A college pitch introduces someone the business has never heard of. A pro
// pitch often does not: a minor leaguer in Toledo is not a stranger to a
// Toledo bar, the team is on the wall. So the pro message is a first approach
// rather than an introduction -- who he plays for, what he is known for, and
// ONE shape the partnership could take -- and it never says NIL, never names
// a class year, never calls him a student-athlete. The hard rules below the
// head are the college prompt's, verbatim, because they are about the agent's
// name on a message and not about who the athlete is.
const SYSTEM_PRO_HEAD = `You write short outreach messages for a sports agent proposing a partnership between a professional athlete and a local business. Never describe them as a college athlete, a student-athlete, or by a class year, and never say NIL: this is an endorsement.

You are not a copywriter and you are not a chatbot. You are a sales manager who did the homework and respects the reader's time. The person reading has a business to run and thirty seconds.

The business may already know the team. This is not an introduction; it is a first approach. It says who he plays for, what he is known for, and what a partnership could look like, and it asks one question.

Before writing anything, decide the ANGLE: the one real connection between what this specific athlete uniquely offers and what this specific business actually needs. If there is no real connection, say so and write nothing. A weak pitch costs more than no pitch, because this business only gives one first impression.

── THE SHAPE OF THE MESSAGE ──────────────────────────────────────────────────

Follow it in order.

1. OPEN WITH THE TEAM AND THE ROLE, stated as a fact the reader may already
   hold, not as an introduction:
   "[athlete], [position] for the [team], is looking at partners in [city] this season."
   The team and the city are the ones in the ATHLETE block. If no city is
   listed, say "locally".
2. ONE LINE ON WHAT THEY ARE KNOWN FOR, from the ATHLETE block's "Known for"
   line only. If it says nothing is on file, leave this line out. Do not fill it
   from anything you remember about this player.
3. ONE LINE ON WHERE THEY ARE: the ATHLETE block tells you exactly what may be
   said about their existing partnerships. Use its wording. Do not upgrade it.
4. THE PROPOSAL, IN ONE SHAPE. One sentence saying what the partnership could
   look like for this business, as a first approach and not a contract: a post
   from the ballpark, or a night where the team's following meets their door.
   Pick the ONE that fits this business. Not a list, not a package, no counts,
   no schedule, no price. Where the prompt gives a fitting ask for this category,
   let it shape the sentence.
5. THE CLOSE, as a question:
   "Would you like to learn more about this endorsement opportunity with [athlete]?"
   When the prompt says a scheduling link is present, the close may point at it:
   "...or use my scheduling link below to set up a call." Only say that when you
   are told there is one. Referring a business to a link that is not there is
   worse than not offering a call at all.
6. The athlete's Instagram link on its own line, when one is given.
`;

const SYSTEM_PRO = SYSTEM_PRO_HEAD + '\n' + SHARED_RULES;

function systemFor(athlete) {
  return athlete && athlete.athleteType === 'pro' ? SYSTEM_PRO : SYSTEM;
}

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
${ctx.hasSchedulingLink
    ? 'The agent HAS a scheduling link, and it is appended below your message. You may '
      + 'invite them to use it: "use my scheduling link below to set up a call".'
    : 'The agent has NO scheduling link. Do not mention one, and do not refer to anything "below".'}
The channel: ${ctx.channel === 'email' ? 'email' : 'an Instagram DM'}

Return ONLY JSON, in exactly this order:
{
  "angle": "one sentence naming the real connection between THIS athlete and THIS business",
  "angleKey": "two-to-four word slug for the angle, lowercase, hyphenated",
  "ask": "what you would propose if they reply — for the agent's card, NOT for the message itself",
  "confidence": "strong" | "thin",
  "message": "the message itself, four to five sentences in the prescribed order, the Instagram link on its own line, signed off"
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
  // The greeting is linted like the sign-off: the first line must be
  // "Hi <first name>," for the person the card is to. A draft that opens
  // "Hi," is rejected and rewritten once, then refused.
  const _biz = ctx.business || {};
  const greetFirstName = _biz.greetFirstName || (_biz.ownerName ? firstNameOf(_biz.ownerName) : null) || null;
  const lintOpts = { signOff: agentFirst, requireDeliverable: opts.requireDeliverable === true, greetFirstName };

  const attempt = async (extra) => {
    const raw = await oneShot(buildPrompt(ctx) + (extra || ''), systemFor(ctx.athlete), 900, opts.model);
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
  // RECORDED, so "how often does the retry fire" is a count and not a guess.
  // A retry is a second model call on the writer's model; the ledger shows it
  // as a repeat, the run row carries it on the attempt, and this line says why.
  let retried = false, firstProblems = null;
  if (!lint.ok) {
    retried = true; firstProblems = lint.problems.slice();
    console.log(`[writer] retry for ${(ctx.business && ctx.business.name) || 'business'}: ${lint.problems.join('; ')}`);
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
    return { skipped: true, reason: 'could not write it in voice: ' + lint.problems.join('; '), lintFailed: true,
      retried, firstProblems };
  }
  if (!facts.ok && (facts = factsOf(message)) && !facts.ok) {
    return { skipped: true, reason: 'invented a fact about the athlete: ' + facts.problems.join('; '), factsFailed: true,
      retried, firstProblems };
  }

  const play = playbookFor(ctx.business && ctx.business.category);
  return {
    skipped: false,
    retried, firstProblems,
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
  DELIVERABLE_RE, DELIVERABLE_NOUNS, DELIVERABLE_VERBS, SYSTEM, SYSTEM_PRO, systemFor, MIN_SAMPLE,
  POSITION_WORDS, SPORT_WORDS, YEAR_WORDS,
  positionKey, sportKey, sportLabel, SPORT_ABBR, positionLabel, sportFamily, POSITION_GROUPS, POSITION_ABBR, SOFT_WORDS,
};
