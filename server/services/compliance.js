'use strict';
// ── THE COMPLIANCE GATE ──────────────────────────────────────────────────────
//
// WHAT THIS IS: a deterministic pre-send gate. Rules are lookups, never
// judgments. No model decides whether something is compliant. A model may have
// classified a business category upstream; the rule that says a minor cannot
// promote alcohol is a table, and it lives here.
//
// WHAT IT IS NOT: it is not a legal opinion, and it does not check the six things
// we hold no data for. Every one of those is named in UNCHECKED below and
// surfaced on the record, because a check that silently passes is worse than no
// check at all -- it manufactures confidence nobody earned.
//
// ── WHAT WE CAN ACTUALLY VERIFY, AND FROM WHERE ─────────────────────────────
//
// VERIFIABLE (these are the rules below):
//
//   Business category
//     brand_evidence_cache, lane='places', evidence->'types' and ->>'primaryType'
//     Google Places types, persisted per brand+region by placesLookup.js.
//     COMPLETENESS: only for brands that got a Places lookup. A brand with no
//     row cannot be classified, and that is a HOLD, never a pass. Types are also
//     imperfect -- a bar typed `restaurant` classifies as a restaurant -- so a
//     name-marker pass runs alongside the type check. Both can only ever raise
//     severity, never lower it.
//
//   Athlete age, WHEN the agent has entered a date of birth
//     athletes.data->>'dob'. This field did not exist before this gate; nothing
//     backfills it. An athlete without one is UNKNOWN, and unknown age against a
//     restricted category is a HOLD. It is never assumed to be an adult.
//
//   Whether the gate could run at all
//     Fail closed. A throw, an unreachable database, a missing athlete -- all of
//     them hold. See evaluate()'s catch.
//
// NOT VERIFIABLE -- deliberately absent rather than approximated:
//
//   The athlete's school policy
//     No table, no column, no field anywhere in this codebase. Most policies sit
//     behind a school login. We cannot read them, so there is no rule here that
//     pretends to.
//
//   Conflicts with the school's existing sponsors
//     outreach_queue.sponsor_signal is OUR OWN deal history at that school (see
//     scout.js schoolSponsorSignals). It is a ranking boost. It is not the
//     school's multimedia-rights sponsor roster, and using it as one would flag
//     the wrong businesses and miss every real conflict.
//
//   State restricted-category rules
//     nilStateRules.js covers 51 jurisdictions but contains agent registration,
//     NIL statute framing, high-school association pointers and the disclosure
//     threshold. It contains ZERO category rules -- not one mention of alcohol,
//     tobacco, cannabis, gambling, firearms, adult or supplements. Only 6 of 51
//     entries are marked "confident"; the other 45 say in their own text to
//     verify the current rule. It is a reference layer, not a rule engine, so it
//     is ATTACHED to a hold as context and never used to decide one.
//
//   Disclosure thresholds as a send gate
//     The $600 House-settlement NIL Go threshold is real and is in
//     nilStateRules.NIL_GO_THRESHOLD. But at send time there is no deal and no
//     value -- the pitch has not been agreed. Disclosure is a post-agreement
//     duty, so it is prepared in prepareDisclosureFiling() against a CLOSED deal,
//     not enforced against an outbound email.
//
// FILING IS OUT OF SCOPE. We prepare, the agent submits.

const RULES_VERSION = '2026-08-1';

// Named so the record can say what was NOT looked at. Rendered with every hold.
const UNCHECKED = [
  'school policy — we hold no school NIL policy data',
  'conflicts with the school\'s existing sponsors — we hold no sponsor roster',
  'state category rules — the state layer carries no category restrictions',
];

