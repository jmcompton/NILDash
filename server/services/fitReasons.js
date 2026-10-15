'use strict';
// ── WHY THIS ATHLETE FITS THIS BRAND (MARKET_MIX_ON) ────────────────────────
//
// Every social and national pitch says why this athlete fits this brand, from
// what we found, never from what a brand like this probably wants:
//
//   past campaigns  a logged NIL deal with a source (deal_comps), or the
//                   brand's verified athlete program (social_brands)
//   audience        the athlete's reach falls inside the follower range the
//                   brand's program states; the connected Instagram's own
//                   numbers when there is one
//   sport           the program lists the athlete's sport, or the brand signed
//                   an athlete in it
//   region          the brand signed an athlete at a school in the athlete's
//                   state, or company research places it there
//
// Two outputs. `lines` are facts about the BRAND, handed to the writer as its
// evidence (pitchWriter: the only things a message may say about a business,
// one of them, stated as written). They carry no follower numbers and no
// other athlete's sport, so the writer's own fact check cannot read them as
// claims about our athlete. `reasons` is the pairing, for the card and the
// dry run: brand fact and athlete fact side by side.
//
// No brand fact, no card: researched() is false and the job skips the brand
// before writing. After writing, statesFit() requires the message to state
// one of the lines (the writer reports which; pitchWriter.checkEvidence
// holds it to it), so a pitch that says nothing about the brand is refused.
// The writer and its model are untouched: this only chooses what it is given.

const fold = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthOf(d) {
  if (!d) return null;
  const x = new Date(d);
  return isNaN(x.getTime()) ? null : `${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return null; } }
const fmtN = (n) => Number(n).toLocaleString('en-US');

// The sport words, matched the way the writer matches them: "women's
// basketball" and "basketball" are the same sport for this purpose.
function sportKey(s) {
  const f = fold(s).replace(/\b(mens|womens|men|women|ncaa|college|varsity)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (/track|cross country/.test(f)) return 'track';
  if (/swim|diving/.test(f)) return 'swimming';
  return f;
}
function stateOfSchool(school) {
  if (!school) return null;
  try {
    const r = require('./schoolResolver').resolveSchool(school);
    if (r && r.state) return require('./schoolResolver').stateCode(r.state);
  } catch (_) { /* unknown */ }
  return null;
}

// cand: the slate candidate (programFacts, signingEvidence from
// services/signingEvidence). athlete: services/athleteRecord's record.
// extra: { verifiedIg (instagramInsights.verifiedFor), enrichment: { location } }
// -> { lines, reasons, kinds }
function build(cand, athlete, extra = {}) {
  const c = cand || {};
  const a = athlete || {};
  const lines = [], reasons = [];
  const kinds = new Set();
  const push = (line, reason, kind) => {
    if (line && lines.length < 3 && !lines.some((l) => l.toLowerCase() === line.toLowerCase())) lines.push(line);
    if (reason) reasons.push(reason);
    if (kind) kinds.add(kind);
  };
  const aSport = sportKey(a.sport);
  const aState = a.stateCode || null;
  const reach = (Number(a.instagram) || 0) + (Number(a.tiktok) || 0);
  const ev = Array.isArray(c.signingEvidence) ? c.signingEvidence : [];

  // ── PAST CAMPAIGNS: THEIR PROGRAM ───────────────────────────────────────
  const prog = ev.find((e) => e && e.kind === 'program');
  if (prog) {
    const when = monthOf(prog.date);
    push(`Runs an athlete program whose stated follower range takes athletes at this level${when ? ` (verified ${when})` : ''}`,
      `Audience: ${reach ? fmtN(reach) + ' followers' : 'the athlete\'s following'} is inside the ${fmtN(prog.range[0])}-${fmtN(prog.range[1])} range their program states (${hostOf(prog.source) || 'their program page'}${when ? ', ' + when : ''})`,
      'audience');
  } else if (c.tierStated && Number(c.tierMax) > 0 && reach && reach >= Number(c.tierMin || 0) && reach <= Number(c.tierMax)) {
    push('Runs an athlete program whose stated follower range takes athletes at this level',
      `Audience: ${fmtN(reach)} followers is inside the ${fmtN(c.tierMin)}-${fmtN(c.tierMax)} range their program states`, 'audience');
  }
  // ── PAST CAMPAIGNS: ATHLETES THEY SIGNED ────────────────────────────────
  for (const d of ev.filter((e) => e && e.kind === 'deal').slice(0, 2)) {
    const same = !!(aSport && d.sport && sportKey(d.sport) === aSport);
    const when = monthOf(d.date);
    const who = d.athlete || 'a college athlete';
    // Another athlete's sport is named only when it is ours: the writer's
    // fact check refuses any other sport in the message.
    push(`Signed ${who}${same ? `, a ${String(a.sport).toLowerCase()} athlete,` : ''}${d.school ? ` at ${d.school}` : ''}${when ? ` in ${when}` : ''}`,
      `Past campaign: signed ${who}${d.sport ? ` (${d.sport}${d.school ? ', ' + d.school : ''}${d.followers ? ', ' + fmtN(d.followers) + ' followers' : ''})` : (d.school ? ` (${d.school})` : '')}${when ? ' in ' + when : ''}, per ${hostOf(d.source) || d.source}`,
      'campaign');
    if (same) { reasons.push(`Sport: they signed a ${String(a.sport).toLowerCase()} athlete`); kinds.add('sport'); }
    const dState = stateOfSchool(d.school);
    if (aState && dState && dState === aState && d.school) {
      reasons.push(`Region: they signed an athlete at ${d.school}, in the athlete's state (${aState})`);
      kinds.add('region');
    }
  }
  // ── SPORT: THE PROGRAM LISTS IT ─────────────────────────────────────────
  const sports = Array.isArray(c.sports) ? c.sports.map(sportKey).filter(Boolean) : [];
  if (aSport && sports.length && !sports.includes('all') && sports.includes(aSport)) {
    push(`Their athlete program lists ${String(a.sport).toLowerCase()} among the sports it signs`,
      `Sport: their program lists ${String(a.sport).toLowerCase()}`, 'sport');
  }
  // ── REGION: COMPANY RESEARCH ────────────────────────────────────────────
  const loc = extra.enrichment && extra.enrichment.location;
  if (loc && aState) {
    let st = null;
    try { st = require('./athleteRecord').cityStateFrom(loc).state; st = st ? require('./schoolResolver').stateCode(st) : null; } catch (_) { st = null; }
    if (st && st === aState) {
      push(`Based in ${loc}`, `Region: based in ${loc}, the athlete's state (company research)`, 'region');
    }
  }
  // ── THEIR OFFER, AS THE PROGRAM PAGE STATES IT ──────────────────────────
  if (typeof c.offerSummary === 'string' && c.offerSummary.trim() && !/\d{1,3}(,\d{3})+|\d{4,}/.test(c.offerSummary)) {
    push(c.offerSummary.trim().replace(/[.;\s]+$/, ''), null, null);
  }
  // ── THE ATHLETE'S SIDE ──────────────────────────────────────────────────
  const v = extra.verifiedIg;
  if (v && v.followers) {
    reasons.push(`Audience: ${fmtN(v.followers)} Instagram followers from the connected account (${v.asOf})`
      + (v.avgReachPerPost ? `, about ${fmtN(v.avgReachPerPost)} reached per post` : ''));
  }
  return { lines, reasons, kinds: [...kinds] };
}

