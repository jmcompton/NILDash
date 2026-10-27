'use strict';
// ── THE SALES AUTOPILOT'S EMAILS (services/salesAutopilot) ──────────────────
//
// One short plain-text email per prospect, written as JohnMark, and two
// follow-ups that go in the same thread. The rules every email is held to,
// whoever wrote it (checkEmail):
//   - it leads with the time bought back: every morning, 5 ready pitches,
//     already written, going to verified people;
//   - one specific line about them (their agency, sport or school);
//   - one ask: 15 minutes, with the one link (mynildash.com/try, which books
//     the demo and starts the 14-day trial);
//   - plain words: no hype, no exclamation marks, no em dashes, never "AI";
//   - never says NILDash closes, negotiates or signs deals;
//   - under 120 words, the sign-off included and the CAN-SPAM footer not.
// Schools get the team version: sponsorship pitches for teams and programs,
// never individual athletes.
//
// The model writes it (the cold agent's pattern: services/coldAgent
// writeEmail); a draft that fails a check is replaced by the template, which
// always passes. The pitch writer is not used and not touched.
//
// THE SAMPLE EMAIL (services/salesSample, SALES_SAMPLE_ON). When NILDash has
// already run for one of the agent's own clients, the email leads with that:
// "I ran NILDash for <athlete> at <school>", and its one link is the sample
// page (which carries the 15 minutes and the trial), not /try.
//
// THE SPECIFIC LINE is about their workload, not a sentence read back off
// their own website ("X is a family owned agency...", Oct 27 review): it
// names them and says what the mornings are worth to them.
//
// THE SIGN-OFF: name, "Founder, NILDash", and SALES_SENDER_PHONE when set.

const lc = (s) => String(s || '').trim().toLowerCase();

const MAX_WORDS = 119;          // "under 120"
const MAX_SUBJECT_WORDS = 8;

// Words a sales email may not use. Plain, direct, never "AI".
const HYPE = [
  /revolution/i, /game[- ]?chang/i, /cutting[- ]edge/i, /state[- ]of[- ]the[- ]art/i, /best[- ]in[- ]class/i, /world[- ]class/i,
  /\bunlock/i, /\bunleash/i, /\bleverag/i, /\bsupercharg/i, /\bskyrocket/i, /\bseamless/i, /\beffortless/i, /\bpowerful\b/i,
  /\bamazing\b/i, /\bincredible\b/i, /\bawesome\b/i, /\bexcit(ed|ing)\b/i, /\bthrilled\b/i, /\bpassionate\b/i, /\binnovative\b/i,
  /\bdisrupt/i, /\bsynerg/i, /\b10x\b/i, /\bguarantee/i, /\bmassive\b/i, /\bexplod/i, /\bmaximi[sz]e/i, /\btransform/i,
  /\bnext[- ]level\b/i, /\bmagic/i, /\bAI\b/, /\bA\.I\./i, /\bartificial intelligence\b/i, /\bhope (this|you)\b/i,
  /\btouch(ing)? base\b/i, /\bcircle back\b/i, /\bjust checking in\b/i, /\bquick question\b/i, /\bno[- ]brainer\b/i,
];
// NILDash never closes, negotiates or signs a deal: it finds and writes.
const DEAL_CLAIM = /\b(clos(e|es|ed|ing)|negotiat\w*|sign(s|ed|ing)?|land(s|ed|ing)?|secur(e|es|ed|ing)|win(s|ning)?|won)\b[^.\n]{0,40}\b(deals?|sponsorships?|contracts?|partnerships?)\b|\b(deals?|sponsorships?|contracts?)\b[^.\n]{0,25}\b(closed|negotiated|signed)\b/i;
const DASHES = /[\u2014\u2013]|\s--\s/;

