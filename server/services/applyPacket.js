'use strict';
// ── A BRAND'S ATHLETE PROGRAM, APPLIED TO IN TWO MINUTES ────────────────────
//
// Nov 13 2026: in 60 days the social lane made 196 cards and agents acted on
// none of them. A program card (channel 'program') points at a brand's own
// athlete or ambassador application page, and it was left off Home ("waiting
// on the Outreach tab"), with nothing filled in: somebody had to sit down and
// type an athlete's whole profile into a stranger's form. Nobody did.
//
// This builds the finished application for one card: every answer a program
// form asks for, from what we hold on the athlete (the connected Instagram's
// own numbers first, the agent's entry second, never a guess), the brand's
// program as its page states it, and why this athlete fits, from the same
// researched facts the pitches use (services/fitReasons). The agent opens the
// form, pastes, submits; or sends it to the athlete in one tap.
//
// No model call: every line is a fact we hold, put in plain sentences. A field
// we do not hold is left out, never filled with a placeholder.

const RECORD = require('./athleteRecord');

const fmtN = (n) => Number(n).toLocaleString('en-US');
const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '') || null;
const handle = (h) => {
  let x = clean(h); if (!x) return null;
  x = x.replace(/^https?:\/\/(www\.)?(instagram\.com|tiktok\.com)\//i, '').replace(/^@+/, '').split(/[/?#\s]/)[0];
  return /^[A-Za-z0-9._]{1,30}$/.test(x) ? '@' + x : null;
};
// "womens soccer" -> "women's soccer"; otherwise as entered, lower case.
const sportWord = (s) => (clean(s) || '').toLowerCase().replace(/\b(wo)?mens\b/g, (m) => m.replace(/s$/, "'s"));
// What one outing is called in each sport.
const outing = (s) => (/tennis|golf|wrestl/i.test(s) ? 'match' : /track|cross country|swim|div|gymnast|rowing/i.test(s) ? 'meet' : 'game');
// The program's deal type, in words.
const DEAL_WORDS = { affiliate: 'Affiliate commission', gifting_code: 'Free product and a discount code', gifting: 'Free product', paid: 'Paid posts', paid_post: 'Paid posts', ambassador: 'Ambassador program' };

// Two content ideas a program form asks for ("what would you post?"), by the
// brand's category. Plain and specific to the athlete's sport; the athlete
// edits them.
const IDEAS = [
  [/supplement|nutrition|protein|vitamin|hydration|sports drink/i, (b, s) => [
    `A training-day post showing how I use ${b} before ${s} practice`,
    `A short reel on my recovery routine after games, with ${b} in it`]],
  [/energy|beverage|drink|coffee|tea|soda|water/i, (b, s) => [
    `A game-day reel with ${b} in my pre-game routine`,
    `A post from a long ${s} practice day on what keeps me going`]],
  [/apparel|clothing|fashion|shoe|sneaker|footwear|jewel|accessor|eyewear|sunglass/i, (b, s) => [
    `A game-day fit post wearing ${b}`,
    `A day-in-the-life reel as a ${s} athlete, styled in ${b}`]],
  [/skin|beauty|cosmetic|hair|grooming|personal care|deodorant|razor/i, (b, s) => [
    `A get-ready-with-me reel before a ${s} game using ${b}`,
    `A post on my routine after practice with ${b}`]],
  [/app|software|tech|gaming|game|electronic|headphone|audio/i, (b, s) => [
    `A reel showing how I use ${b} in my week as a ${s} athlete`,
    `A story series with a code or link for my followers to try ${b}`]],
  [/food|snack|restaurant|meal|candy|jerky|bar\b/i, (b, s) => [
    `A post on what I eat around ${s} practice, featuring ${b}`,
    `A team-snack reel with ${b} on a road trip or game day`]],
  [/fitness|gym|training|equipment|recovery|wellness|massage/i, (b, s) => [
    `A workout reel from my ${s} training using ${b}`,
    `A recovery-day post on how ${b} fits my routine`]],
];
function ideasFor(brand, category, sport) {
  const s = sportWord(sport) || 'my sport';
  const o = outing(s);
  const fix = (x) => x.replace(/game-day/g, o === 'game' ? 'game-day' : o + '-day').replace(/ game\b/g, ' ' + o).replace(/\bgames\b/g, o + 'es'.slice(o === 'game' ? 1 : 0));
  for (const [re, fn] of IDEAS) if (re.test(String(category || ''))) return fn(brand, s).map(fix);
  return [`A game-day post featuring ${brand}`, `A day-in-the-life reel as a ${s} athlete that shows ${brand}`].map(fix);
}

// The athlete's line in one sentence: "I'm a junior wide receiver on the
// Samford football team." Only the parts we hold.
function introOf(a) {
  const sport = sportWord(a.sport), school = clean(a.school), pos = clean(a.position), yr = clean(a.year);
  if (a.athleteType === 'pro') {
    return clean(`I'm a professional ${sport || 'athlete'}${a.team ? ' with ' + a.team : ''}${a.city ? ' in ' + a.city : ''}.`);
  }
  if (!school && !sport) return null;
  const year = yr ? yr.toLowerCase() : null;
  const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
  const the = school && /^the\s/i.test(school) ? '' : 'the ';
  let line;
  if (school && sport) line = year ? `I'm ${article(year)} ${year} on ${the}${school} ${sport} team` : `I play ${sport} at ${school}`;
  else if (school) line = year ? `I'm ${article(year)} ${year} at ${school}` : `I'm an athlete at ${school}`;
  else line = `I play ${sport}`;
  return line + (pos ? `, playing ${pos}.` : '.');
}

// build({ card, athlete (resolveAthlete record), brand (social_brands row or {}),
//         verifiedIg (instagramInsights.verifiedFor or null), fit (fitReasons
//         result or null), mediaKitUrl, agent: { name, email } })
// -> { brand, programUrl, offer, fields: [{ label, value }], text, missing: [] }
function build({ card, athlete, brand, verifiedIg, fit, mediaKitUrl, agent } = {}) {
  const a = athlete || {}, b = brand || {}, c = card || {};
  const brandName = clean(c.brand_name) || clean(b.brand) || 'this brand';
  const fields = [];
  const missing = [];
  const add = (label, value, needed) => {
    const v = clean(value == null ? null : String(value));
    if (v) fields.push({ label, value: v });
    else if (needed) missing.push(label);
  };

  add('Full name', a.name, true);
  if (a.athleteType === 'pro') { add('Team', a.team, true); add('City', a.city, false); }
  else { add('School', a.school, true); add('Class year', a.year, false); }
  add('Sport', a.sport, true);
  add('Position', a.position, false);
  add('Hometown', a.hometown, false);

  // Instagram: the connected account's own numbers first, dated; the agent's
  // entry otherwise, said as such.
  const ig = handle(a.instagramHandle);
  if (verifiedIg && verifiedIg.followers) {
    add('Instagram', `${ig ? ig + ', ' : ''}${fmtN(verifiedIg.followers)} followers (verified by Instagram, ${verifiedIg.asOf})`, true);
    if (verifiedIg.avgReachPerPost) add('Average reach per post', `${fmtN(verifiedIg.avgReachPerPost)} accounts (Instagram insights)`, false);
    const top = Array.isArray(verifiedIg.cityRows) && verifiedIg.cityRows.length
      ? verifiedIg.cityRows.slice().sort((x, y) => (Number(y.value) || 0) - (Number(x.value) || 0))[0] : null;
    if (top && top.key) add('Top follower city', top.key, false);
  } else if (ig || a.instagram) {
    add('Instagram', `${ig || ''}${ig && a.instagram ? ', ' : ''}${a.instagram ? fmtN(a.instagram) + ' followers' : ''}`, true);
  } else missing.push('Instagram');
  // Only the connected account's own rate: an entered or default number
  // (many records hold 3%) is not something to put on an application.
  if (a.engagement != null && verifiedIg && verifiedIg.followers) add('Engagement rate', `${a.engagement}%`, false);
  const tt = handle(a.tiktokHandle);
  if (tt || a.tiktok) add('TikTok', `${tt || ''}${tt && a.tiktok ? ', ' : ''}${a.tiktok ? fmtN(a.tiktok) + ' followers' : ''}`, false);
  add('Media kit', mediaKitUrl, false);

  // WHY THIS ATHLETE, in the athlete's voice, from facts only.
  const why = [];
  const intro = introOf(a);
  if (intro) why.push(intro);
  if (verifiedIg && verifiedIg.followers) {
    why.push(`${fmtN(verifiedIg.followers)} people follow me on Instagram${verifiedIg.avgReachPerPost ? `, and my posts reach about ${fmtN(verifiedIg.avgReachPerPost)} accounts each` : ''}.`);
  } else if (a.instagram) {
    why.push(`${fmtN(a.instagram)} people follow me on Instagram.`);
  }
  const sportFit = fit && Array.isArray(fit.kinds) && fit.kinds.includes('sport');
  if (sportFit && a.sport) why.push(`Your program works with ${sportWord(a.sport)} athletes, and I would be proud to represent ${brandName}.`);
  else why.push(`I would be proud to represent ${brandName} and share it with the people who follow my season.`);
  add(`Why I'm a fit for ${brandName}`, why.join(' '), false);

  const ideas = ideasFor(brandName, b.category, a.sport);
  add('Content I would create', ideas.map((x, i) => `${i + 1}. ${x}`).join(' '), false);
  if (agent && (agent.name || agent.email)) add('Representation', [clean(agent.name), clean(agent.email)].filter(Boolean).join(', '), false);

  const summary = clean(b.offer_summary) ? clean(b.offer_summary).replace(/[.;\s]+$/, '') : null;
  const deal = clean(b.deal_structure) ? (DEAL_WORDS[clean(b.deal_structure).toLowerCase()] || null) : null;
  const offer = summary || deal || null;
  const programUrl = clean(c.program_url) || clean(b.proof_url) || null;
  const text = [`Application: ${brandName} athlete program`, programUrl ? `Apply here: ${programUrl}` : null, '',
    ...fields.map((f) => `${f.label}: ${f.value}`)].filter((x) => x !== null).join('\n');
  return { brand: brandName, programUrl, offer, category: clean(b.category), fields, text, missing,
    verified: !!(verifiedIg && verifiedIg.followers) };
}

// A mailto the agent sends to the athlete from their own mail app: the link
// and the answers, ready to paste. null when we hold no athlete email.
function mailtoFor(packet, athleteEmail, athleteName) {
  const to = clean(athleteEmail);
  if (!to || !/@/.test(to)) return null;
  const first = (clean(athleteName) || '').split(' ')[0] || 'there';
  const subject = `Apply to ${packet.brand}: everything is filled in`;
  const body = `Hi ${first},\n\n${packet.brand} has an athlete program that fits you. Your application is written below. `
    + `Open the link, paste each answer, check it over and submit. It should take about two minutes.\n\n${packet.text}\n`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Every queued program card for one agent, each with its finished application.
async function listForAgent(pool, agentId, deps = {}) {
  const rows = (await pool.query(
    `SELECT q.id, q.athlete_id, q.brand_name, q.brand_key, q.program_url, q.lane, q.why, q.created_at,
            a.data AS athlete_data, a.id AS aid,
            sb.brand AS sb_brand, sb.category, sb.offer_summary, sb.deal_structure, sb.proof_url, sb.sports, sb.tier_min, sb.tier_max, sb.tier_stated, sb.brand_size,
            mk.slug AS kit_slug, u.name AS agent_name, u.email AS agent_email
       FROM outreach_queue q
       JOIN athletes a ON a.id = q.athlete_id
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN LATERAL (SELECT * FROM social_brands s WHERE LOWER(s.brand) = LOWER(q.brand_name) ORDER BY s.active DESC, s.proof_date DESC NULLS LAST LIMIT 1) sb ON TRUE
       LEFT JOIN LATERAL (SELECT slug FROM media_kits m WHERE m.athlete_id = q.athlete_id AND m.slug IS NOT NULL ORDER BY m.updated_at DESC NULLS LAST LIMIT 1) mk ON TRUE
      WHERE q.agent_id = $1 AND q.state = 'queued' AND q.channel = 'program'
      ORDER BY a.data->>'name', q.created_at`, [agentId])).rows;
  const appUrl = (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
  const igCache = new Map();
  const verifiedFor = deps.verifiedFor || ((p, id) => require('./instagramInsights').verifiedFor(p, id));
  const Fit = require('./fitReasons');
  const out = [];
  for (const r of rows) {
    const athlete = RECORD.resolveAthlete({ id: r.aid, data: r.athlete_data || {} });
    if (!igCache.has(r.aid)) igCache.set(r.aid, await verifiedFor(pool, r.aid).catch(() => null));
    const verifiedIg = igCache.get(r.aid);
    const brand = { brand: r.sb_brand, category: r.category, offer_summary: r.offer_summary, deal_structure: r.deal_structure, proof_url: r.proof_url };
    const cand = { brand_name: r.brand_name, offerSummary: r.offer_summary, sports: r.sports, tierMin: r.tier_min, tierMax: r.tier_max, tierStated: r.tier_stated };
    let fit = null;
    try { fit = Fit.build(cand, athlete, { verifiedIg }); } catch (_) { fit = null; }
    const packet = build({ card: r, athlete, brand, verifiedIg, fit,
      mediaKitUrl: r.kit_slug ? `${appUrl}/media-kit/${r.kit_slug}` : null,
      agent: { name: r.agent_name, email: r.agent_email } });
    const d = r.athlete_data || {};
    out.push({ id: r.id, athleteId: r.aid, athleteName: athlete.name, ...packet,
      mailto: mailtoFor(packet, d.email || d.contactEmail || null, athlete.name), createdAt: r.created_at });
  }
  return out;
}

module.exports = { build, listForAgent, mailtoFor, ideasFor, introOf };