// A brand fact we found, not just an offer summary or the athlete's own numbers.
function researched(fit) { return !!(fit && fit.kinds && fit.kinds.length && fit.lines.length); }

// After the writer: did the message state one of the fit lines?
// pitch: writePitch's result (evidenceUsed is the line it stated, checked).
function statesFit(pitch, fit) {
  if (!pitch || !pitch.message || !fit || !fit.lines.length) return { ok: false, why: 'no fit line to state' };
  const used = Number(pitch.evidenceUsed) || 0;
  if (used >= 1 && used <= fit.lines.length) return { ok: true, line: fit.lines[used - 1] };
  return { ok: false, why: 'the pitch does not say why this athlete fits the brand (it states none of the researched facts)' };
}

// The reads build() needs, for one brand and one athlete. Never throws.
async function research(pool, { cand, athlete, athleteId, agentId }) {
  const extra = {};
  // The profile already carries the connected Instagram's numbers when the job
  // read them (jobs/outreachQueue.localContextFor); otherwise read them here.
  if (athlete && athlete.igVerified !== undefined) extra.verifiedIg = athlete.igVerified;
  else { try { extra.verifiedIg = await require('./instagramInsights').verifiedFor(pool, athleteId); } catch (_) { extra.verifiedIg = null; } }
  try {
    const r = await pool.query(`SELECT location FROM company_enrichment WHERE LOWER(brand_name) = LOWER($1) AND location IS NOT NULL
                                 ORDER BY (agent_id = $2) DESC, enriched_at DESC LIMIT 1`, [cand.brand_name, agentId || '']);
    extra.enrichment = r.rows[0] || null;
  } catch (_) { extra.enrichment = null; }
  return build(cand, athlete, extra);
}

// A local card's fit, for the card and the dry run: the town (the local lane
// only draws businesses where the athlete lives, or their hometown), the one
// marketing-activity line the pitch stated, and a deal reported at the school.
function localReasons(cand, athlete, pitch) {
  const c = cand || {}, a = athlete || {};
  const out = [];
  if (c.hometown) out.push(`Region: in ${c.hometown}, the athlete's hometown`);
  else if (a.market) out.push(`Region: in ${a.market}, where the athlete goes to school`);
  const used = pitch && Number(pitch.evidenceUsed);
  if (used && Array.isArray(pitch.evidence) && pitch.evidence[used - 1]) out.push(`Their marketing: ${pitch.evidence[used - 1]}`);
  const sig = c.sponsorSignal;
  if (sig && sig.kind === 'reported-deal-at-school' && sig.detail) out.push(`Past campaign: ${sig.detail}`);
  return out;
}

module.exports = { build, research, researched, statesFit, sportKey, localReasons };