// ── THE CATEGORY TABLE ───────────────────────────────────────────────────────
// placesTypes: Google Places types. nameMarkers: word-boundary matched against
// the business name, for the cases Google types miss (cannabis has no type at
// all; a bar is frequently typed `restaurant`).
//
// minor / adult: the severity when the athlete is known to be under 18, and when
// they are known to be 18 or over. Unknown age never uses the adult column --
// see severityFor().
const CATEGORIES = [
  {
    key: 'alcohol', label: 'alcohol',
    placesTypes: ['bar', 'liquor_store', 'night_club', 'brewery', 'wine_bar', 'pub'],
    nameMarkers: ['brewery', 'brewing', 'distillery', 'winery', 'wine', 'liquor', 'spirits',
      'taproom', 'tap room', 'alehouse', 'ale house', 'saloon', 'cantina', 'pub', 'tavern'],
    // Promoting alcohol as a minor is not a policy question.
    minor: 'block', adult: 'hold',
    why: 'alcohol',
  },
  {
    key: 'tobacco', label: 'tobacco, vaping or nicotine',
    placesTypes: ['tobacco_shop'],
    nameMarkers: ['tobacco', 'cigar', 'cigarette', 'vape', 'vapor', 'smoke shop', 'smokeshop', 'hookah'],
    minor: 'block', adult: 'hold',
    why: 'tobacco or nicotine',
  },
  {
    key: 'cannabis', label: 'cannabis, THC or CBD',
    // Google publishes no cannabis type; the name is all we have.
    placesTypes: [],
    nameMarkers: ['cannabis', 'marijuana', 'dispensary', 'thc', 'cbd', 'hemp', 'kratom', 'kava'],
    minor: 'block', adult: 'hold',
    why: 'cannabis or a related product',
  },
  {
    key: 'gambling', label: 'gambling or sports betting',
    placesTypes: ['casino'],
    nameMarkers: ['casino', 'sportsbook', 'sports book', 'betting', 'wager', 'poker', 'lottery'],
    // Athlete endorsement of sports betting is prohibited by the NCAA for every
    // athlete, not only minors.
    minor: 'block', adult: 'block',
    why: 'gambling or sports betting',
  },
  {
    key: 'firearms', label: 'firearms',
    placesTypes: ['gun_store'],
    nameMarkers: ['firearm', 'firearms', 'gun', 'guns', 'ammo', 'ammunition', 'rifle', 'pistol', 'shooting range'],
    minor: 'block', adult: 'hold',
    why: 'firearms',
  },
  {
    key: 'adult', label: 'adult entertainment',
    placesTypes: ['adult_entertainment_store', 'strip_club'],
    nameMarkers: ['adult', 'strip club', 'gentlemen', 'gentlemens', 'escort', 'xxx'],
    // Prohibited under a school's name at any age.
    minor: 'block', adult: 'block',
    why: 'adult entertainment',
  },
  {
    key: 'supplements', label: 'supplements',
    placesTypes: [],
    nameMarkers: ['supplement', 'supplements', 'nutraceutical', 'sarms', 'peptide', 'pre-workout', 'preworkout'],
    // Not illegal, but NCAA banned-substance exposure sits on the athlete at any
    // age. A human decides.
    minor: 'hold', adult: 'hold',
    why: 'supplements, which carry NCAA banned-substance risk',
  },
];

const CATEGORY_BY_KEY = {};
for (const c of CATEGORIES) CATEGORY_BY_KEY[c.key] = c;

// Word-boundary match, so "gun" does not fire on "Burgundy" and "adult" does not
// fire on "Adulthood Coffee". Multi-word markers keep their spaces.
function _marks(name, markers) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  for (const mk of markers) {
    const re = new RegExp('\\b' + mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i');
    if (re.test(s)) return mk;
  }
  return null;
}

// Classify a business. Returns EVERY category it hits, because a business can be
// both (a brewery with a shooting range is not a hypothetical in this market).
//
// `evidence` is the lane='places' evidence JSONB, or null when we have no row --
// and null is the case that must never read as clean.
function classifyBusiness(brandName, evidence) {
  const types = (evidence && Array.isArray(evidence.types) ? evidence.types : [])
    .concat(evidence && evidence.primaryType ? [evidence.primaryType] : [])
    .map((t) => String(t).toLowerCase());
  const hits = [];
  for (const c of CATEGORIES) {
    const byType = types.find((t) => c.placesTypes.indexOf(t) !== -1) || null;
    const byName = _marks(brandName, c.nameMarkers);
    if (byType || byName) {
      hits.push({
        key: c.key, label: c.label, why: c.why,
        basis: byType ? `Google Places type "${byType}"` : `the business name contains "${byName}"`,
      });
    }
  }
  return {
    hits,
    // THE DISTINCTION THAT MATTERS. "We looked and found nothing restricted" and
    // "we could not look" are different answers, and only the first is a pass.
    classified: !!(evidence && (types.length || evidence.found === true)),
    types,
  };
}

