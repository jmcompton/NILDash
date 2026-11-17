'use strict';
// ── THE ATHLETICS DEPARTMENT'S VOICE ────────────────────────────────────────
//
// The second writer. The agent's writer (services/draftPrewarm, the nightly
// queue) is an agent pitching one athlete to a business. This one is an
// athletics department asking a local business to sponsor a TEAM:
//
//   the money goes to the program     a sponsorship of the team, not a deal
//                                     with a person. No NIL language.
//   no student athlete is named       nor described so as to be identified.
//                                     The facts it is given hold no names, so
//                                     any name in the draft was invented, and
//                                     the lint refuses it.
//   the ask names one inventory item  exactly as the department sells it,
//     and its price                   with its price, both checked in the text.
//
// Same model as the agent writer: claude-sonnet-4-6, named here so a change to
// ai.oneShot's default cannot move it. The agent writer is not touched.
//
// The greeting and the sign-off are composed here, not by the model: the
// department has no contact name for a business Places found, and a model
// asked to greet someone invents one.

const MODEL = 'claude-sonnet-4-6';
// THE REVIEWER (2026-11-16). Every nightly card (a team deal or a brand
// program) is read by a second model before it can reach a school, against
// the rules below, and a draft it fails is rewritten once with its reasons
// or dropped. Haiku: it judges a short email against a checklist.
const REVIEW_MODEL = 'claude-haiku-4-5-20251001';
const REVIEW_TIMEOUT_MS = 30000;
const DRAFT_TIMEOUT_MS = 45000;
const MAX_WORDS = 170;

const SYSTEM = 'You write short sponsorship asks from a college athletics department to a local business. '
  + 'You write like a person at the department who knows the town and has looked at this business. '
  + 'The sponsorship supports the team and the program. You never name, quote, describe or single out any '
  + 'student athlete, and you never mention NIL. You make exactly one ask: the inventory item you are given, '
  + 'at the price you are given. No filler, no flattery, no sentence that would be true of any other business.';

// The pitches (no item, no price) have their own: the athlete pitch may use
// NIL, about the one athlete the staff member named, and nobody else.
const SYSTEM_PITCH = 'You write short, plain emails from a college athletic department\'s NIL office to a local business near campus. '
  + 'You write like a person at the department who knows the town and has looked at this business. '
  + 'You never name or describe any student athlete except one you are explicitly given, and you never invent a fact. '
  + 'No filler, no flattery, no sentence that would be true of any other business.';

