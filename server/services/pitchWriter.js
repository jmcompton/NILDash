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

// A concrete ask names something countable that gets made or done. This replaced
// "must contain a digit": with prices banned, requiring a digit would push the
// writer back toward the one number it is not allowed to use.
const DELIVERABLE_RE = new RegExp(
  '\\b(a|an|one|two|three|four|five|six|couple of|\\d+)\\s+(short |quick |feed |in-store |game[- ]day )?'
  + '(post|posts|story|stories|reel|reels|video|videos|appearance|appearances|visit|visits|'
  + 'session|sessions|shoutout|shoutouts|mention|mentions|photo|photos|takeover|takeovers|'
  + 'signing|signings|clinic|clinics|drop-?in|meet[- ]and[- ]greet)\\b', 'i');

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
    problems.push('no named deliverable, so the ask is not concrete (say what gets posted or done)');
  }
  // The sign-off has to be the agent's own first name.
  if (opts.signOff && !new RegExp('\\b' + opts.signOff.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t)) {
    problems.push('does not sign off as ' + opts.signOff);
  }
  return { ok: problems.length === 0, problems };
}

// Repairs that cannot change meaning. Anything that WOULD change meaning is left
// for the retry: silently rewriting a sentence to pass a lint is how a checker
// starts certifying its own edits.
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
  if (b.ownerName) L.push('Person to write to: ' + b.ownerName + (b.ownerTitle ? ', ' + b.ownerTitle : ''));
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
    L.push('Following: ' + parts.join(', ') + ' (' + (ig + tt).toLocaleString() + ' combined)');
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

  let message = autoRepair(j.message);
  let lint = lintMessage(message, lintOpts);
  if (!lint.ok) {
    // ONE retry, told exactly what was wrong. Asking again unchanged just spends
    // a second call on the same mistake.
    const j2 = await attempt(`\n\nYour previous attempt was rejected for: ${lint.problems.join('; ')}. `
      + `Rewrite the message fixing every one of those. Keep the same angle and the same ask.`);
    if (j2 && j2.skip) return { skipped: true, reason: String(j2.reason || 'no real connection').trim() };
    if (j2 && j2.message) {
      const m2 = autoRepair(j2.message);
      const l2 = lintMessage(m2, lintOpts);
      if (l2.ok) { j = j2; message = m2; lint = l2; }
    }
  }
  if (!lint.ok) {
    // Twice rejected. NOT sent as-is: a message that breaks the voice rules is
    // the failure this rewrite exists to remove.
    return { skipped: true, reason: 'could not write it in voice: ' + lint.problems.join('; '), lintFailed: true };
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
  writePitch, lintMessage, autoRepair, containsPrice, playbookFor, describeBusiness, describeAthlete,
  buildPrompt, sentenceCount, stripSignOff, learnedAngles,
  CATEGORY_PLAYBOOK, DEFAULT_PLAY, BANNED_OPENERS, CORPORATE_FILLER, PRICE_PATTERNS,
  DELIVERABLE_RE, SYSTEM, MIN_SAMPLE,
};