function words(text) { return String(text || '').split(/\s+/).filter(Boolean).length; }
function firstName(full) {
  const f = String(full || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'.-]{1,}$/.test(f) ? f.charAt(0).toUpperCase() + f.slice(1) : null;
}
function links(text) { return (String(text || '').match(/https?:\/\/[^\s<>()]+/g) || []).map((u) => u.replace(/[.,;:]+$/, '')); }

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'Washington, D.C.', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const stateName = (st) => STATE_NAMES[String(st || '').toUpperCase()] || null;

// The one specific line, cleaned: one sentence, plain, no dashes, no hype.
// null when there is nothing usable, and the caller uses fallbackFact.
function cleanFact(fact) {
  let s = String(fact || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/\s--\s/g, ', ');
  const first = (s.match(/^.*?[.!?](\s|$)/) || [s])[0].trim();
  s = first.replace(/[!?]$/, '.').replace(/([^.])$/, '$1.');
  if (words(s) > 35 || words(s) < 4) return null;
  if (HYPE.some((re) => re.test(s)) || DEAL_CLAIM.test(s) || /https?:\/\//i.test(s)) return null;
  return s;
}

// A true line when research found nothing usable: how we came to them.
function fallbackFact(p) {
  const where = stateName(p.state);
  if (p.lane === 'school') {
    const lvl = p.level || 'college';
    return `I came across your name while looking at NIL staff at ${lvl} schools${where ? ` in ${where}` : ''}.`;
  }
  const league = p.league && p.league !== 'NIL' ? `${p.league} ` : 'NIL ';
  return `I came across ${p.org || 'your agency'} while looking at ${league}agencies${where ? ` in ${where}` : ''}.`;
}

// The sign-off block: name, title, and the phone when SALES_SENDER_PHONE is set.
function signOff(ctx) {
  const phone = String((ctx && ctx.senderPhone) || '').replace(/[^0-9()+ .-]/g, '').trim();
  return [ctx.senderName, 'Founder, NILDash'].concat(phone ? [phone] : []).join('\n');
}
// "Jordan Sports Group's", "Rosenhaus Sports'".
function possessive(org) { const o = String(org || '').trim(); return /s$/i.test(o) ? o + "'" : o + "'s"; }
// The one specific line: them, and what the mornings are worth to them.
function workloadLine(p) {
  if (p.lane === 'school') return `For ${p.org || 'your department'}, that is hours back every week for your staff.`;
  return `For the team at ${p.org || 'your agency'}, that is hours of writing back every week.`;
}

// ── THE TEMPLATE: ALWAYS PASSES ──────────────────────────────────────────
// ctx: { link, trialOn, senderName, senderPhone }
function askLine(p, ctx) {
  const what = p.lane === 'school' ? `for ${p.org || 'your department'}` : 'with your roster';
  return `Worth 15 minutes to see it ${what}? You can book a time${ctx.trialOn ? ' or start a 14-day trial' : ''} here: ${ctx.link}`;
}
function templateEmail(p, ctx) {
  const first = firstName(p.person) || 'there';
  const fact = p.org ? workloadLine(p) : (cleanFact(p.fact) || fallbackFact(p));
  const lead = p.lane === 'school'
    ? 'NILDash gives athletic departments their mornings back. Every morning, each of your teams and programs has 5 sponsorship pitches ready for local businesses, already written and going to verified people at those businesses. Your staff reviews and sends.'
    : 'NILDash gives agents their mornings back. Every morning, each athlete you represent has 5 pitches ready for local and social brands, already written and going to verified people at those businesses. You review and send.';
  const body = [`Hi ${first},`, '', lead, '', fact, '', askLine(p, ctx), '', signOff(ctx)].join('\n');
  const subject = p.lane === 'school' ? 'Sponsor pitches for your teams, ready daily' : 'Pitches for your athletes, ready each morning';
  return { subject, body };
}

// ── THE SAMPLE EMAIL ─────────────────────────────────────────────────────
// sample: { athlete: { name, school }, cards: [...] }; ctx.link is the sample page.
function sampleEmail(p, ctx, sample) {
  const first = firstName(p.person) || 'there';
  const a = (sample && sample.athlete) || {};
  const n = Math.min(3, ((sample && sample.cards) || []).length);
  const what = n === 1 ? 'a local business' : `${n} local businesses`;
  const at = a.school ? ` at ${a.school}` : '';
  const lines = [
    `Hi ${first},`, '',
    `I ran NILDash for one of ${possessive(p.org || 'your agency')} clients, ${a.name}${at}. It found ${what}, the right person to contact, and a pitch already written in your name: ${ctx.link}`, '',
    'Every athlete you represent would get that each morning: 5 pitches, already written, going to verified people. You review and send.', '',
    `Worth 15 minutes to see it with your whole roster?${ctx.trialOn ? ' The page also lets you start a 14-day trial.' : ''}`, '',
    signOff(ctx),
  ];
  const last = String(a.name || '').trim().split(/\s+/).slice(-1)[0] || '';
  const subject = a.name ? `${a.name}: ${n === 1 ? '1 brand' : n + ' brands'} ready to pitch` : 'Brands ready to pitch for your athletes';
  return { subject: words(subject) <= MAX_SUBJECT_WORDS ? subject : `${last}: ${n} brands ready to pitch`, body: lines.join('\n') };
}

// The follow-ups: day 3 and day 7, replies in the same thread.
function followUp(p, step, ctx) {
  const first = firstName(p.person) || 'there';
  const sign = firstName(ctx.senderName) || ctx.senderName;
  const who = p.lane === 'school' ? 'each of your teams' : 'every athlete you represent';
  const body = step === 2
    ? [`Hi ${first},`, '', `Bumping this in case it got buried. If 5 ready pitches each morning for ${who} would save you time, here are 15 minutes: ${ctx.link}`, '', sign]
    : [`Hi ${first},`, '', `Last note from me on this. If the timing is wrong, no reply needed. If you want to see it, you can book 15 minutes${ctx.trialOn ? ' or start a 14-day trial' : ''} here: ${ctx.link}`, '', sign];
  return { subject: null, body: body.join('\n') };
}

// ── THE CHECKS ───────────────────────────────────────────────────────────
// [] when the email may go. step 1 is held to everything; a follow-up to the
// rules that apply to two lines.
function checkEmail({ subject, body }, p, ctx, step = 1) {
  const problems = [];
  const all = `${subject || ''}\n${body || ''}`;
  for (const re of HYPE) if (re.test(all)) problems.push('uses a word it may not: ' + re.source);
  if (/!/.test(all)) problems.push('has an exclamation mark');
  if (DASHES.test(all)) problems.push('has an em dash');
  if (DEAL_CLAIM.test(all)) problems.push('says NILDash closes, negotiates or signs deals');
  const n = words(body);
  if (n > MAX_WORDS) problems.push(`too long (${n} words; under 120)`);
  const ls = links(body);
  if (ls.length !== 1) problems.push(`has ${ls.length} links; it needs exactly one, ${ctx.link}`);
  else if (ls[0] !== ctx.link) problems.push(`its link is ${ls[0]}, not ${ctx.link}`);
  if (/\[[^\]]+\]|\{\{|\}\}|<[^>]+>/.test(all)) problems.push('has a placeholder or markup');
  if (!new RegExp(`\\b${String(firstName(ctx.senderName) || 'JohnMark').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body)) problems.push('is not signed by ' + ctx.senderName);
  if (step === 1) {
    if (!subject || !String(subject).trim()) problems.push('has no subject');
    else if (words(subject) > MAX_SUBJECT_WORDS) problems.push(`subject too long (${words(subject)} words)`);
    if (!/\b(5|five)\b[^.]{0,40}\bpitch/i.test(body)) problems.push('does not say 5 ready pitches');
    if (!/\bmornings?\b/i.test(body)) problems.push('does not lead with the mornings bought back');
    if (!/already written/i.test(body)) problems.push('does not say the pitches are already written');
    if (!/\bverified\b/i.test(body)) problems.push('does not say they go to verified people');
    if (!/\b15[- ]minute|\b15 minutes\b|\bfifteen minutes\b/i.test(body)) problems.push('does not ask for 15 minutes');
    if (ctx.trialOn && !/14-day trial/i.test(body)) problems.push('does not offer the 14-day trial');
    if (p.org && !lc(body).includes(lc(p.org)) && !(p.fact && lc(body).includes(lc(cleanFact(p.fact) || '').slice(0, 30)))) {
      problems.push('has no specific line about ' + p.org);
    }
    if (p.lane === 'school') {
      if (!/\bteams?\b|\bprograms?\b/i.test(body)) problems.push('the school version must be about teams and programs');
      if (!/\bsponsor/i.test(body)) problems.push('the school version must say sponsorship');
      if (/\bathletes? (you represent|on your roster)\b/i.test(body)) problems.push('the school version must not pitch individual athletes');
    }
  }
  return problems;
}

// ── THE WRITER ───────────────────────────────────────────────────────────
// write(p, ctx, deps) -> { subject, body, by: 'writer'|'template'|'injected', writerProblems? }
async function write(p, ctx, deps = {}) {
  const base = templateEmail(p, ctx);
  if (deps.write === false) return { ...base, by: 'template' };
  try {
    let j;
    if (typeof deps.write === 'function') j = await deps.write(p, ctx);
    else {
      const ai = require('../ai');
      const scanMeter = require('../scanMeter');
      const facts = {
        to: { firstName: firstName(p.person), org: p.org, title: p.title || null, lane: p.lane, league: p.league || null, level: p.level || null, state: stateName(p.state) },
        specificLine: p.org ? workloadLine(p) : (cleanFact(p.fact) || fallbackFact(p)),
        link: ctx.link, trialOn: !!ctx.trialOn, signOff: signOff(ctx),
      };
      const team = p.lane === 'school';
      const prompt = `Write a short cold email from ${ctx.senderName}, founder of NILDash, to ${team ? 'a college athletic department NIL director' : 'a sports agent'}.
FACTS (use only these): ${JSON.stringify(facts)}
Shape, in this order:
1. "Hi ${facts.to.firstName || 'there'}," on its own line.
2. Lead with the time they get back: every morning ${team ? 'each of their teams and programs has 5 sponsorship pitches ready for local businesses' : 'each athlete they represent has 5 pitches ready for local and social brands'}, already written and going to verified people at those businesses; ${team ? 'their staff reviews and sends' : 'they review and send'}. Two or three plain sentences.
3. The specific line, in your own words, keeping its facts: ${JSON.stringify(facts.specificLine)} (it must name them and say what the time is worth to them; never describe their company back to them)
4. One ask, one sentence: 15 minutes to see it, with this link exactly once: ${ctx.link}${ctx.trialOn ? ' (the same link also starts a 14-day trial; say so)' : ''}.
5. The sign-off exactly: ${JSON.stringify(facts.signOff)}
Rules: under 110 words including the sign-off. Plain text, no links but that one. No exclamation marks, no em dashes, no hype or marketing words, never the word AI. Never say NILDash closes, negotiates or signs deals.${team ? ' It is about teams and programs, never individual athletes.' : ''}
Return ONLY JSON: {"subject":"under 8 words, plain","body":"the email with \\n line breaks"}`;
      const raw = await scanMeter.label({ site: 'sales.write', agentId: 'nildash-sales', brand: p.email },
        () => ai.oneShot(prompt, 'You write short, plain, direct sales emails. You return strict JSON.', 600, undefined, { prose: true }));
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      j = m ? JSON.parse(m[0]) : null;
    }
    if (j && j.subject && j.body) {
      const out = { subject: String(j.subject).trim(), body: String(j.body).trim().replace(/\r\n/g, '\n') };
      const problems = checkEmail(out, p, ctx, 1);
      if (!problems.length) return { ...out, by: typeof deps.write === 'function' ? 'injected' : 'writer' };
      return { ...base, by: 'template', writerProblems: problems };
    }
    return { ...base, by: 'template', writerProblems: ['the writer returned no subject and body'] };
  } catch (e) {
    return { ...base, by: 'template', writerError: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { write, templateEmail, sampleEmail, followUp, checkEmail, cleanFact, fallbackFact, firstName, words, links, stateName,
  signOff, workloadLine, possessive,
  HYPE, DEAL_CLAIM, MAX_WORDS, STATE_NAMES };