// ── THE TEAM DEAL (2026-11-16) ──────────────────────────────────────────────
// The nightly local card used to ask a business to "support the program" for
// the season: sponsorship, the media rights partner's job, and nothing a
// school buys NILDash for. It is now an NIL deal that pays the players for
// real work (an appearance, posts).
//
// THE SCHOOL SETS THE PRICE, NOT NILDASH. A team's rate is set by the office
// on My Teams (university_teams.nil_rate_cents and nil_rate_what, "10 players:
// a two-hour appearance and one Instagram post each"). With a rate, the pitch
// quotes it once, exactly. Without one, the pitch still offers a paid NIL deal
// and says the office will send options with prices; it names no number.
function rateFor(team) {
  const cents = Number(team && team.nil_rate_cents) || 0;
  if (cents <= 0) return null;
  const what = String((team && team.nil_rate_what) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return { priceCents: cents, what: what || `players from the ${(team && team.name) || 'team'}: an appearance at the business and posts on their own accounts` };
}
// The call card's ask, the same deal in a sentence.
function dealAsk(team, business) {
  const r = rateFor(team);
  return r
    ? `would ${business} pay for ${r.what}, at ${money(r.priceCents)} paid to the players? It is set up and paid through our NIL marketplace. If yes, set a 15-minute call; if this is not the right person, ask who decides on marketing.`
    : `would ${business} pay players on the ${team.name} team for an appearance or a few posts? We send options with prices, and it is set up and paid through our NIL marketplace. If yes, set a 15-minute call; if this is not the right person, ask who decides on marketing.`;
}

function money(cents) {
  const d = Math.round(Number(cents) || 0) / 100;
  return '$' + d.toLocaleString('en-US', { minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function milesFrom(m) {
  if (m == null || !Number.isFinite(Number(m))) return null;
  const mi = Number(m) / 1609.34;
  return mi < 0.95 ? 'under a mile' : `about ${Math.round(mi * 10) / 10} miles`;
}

// THREE KINDS OF MESSAGE (ctx.item / ctx.athlete):
//   ask           an inventory item at its price (the original, ctx.item)
//   team pitch    no item, no price: would they back the team as a local
//                 partner; ask for a short call. The Cypress product's nightly
//                 card -- pricing packages are not part of it.
//   athlete pitch on demand, a staff member pitching ONE athlete they chose
//                 (ctx.athlete: the name and facts THEY typed). The department
//                 facilitates NIL for its athletes, so NIL language is allowed
//                 here and only here; no other person may be named.
//   program       the social rung (campusNightly): a brand that runs an
//                 athlete program (the social index), asked to partner with
//                 the TEAM. Its program is about athletes, so the words
//                 ambassador and NIL may appear; no athlete is ever named.
function kindOf(ctx) { return ctx.athlete ? 'athlete' : ctx.item ? 'ask' : ctx.program ? 'program' : 'pitch'; }

// The facts the model sees. Deliberately small, and nothing about any person.
function facts({ university, team, business, item, athlete, program }) {
  const lines = [
    `DEPARTMENT: ${university.name} Athletics`,
    `TEAM: ${team.name}${team.sport ? ` (${team.sport})` : ''}${team.season ? `, ${team.season} season` : ''}`,
    team.venue ? `HOME VENUE: ${team.venue}` : null,
    team.home_dates ? `HOME DATES THIS SEASON: ${team.home_dates}` : null,
    team.roster_size ? `ROSTER SIZE: ${team.roster_size}` : null,
    `BUSINESS: ${business.brand_name}`,
    // Google's own description when there is one ("Physical therapist"), so
    // the ask never calls a racetrack "your restaurant" because a restaurant
    // search is what found it.
    (business.kindLabel || business.category) ? `KIND OF BUSINESS: ${business.kindLabel || business.category}` : null,
    business.address ? `ADDRESS: ${business.address}` : null,
    milesFrom(business.distance_m) ? `DISTANCE FROM CAMPUS: ${milesFrom(business.distance_m)}` : null,
    business.rating ? `GOOGLE RATING: ${business.rating} from ${business.user_ratings_total || 'some'} reviews` : null,
    business.evidence ? `WHAT WE KNOW THEY DO LOCALLY: ${business.evidence}` : null,
    item ? `THE ASK: ${item.name}, ${money(item.price_cents)}` : null,
    athlete ? `ATHLETE (the only person you may name): ${athlete.name}${athlete.facts ? ` -- ${athlete.facts}` : ''}` : null,
    program && program.offer ? `THEIR ATHLETE PROGRAM: ${program.offer}` : null,
    program && program.url ? `PROGRAM PAGE: ${program.url}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

function buildPrompt(ctx, retryBecause) {
  const kind = kindOf(ctx);
  if (kind !== 'ask') return buildPitchPrompt(ctx, kind, retryBecause);
  return `${facts(ctx)}

Write the email body and a subject line.
- 70 to 140 words. Plain sentences, no bullet points, no headings.
- Do NOT write a greeting or a sign-off; they are added for you.
- Say why this business and this team fit, from the facts above only. A real reason is one of: they are close to campus; home games bring students and families past them; or what they do serves players and the people who watch them (training, recovery, health, getting to games, banking for students).
- Never build the reason on a coincidence: a shared word, a name, a theme, a mascot, a colour or a pun. A pirate-themed restaurant is not a fit for basketball because of pirates, and a business called Eagle is not a fit for a team called the Eagles. If the only true reasons are that they are nearby and games bring people past them, say that plainly and stop.
- The sponsorship money goes to the ${ctx.team.name} program. Say what it supports in general terms (the season, travel, equipment), never a person.
- Never name or describe any student athlete, coach or staff member. Never invent a fact that is not above.
- Never use the words NIL, endorsement or influencer.
- Make exactly one ask, naming the item exactly as "${ctx.item.name}" and the price exactly as "${money(ctx.item.price_cents)}".
- End with one short line asking for a reply or a call.
${retryBecause ? `\nYour last draft was rejected: ${retryBecause}. Fix that.\n` : ''}
Output exactly:
SUBJECT: <subject line>
BODY:
<body>`;
}

// A DM (ctx.dm): the same message, short enough for Instagram.
function dmRules(ctx) {
  return ctx.dm ? `- THIS IS AN INSTAGRAM DIRECT MESSAGE, not an email: 30 to 70 words, two or three short sentences, no subject needed (write SUBJECT: DM).\n` : '';
}
function buildPitchPrompt(ctx, kind, retryBecause) {
  const common = `- Do NOT write a greeting or a sign-off; they are added for you.
- Say why this business, from the facts above only. A real reason is one of: they are close to campus; home games bring students and families past them; or what they do serves players and the people who watch them (training, recovery, health, food after games, banking for students).
- Never build the reason on a coincidence: a shared word, a name, a theme, a mascot, a colour or a pun. If the only true reasons are that they are nearby and games bring people past them, say that plainly and stop.
- Never invent a fact that is not above. No prices, no dollar amounts.
- End with one short line asking for a short call or a reply.`;
  if (kind === 'program') {
    return `${facts(ctx)}

Write a short email from the athletic department to this brand, which runs an athlete program (above). Ask whether they would partner with the ${ctx.team.name} program as a team: for example, opening their program to the whole team at once, or backing the team's season. Say why this brand and this team, from the facts above only (what they make, who their program is for, the sport).
- Never name or describe any student athlete, coach or staff member.
- Never invent a fact that is not above: no follower counts, no results, no records.
${ctx.dm ? dmRules(ctx) : '- 60 to 130 words. Plain sentences, no bullet points, no headings.\n'}- Do NOT write a greeting or a sign-off; they are added for you.
- Never build the reason on a coincidence: a shared word, a name, a theme, a mascot, a colour or a pun.
- No prices, no dollar amounts.
- End with one short line asking for a short call or a reply.
${retryBecause ? `\nYour last draft was rejected: ${retryBecause}. Fix that.\n` : ''}
Output exactly:
SUBJECT: <subject line>
BODY:
<body>`;
  }
  if (kind === 'athlete') {
    return `${facts(ctx)}

Write a short email from the athletic department introducing ${ctx.athlete.name} for a name, image and likeness (NIL) partnership with this business: for example a few social posts or an appearance at the business. Use only the athlete facts above. Name no other person.
${ctx.dm ? dmRules(ctx) : '- 60 to 130 words. Plain sentences, no bullet points, no headings.\n'}${common}
${retryBecause ? `\nYour last draft was rejected: ${retryBecause}. Fix that.\n` : ''}
Output exactly:
SUBJECT: <subject line>
BODY:
<body>`;
  }
  const rate = rateFor(ctx.team);
  const price = rate ? money(rate.priceCents) : null;
  return `${facts(ctx)}${rate ? `
THE DEAL THE SCHOOL OFFERS: ${rate.what}
PRICE SET BY THE SCHOOL: ${price}, paid to the players` : `
PRICE: not set; the office sends options with prices when the business replies`}

Write a short email from the ${ctx.university.name} NIL office offering this business a paid NIL deal with players on the ${ctx.team.name} team${rate ? ': the deal above, at the price above' : ', such as an appearance at the business or a few posts on the players\' own accounts'}.
- This is an NIL deal: the business pays the players for real work (an appearance, posts). It is NOT a sponsorship, a donation, or support for the program, and it must never read like one. Never use the words sponsor, sponsorship, donate, donation or "support the program".
${rate ? `- Name the deal in plain words and state the price exactly as "${price}", once. No other dollar amounts.` : '- Name no price and no dollar amount. Say the office will send a few options with prices.'}
- Say in one short sentence that the deal is set up and paid through the school's NIL marketplace, so it is simple and handled properly.
- Never name or describe any individual student athlete, coach or staff member.
${ctx.dm ? dmRules(ctx) : '- 60 to 130 words. Plain sentences, no bullet points, no headings.\n'}- Do NOT write a greeting or a sign-off; they are added for you.
- Say why this business, from the facts above only. A real reason is one of: they are close to campus; home games bring students and families past them; or what they do serves players and the people who watch them (training, recovery, health, food after games, banking for students).
- Never build the reason on a coincidence: a shared word, a name, a theme, a mascot, a colour or a pun. If the only true reasons are that they are nearby and games bring people past them, say that plainly.
- Never invent a fact that is not above.
- End with one short line asking for a reply or a short call.
${retryBecause ? `\nYour last draft was rejected: ${retryBecause}. Fix that.\n` : ''}
Output exactly:
SUBJECT: <subject line>
BODY:
<body>`;
}

function parse(raw) {
  const s = String(raw || '').replace(/\r/g, '');
  const m = s.match(/SUBJECT:\s*(.+)\n+\s*BODY:\s*\n?([\s\S]+)/i);
  if (!m) return null;
  const subject = m[1].trim().replace(/^["']|["']$/g, '');
  const body = m[2].trim();
  if (!subject || !body) return null;
  return { subject, body };
}

const ROLE_THEN_NAME = /\b(guard|forward|center|point guard|captain|player|athlete|student-athlete|freshman|sophomore|junior|senior|coach|star|standout|setter|libero|hitter|pitcher|catcher|shortstop|outfielder|infielder|keeper|goalkeeper|striker|midfielder|defender|quarterback|receiver|sprinter|swimmer|golfer|runner|wrestler)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/;
const JERSEY = /(?:#|\bNo\.\s?)\d{1,2}\b/;
// REASONING FROM A COINCIDENCE. The Pirates Dinner Adventure ask argued the
// pirate theme was a natural match for basketball. The words that carry that
// kind of argument, refused in the text rather than trusted to the prompt.
const COINCIDENCE = /\b(theme[ds]?|mascot|namesake|pun)\b|\b(natural|perfect|fitting)\s+(fit|match|pairing|partner(ship)?)\b|\bshare[sd]?\s+(?:(?:a|the|our|your)\s+)?(?:same\s+)?(name|spirit|theme|colou?rs?|nickname)\b|\bjust\s+like\s+(our|the)\s+(team|players|program)\b/i;

// The rules the prompt states, checked in the text. Returns { ok } or { ok:false, why }.
function checkAsk(parsed, ctx) {
  const kind = kindOf(ctx);
  if (kind !== 'ask') return checkPitch(parsed, ctx, kind);
  const body = String(parsed.body || '');
  const text = parsed.subject + '\n' + body;
  const price = money(ctx.item.price_cents);
  if (!body.toLowerCase().includes(String(ctx.item.name).toLowerCase())) return { ok: false, why: `it does not name the item "${ctx.item.name}"` };
  if (!body.includes(price)) return { ok: false, why: `it does not state the price ${price}` };
  const otherPrice = (body.match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?!\d)/g) || []).find((p) => p.replace(/\s/g, '') !== price);
  if (otherPrice) return { ok: false, why: `it names a second price (${otherPrice}); make exactly one ask` };
  if (/\bNIL\b|\bendorse(ment|s)?\b|\binfluencer/i.test(text)) return { ok: false, why: 'it uses NIL, endorsement or influencer language' };
  if (ROLE_THEN_NAME.test(body) || JERSEY.test(body)) return { ok: false, why: 'it names or identifies a person on the team' };
  if (/^\s*(hi|hello|dear|hey)\b/i.test(body)) return { ok: false, why: 'it includes a greeting; the greeting is added separately' };
  const co = text.match(COINCIDENCE);
  if (co) return { ok: false, why: `it argues from a coincidence ("${co[0]}"); give a true reason (proximity, the crowd at home games, what they do for players) or just say they are nearby` };
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) return { ok: false, why: `it is ${words} words; keep it under 140` };
  return { ok: true };
}

// Sponsorship words: the team deal is an NIL deal and must never read as one.
const SPONSORSHIP = /\bsponsor(s|ed|ing|ship|ships)?\b|\bdonat(e|es|ed|ion|ions)\b|\bsupport(ing)?\s+(the|our)\s+(\S+\s+){0,3}program\b|\blocal partner\b/i;
function checkPitch(parsed, ctx, kind) {
  const body = String(parsed.body || '');
  const text = parsed.subject + '\n' + body;
  if (kind === 'pitch') {
    const rate = rateFor(ctx.team);
    if (rate) {
      const price = money(rate.priceCents);
      if (!body.includes(price)) return { ok: false, why: `it does not state the school's price ${price}` };
      const other = (body.match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?!\d)/g) || []).find((p) => p.replace(/\s/g, '') !== price);
      if (other) return { ok: false, why: `it names another dollar amount (${other}); the only price is the school's ${price}` };
    } else if (/\$\s?\d/.test(body)) return { ok: false, why: 'it names a price; the school has not set one, so the office sends options' };
    const sp = text.match(SPONSORSHIP);
    if (sp) return { ok: false, why: `it reads as sponsorship ("${sp[0]}"); this is an NIL deal that pays the players for the appearance and posts` };
    if (!/\b(players?|athlete[s]?)\b/i.test(body)) return { ok: false, why: 'it does not say the players are paid for the work' };
  } else if (/\$\s?\d/.test(body)) return { ok: false, why: 'it names a price; this message has none' };
  if ((kind === 'pitch' || kind === 'program') && (ROLE_THEN_NAME.test(body) || JERSEY.test(body))) return { ok: false, why: 'it names or identifies a person on the team' };
  if (kind === 'athlete') {
    const allowed = String(ctx.athlete.name || '').toLowerCase();
    const m = body.match(ROLE_THEN_NAME);
    if (m && !m[0].toLowerCase().includes(allowed.split(' ').pop())) return { ok: false, why: `it names someone other than ${ctx.athlete.name}` };
    if (!body.includes(String(ctx.athlete.name).split(' ')[0])) return { ok: false, why: `it does not name ${ctx.athlete.name}` };
  }
  if (/^\s*(hi|hello|dear|hey)\b/i.test(body)) return { ok: false, why: 'it includes a greeting; the greeting is added separately' };
  const co = text.match(COINCIDENCE);
  if (co) return { ok: false, why: `it argues from a coincidence ("${co[0]}"); give a true reason or just say they are nearby` };
  const words = body.split(/\s+/).filter(Boolean).length;
  if (ctx.dm && words > 90) return { ok: false, why: `it is ${words} words; a DM is under 70` };
  if (words > MAX_WORDS) return { ok: false, why: `it is ${words} words; keep it under 130` };
  return { ok: true };
}

// The greeting is the contact's first name when we have a named person, and
// the business otherwise. The sign-off is the STAFF MEMBER who sends it (name,
// title, department, the mailbox address), or the team when there is none.
function compose(parsed, ctx) {
  const first = String(ctx.contactName || '').trim().split(/\s+/)[0];
  const hello = first && /^[A-Z][a-z'-]+$/.test(first) ? `Hi ${first},` : `Hi ${ctx.business.brand_name} team,`;
  const s = ctx.sender;
  // A DM signs off with a name and the department; no email address.
  // THE BOOKING LINK (services/universityBook): a team deal pitch ends with
  // the page where the business picks the deal and a date.
  const link = ctx.bookUrl && kindOf(ctx) === 'pitch' ? `\n\nSee the options and pick a date: ${ctx.bookUrl}` : '';
  if (ctx.dm) return `${hello}\n\n${parsed.body.trim()}${link}\n\n${[s && s.name, `${ctx.university.name} Athletics`].filter(Boolean).join(', ')}`;
  const signOff = s && s.name
    ? [s.name, s.title, `${ctx.university.name} Athletics`, s.email].filter(Boolean).join('\n')
    : `${ctx.team.name}\n${ctx.university.name} Athletics`;
  return `${hello}\n\n${parsed.body.trim()}${link}\n\n${signOff}`;
}

// ── THE REVIEW ──────────────────────────────────────────────────────────────
// The second read. The lint above checks what a pattern can; this checks
// what only a reader can: is it really an NIL deal, is every claim about the
// business in the facts, is the reason true, does it sound like a person.
// -> { pass, problems[] }. A reply that is not the JSON asked for is a fail:
// nothing reaches a school on a review that did not happen.
function reviewPrompt(parsed, ctx) {
  const kind = kindOf(ctx);
  const rate = kind === 'pitch' ? rateFor(ctx.team) : null;
  const rules = [
    kind === 'pitch'
      ? `It offers an NIL deal that pays the players for real work (an appearance and posts). It must NOT read as a sponsorship, a donation or support for the program.`
      : `It asks the brand to work with players on the team through the brand's own athlete program. It must NOT ask for money for the program.`,
    rate ? `It states the school's price ${money(rate.priceCents)} once, and no other dollar amount.` : `It names no price or dollar amount.`,
    `Every claim about the business is supported by the FACTS. Anything not in the facts (an event, an award, a person, a history, a product, a review) is invented and fails.`,
    `The reason the business fits is real: being near campus, the crowd at home games, or what the business does for players and fans. A coincidence of names, themes, mascots or colours fails.`,
    `It names or describes no individual student athlete, coach or staff member.`,
    `It reads like a person at the athletic department wrote it: plain, specific to this business, no hype, no filler.`,
    `It ends with one clear ask: a reply or a short call.`,
  ];
  return `You are reviewing an email before it goes to a local business. Be strict: if any rule fails, it fails.

FACTS:
${facts(ctx)}${rate ? `\nTHE DEAL THE SCHOOL OFFERS: ${rate.what}\nPRICE SET BY THE SCHOOL: ${money(rate.priceCents)}` : ''}
${officeFacts(kind, rate)}

EMAIL:
SUBJECT: ${parsed.subject}
${parsed.body}

RULES:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Reply with JSON only, no other text: {"pass": true or false, "problems": ["the rule number and what is wrong, in one short sentence", ...]}`;
}
// WHAT THE WRITER WAS TOLD TO SAY (2026-11-17). The writer's prompt tells it
// to say the deal is set up and paid through the school's NIL marketplace, that
// the office sends options when no price is set, and that it may give the
// general reasons (near campus, home games bring students and families by).
// The reviewer was never told those were true, so a strict reviewer failed them
// as invented: Cypress, Nov 17, 8 of 30 cards, six teams with none. These are
// the office's own facts, given to the reviewer so it judges the same email the
// writer was asked for. Claims about THE BUSINESS still need the FACTS.
function officeFacts(kind, rate) {
  const L = ['FROM THE OFFICE (true, not invented; the writer was told to say these):',
    '- Saying the business is close to campus, or that home games bring students and families nearby, is a general reason the office gave. It is not an invented fact about the business.'];
  if (kind === 'pitch') {
    L.push("- The deal is set up and paid through the school's NIL marketplace.");
    if (!rate) L.push('- The office sends a few options with prices when the business replies.');
  }
  return L.join('\n');
}
function parseReview(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { pass: false, problems: ['the review did not answer in the format asked'] };
  try {
    const j = JSON.parse(m[0]);
    const problems = Array.isArray(j.problems) ? j.problems.map((x) => String(x).slice(0, 300)).filter(Boolean) : [];
    // A pass that still lists problems is a fail; a fail with no reason still fails.
    const pass = j.pass === true && !problems.length;
    return { pass, problems: pass ? [] : (problems.length ? problems : ['failed without a reason']) };
  } catch (_) { return { pass: false, problems: ['the review did not answer in the format asked'] }; }
}
const REVIEWED = new Set(['pitch', 'program']);
async function review(parsed, ctx, ai) {
  const call = ai.oneShot(reviewPrompt(parsed, ctx), 'You check short business emails against a checklist and answer in JSON.', 400, REVIEW_MODEL, {});
  const raw = typeof ai.withDeadline === 'function' ? await ai.withDeadline(call, REVIEW_TIMEOUT_MS, `review for ${ctx.business.brand_name}`) : await call;
  return parseReview(raw);
}

// Write one ask. `oneShot` is injectable for tests; the default is ai.oneShot
// on MODEL. A nightly card (team deal or brand program) also passes the
// review; `reviews` says how many review calls were made, for the cost cap.
// Returns { ok, subject, body, model, retried, reviews } or { ok:false, error, reviews }.
async function writeAsk(ctx, opts = {}) {
  const ai = opts.ai || require('../ai');
  let lastWhy = null, reviews = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      const call = ai.oneShot(buildPrompt(ctx, lastWhy), kindOf(ctx) === 'ask' ? SYSTEM : SYSTEM_PITCH, 700, MODEL, { prose: true });
      raw = typeof ai.withDeadline === 'function'
        ? await ai.withDeadline(call, DRAFT_TIMEOUT_MS, `team ask for ${ctx.business.brand_name}`) : await call;
    } catch (e) { return { ok: false, error: 'model: ' + e.message }; }
    const parsed = parse(raw);
    if (!parsed) { lastWhy = 'the reply was not in the SUBJECT/BODY format'; continue; }
    const check = checkAsk(parsed, ctx);
    if (!check.ok) { lastWhy = check.why; continue; }
    if (REVIEWED.has(kindOf(ctx)) && opts.review !== false) {
      let r;
      reviews++;
      try { r = await review(parsed, ctx, ai); }
      catch (e) { return { ok: false, error: 'model: review: ' + e.message, reviews }; }
      if (!r.pass) { lastWhy = 'the reviewer failed it: ' + r.problems.join('; '); continue; }
    }
    return { ok: true, subject: parsed.subject, body: compose(parsed, ctx), model: MODEL, retried: attempt > 0, reviews };
  }
  return { ok: false, error: 'refused after retry: ' + lastWhy, reviews };
}

module.exports = { writeAsk, buildPrompt, checkAsk, parse, compose, money, facts, kindOf, rateFor, dealAsk, reviewPrompt, parseReview, officeFacts, SPONSORSHIP, MODEL, REVIEW_MODEL, SYSTEM, SYSTEM_PITCH, COINCIDENCE };