// ── AGE ──────────────────────────────────────────────────────────────────────
// Returns { known, minor, years } and never guesses. An unparseable or absent
// date of birth is known:false, which the severity table treats as its own case
// rather than as an adult.
function ageFrom(dob, now) {
  if (!dob) return { known: false, minor: null, years: null };
  const d = new Date(dob);
  if (isNaN(d.getTime())) return { known: false, minor: null, years: null };
  const ref = now ? new Date(now) : new Date();
  if (d.getTime() > ref.getTime()) return { known: false, minor: null, years: null };
  let years = ref.getUTCFullYear() - d.getUTCFullYear();
  const m = ref.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < d.getUTCDate())) years--;
  if (years < 0 || years > 120) return { known: false, minor: null, years: null };
  return { known: true, minor: years < 18, years };
}

// The severity table. Unknown age is ITS OWN ROW and always at least a hold: we
// will not send a minor an alcohol pitch because nobody filled in a birthday.
function severityFor(category, age) {
  const c = CATEGORY_BY_KEY[category];
  if (!c) return 'hold';
  if (!age.known) {
    // Never softer than the adult severity, never harder than a block.
    return c.adult === 'block' ? 'block' : 'hold';
  }
  return age.minor ? c.minor : c.adult;
}

// 'pass' MUST be in this table. It was not, and the consequence was the exact
// failure this gate exists to prevent: RANK['pass'] was undefined, every
// `RANK[b] > undefined` comparison was false, so worst() returned 'pass' no
// matter what it was given. The rules all fired, the findings were all correct,
// every severity was right -- and evaluate() returned "pass" on alcohol to a
// 16-year-old. A missing key in a lookup table is how a gate silently opens.
const RANK = { pass: -1, note: 0, hold: 1, block: 2 };
const worst = (a, b) => {
  // An unknown severity is treated as the most severe thing we know, never as
  // the least. A typo in a rule must not be a way through.
  if (!(a in RANK)) return 'block';
  if (!(b in RANK)) return 'block';
  return RANK[b] > RANK[a] ? b : a;
};

// ── EVALUATE ─────────────────────────────────────────────────────────────────
// The only entry point the send path calls. FAILS CLOSED: every path that is not
// an explicit, successful pass returns a hold or a block. It cannot throw.
//
// facts in: { brandName, evidence, dob, athleteName, school, stateCode }
async function evaluate(pool, ctx) {
  const findings = [];
  let decision = 'pass';
  try {
    const brandName = String((ctx && ctx.brandName) || '').trim();
    if (!brandName) {
      return _closed('no-brand', 'this outreach has no business name on it, so nothing could be checked');
    }

    const age = ageFrom(ctx.dob, ctx.now);
    const cls = classifyBusiness(brandName, ctx.evidence);

    // 1. WE COULD NOT LOOK. Not a pass.
    if (!cls.classified && !cls.hits.length) {
      findings.push({
        ruleKey: 'category-unknown',
        ruleLabel: 'business category could not be verified',
        severity: 'hold',
        reason: `We hold no Google Places record for ${brandName}, so its category could not be `
          + 'checked against the restricted list. Confirm what this business does before it goes out.',
      });
      decision = worst(decision, 'hold');
    }

    // 2. RESTRICTED CATEGORIES.
    for (const h of cls.hits) {
      const sev = severityFor(h.key, age);
      const who = age.known
        ? (age.minor ? `${ctx.athleteName || 'This athlete'} is ${age.years}, a minor`
                     : `${ctx.athleteName || 'This athlete'} is ${age.years}`)
        : `We do not hold a date of birth for ${ctx.athleteName || 'this athlete'}, so we cannot rule out that they are a minor`;
      findings.push({
        ruleKey: 'category-' + h.key,
        ruleLabel: h.label,
        severity: sev,
        reason: `${brandName} looks like ${h.why} — ${h.basis}. ${who}.`
          + (sev === 'block'
            ? ' This cannot be sent.'
            : ' A person needs to decide whether this is appropriate under the school\'s policy, which we do not hold.'),
      });
      decision = worst(decision, sev);
    }

    // 3. AGE UNKNOWN, on its own, is a note. It only becomes a hold when it
    //    meets a restricted category above -- an unknown birthday is not a
    //    reason to stop a pitch to a coffee shop.
    if (!age.known && !cls.hits.length) {
      findings.push({
        ruleKey: 'dob-missing', ruleLabel: 'date of birth not on file', severity: 'note',
        reason: `No date of birth for ${ctx.athleteName || 'this athlete'}. Nothing here needs it, `
          + 'but a restricted-category business would be held until it is entered.',
      });
      decision = worst(decision, 'note');
    }

    return { decision, findings, unchecked: UNCHECKED, rulesVersion: RULES_VERSION, ranAt: new Date() };
  } catch (e) {
    // FAIL CLOSED. A gate that throws must not become a gate that waves through.
    return _closed('gate-error', 'the compliance gate could not complete: ' + e.message);
  }
}

