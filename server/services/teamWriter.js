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
const DRAFT_TIMEOUT_MS = 45000;
const MAX_WORDS = 170;

const SYSTEM = 'You write short sponsorship asks from a college athletics department to a local business. '
  + 'You write like a person at the department who knows the town and has looked at this business. '
  + 'The sponsorship supports the team and the program. You never name, quote, describe or single out any '
  + 'student athlete, and you never mention NIL. You make exactly one ask: the inventory item you are given, '
  + 'at the price you are given. No filler, no flattery, no sentence that would be true of any other business.';

function money(cents) {
  const d = Math.round(Number(cents) || 0) / 100;
  return '$' + d.toLocaleString('en-US', { minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function milesFrom(m) {
  if (m == null || !Number.isFinite(Number(m))) return null;
  const mi = Number(m) / 1609.34;
  return mi < 0.95 ? 'under a mile' : `about ${Math.round(mi * 10) / 10} miles`;
}

// The facts the model sees. Deliberately small, and nothing about any person.
function facts({ university, team, business, item }) {
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
    `THE ASK: ${item.name}, ${money(item.price_cents)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function buildPrompt(ctx, retryBecause) {
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

function parse(raw) {
  const s = String(raw || '').replace(/\r/g, '');
  const m = s.match(/SUBJECT:\s*(.+)\n+\s*BODY:\s*\n?([\s\S]+)/i);
  if (!m) return null;
  const subject = m[1].trim().replace(/^["']|["']$/g, '');
  const body = m[2].trim();
  if (!subject || !body) return null;
  return { subject, body };
}

const ROLE_THEN_NAME = /\b(guard|forward|center|point guard|captain|player|athlete|student-athlete|freshman|sophomore|junior|senior|coach|star|standout)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/;
const JERSEY = /(?:#|\bNo\.\s?)\d{1,2}\b/;
// REASONING FROM A COINCIDENCE. The Pirates Dinner Adventure ask argued the
// pirate theme was a natural match for basketball. The words that carry that
// kind of argument, refused in the text rather than trusted to the prompt.
const COINCIDENCE = /\b(theme[ds]?|mascot|namesake|pun)\b|\b(natural|perfect|fitting)\s+(fit|match|pairing|partner(ship)?)\b|\bshare[sd]?\s+(?:(?:a|the|our|your)\s+)?(?:same\s+)?(name|spirit|theme|colou?rs?|nickname)\b|\bjust\s+like\s+(our|the)\s+(team|players|program)\b/i;

// The rules the prompt states, checked in the text. Returns { ok } or { ok:false, why }.
function checkAsk(parsed, ctx) {
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

function compose(parsed, ctx) {
  const signOff = `${ctx.team.name}\n${ctx.university.name} Athletics`;
  return `Hi ${ctx.business.brand_name} team,\n\n${parsed.body.trim()}\n\n${signOff}`;
}

// Write one ask. `oneShot` is injectable for tests; the default is ai.oneShot
// on MODEL. Returns { ok, subject, body, model, retried } or { ok:false, error }.
async function writeAsk(ctx, opts = {}) {
  const ai = opts.ai || require('../ai');
  let lastWhy = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      const call = ai.oneShot(buildPrompt(ctx, lastWhy), SYSTEM, 700, MODEL, { prose: true });
      raw = typeof ai.withDeadline === 'function'
        ? await ai.withDeadline(call, DRAFT_TIMEOUT_MS, `team ask for ${ctx.business.brand_name}`) : await call;
    } catch (e) { return { ok: false, error: 'model: ' + e.message }; }
    const parsed = parse(raw);
    if (!parsed) { lastWhy = 'the reply was not in the SUBJECT/BODY format'; continue; }
    const check = checkAsk(parsed, ctx);
    if (!check.ok) { lastWhy = check.why; continue; }
    return { ok: true, subject: parsed.subject, body: compose(parsed, ctx), model: MODEL, retried: attempt > 0 };
  }
  return { ok: false, error: 'refused after retry: ' + lastWhy };
}

module.exports = { writeAsk, buildPrompt, checkAsk, parse, compose, money, facts, MODEL, SYSTEM, COINCIDENCE };