function _closed(ruleKey, reason) {
  return {
    decision: 'hold',
    findings: [{ ruleKey, ruleLabel: 'the check could not run', severity: 'hold', reason }],
    unchecked: UNCHECKED, rulesVersion: RULES_VERSION, ranAt: new Date(), failedClosed: true,
  };
}

// ── THE RECORD ───────────────────────────────────────────────────────────────
// Every hold, block and note is written. This is the product: an agent asking
// "why did this not send" nine months later, and a school or a state asking the
// same question, both get the same answer from the same rows.
async function recordFindings(pool, ctx, result) {
  const ids = [];
  for (const f of result.findings) {
    try {
      const r = await pool.query(
        `INSERT INTO compliance_holds
           (agent_id, athlete_id, outreach_log_id, brand_name, brand_key,
            rule_key, rule_label, severity, reason, facts, rules_version, unchecked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)
         -- IDEMPOTENT. releaseDue re-evaluates every tick, so a held draft would
         -- otherwise write an identical row every fifteen minutes forever. The
         -- FIRST record of a hold is the one that counts; re-running the gate is
         -- not a new event.
         ON CONFLICT (outreach_log_id, rule_key) WHERE resolved_at IS NULL DO NOTHING
         RETURNING id`,
        [ctx.agentId || null, ctx.athleteId || null, ctx.outreachLogId || null,
          ctx.brandName || null, ctx.brandKey || null,
          f.ruleKey, f.ruleLabel, f.severity, f.reason,
          JSON.stringify({
            dob: ctx.dob ? 'on file' : null,      // the VALUE never goes in the log
            age: ageFrom(ctx.dob, ctx.now),
            placesTypes: (ctx.evidence && ctx.evidence.types) || null,
            school: ctx.school || null, stateCode: ctx.stateCode || null,
            failedClosed: !!result.failedClosed,
          }),
          result.rulesVersion, JSON.stringify(result.unchecked)]);
      // No row back means one is already open for this rule, which is the
      // intended outcome, not a failure.
      if (r.rows[0]) ids.push(r.rows[0].id);
    } catch (e) {
      console.error('[compliance] could not record a finding:', e.message);
      // A record that failed to write must not turn into a send. The caller
      // treats a throw here as a hold.
      throw e;
    }
  }
  return ids;
}

// An agent clearing a hold. Blocks are not overridable and the query enforces it
// rather than the caller remembering to.
async function overrideHold(pool, holdId, { agentId, reason }) {
  const why = String(reason || '').trim();
  if (why.length < 10) return { ok: false, error: 'Say why, in a sentence. This goes on the record.' };
  const r = await pool.query(
    `UPDATE compliance_holds
        SET resolved_at = NOW(), resolved_by = $2, resolution = 'overridden', resolution_reason = $3
      WHERE id = $1 AND agent_id = $2 AND resolved_at IS NULL AND severity = 'hold'
      RETURNING id, brand_name, rule_label`, [holdId, agentId, why]);
  if (!r.rowCount) {
    const cur = await pool.query(
      `SELECT severity, resolved_at FROM compliance_holds WHERE id = $1 AND agent_id = $2`, [holdId, agentId]);
    const row = cur.rows[0];
    if (!row) return { ok: false, error: 'No such hold.' };
    if (row.severity === 'block') {
      return { ok: false, error: 'This is a hard block and cannot be overridden. Cancel the outreach instead.' };
    }
    if (row.resolved_at) return { ok: false, error: 'That hold was already resolved.' };
    return { ok: false, error: 'That hold could not be resolved.' };
  }
  return { ok: true, hold: r.rows[0] };
}

async function cancelHold(pool, holdId, { agentId, reason }) {
  const r = await pool.query(
    `UPDATE compliance_holds
        SET resolved_at = NOW(), resolved_by = $2, resolution = 'cancelled', resolution_reason = $3
      WHERE id = $1 AND agent_id = $2 AND resolved_at IS NULL
      RETURNING id`, [holdId, agentId, String(reason || 'the agent cancelled this outreach').slice(0, 500)]);
  return { ok: !!r.rowCount };
}

// Is this outreach clear to send RIGHT NOW? Reads the record rather than
// re-deriving, so an override actually takes effect and a block cannot be walked
// past by re-running the gate.
// Rules an agent has already decided for THIS outreach. Without this an override
// is theatre: the hold resolves, the gate re-runs on the next tick, re-derives
// the identical finding from the identical data and holds again forever. An
// override is a decision about a rule on a message, so it is remembered as one.
//
// Scoped to (log, rule). Overriding "we could not classify Mystery Co" does not
// clear an alcohol finding on the same message, and does not clear anything at
// all on a different message.
async function overriddenRulesFor(pool, outreachLogId) {
  const r = await pool.query(
    `SELECT DISTINCT rule_key FROM compliance_holds
      WHERE outreach_log_id = $1 AND resolution = 'overridden'`, [outreachLogId]);
  return new Set(r.rows.map((x) => x.rule_key));
}

async function openHoldsFor(pool, outreachLogId) {
  const r = await pool.query(
    `SELECT id, rule_key, rule_label, severity, reason, created_at
       FROM compliance_holds
      WHERE outreach_log_id = $1 AND resolved_at IS NULL AND severity IN ('hold','block')
      ORDER BY CASE severity WHEN 'block' THEN 0 ELSE 1 END, id`, [outreachLogId]);
  return r.rows;
}

// ── DISCLOSURE: PREPARED, NOT FILED ──────────────────────────────────────────
// Triggered by a CLOSED deal at or over the House-settlement threshold, not by an
// email. We produce what the agent pastes into the school's portal. We never
// submit -- almost every school requires a login we do not have and should not
// have.
function prepareDisclosureFiling(deal, athlete, stateRef) {
  const { NIL_GO_THRESHOLD, DISCLAIMER } = require('../nilStateRules');
  const value = Number(String((deal && deal.value) || '0').replace(/[^0-9.]/g, '')) || 0;
  if (value < NIL_GO_THRESHOLD) {
    return { required: false, threshold: NIL_GO_THRESHOLD, value,
      note: `$${value} is under the $${NIL_GO_THRESHOLD} threshold, so no NIL Go submission is triggered. `
        + 'The school may still require its own disclosure — check its policy.' };
  }
  return {
    required: true, threshold: NIL_GO_THRESHOLD, value,
    filing: {
      athlete: athlete && athlete.name, school: athlete && athlete.school,
      brand: deal && deal.brand, amount: value,
      closedAt: (deal && deal.closedAt) || null,
      basis: 'House v. NCAA settlement (2025), NIL Go clearinghouse',
    },
    // Said plainly, because an agent who believes we filed it will not file it.
    submission: 'NILDash does not submit this. Your school files NIL disclosures through its own '
      + 'portal, which requires your athlete\'s login. Copy this into that portal.',
    stateReference: stateRef || null,
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  RULES_VERSION, UNCHECKED, CATEGORIES, CATEGORY_BY_KEY,
  classifyBusiness, ageFrom, severityFor, evaluate,
  recordFindings, overrideHold, cancelHold, openHoldsFor, overriddenRulesFor,
  prepareDisclosureFiling,
};
