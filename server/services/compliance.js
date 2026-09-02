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
// THREE OUTCOMES, NOT TWO. "We hold no date of birth for this athlete" and "we
// could not read this athlete at all" are different facts and need different
// responses, and collapsing them is how an empty roster table survived: every
// pitch held on unknown age, which is exactly what a correctly-working gate over
// a roster with no birthdays looks like. Indistinguishable, so nobody looked.
//
//   known:true                      an age we can act on
//   known:false, reason:'absent'    we read the athlete, there is no dob -> HOLD
//   known:false, reason:'unreadable' we could not read the athlete -> ERROR
//
// `reason` is also set for a dob we hold but cannot parse, because a corrupt
// value is a fault to fix rather than a blank to fill.
function ageFrom(dob, now, opts = {}) {
  // The caller could not produce an athlete record at all. Not the same as an
  // athlete with no birthday on file.
  if (opts.sourceUnreadable) {
    return { known: false, minor: null, years: null, reason: 'unreadable',
      detail: opts.sourceDetail || 'the athlete record could not be read' };
  }
  if (dob === undefined || dob === null || dob === '') {
    // ── THE ATTESTATION, WHEN THERE IS NO BIRTHDAY ─────────────────────────
    //
    // Requiring a date of birth meant every new athlete was held on every
    // restricted category until an agent went and found a birthday, which for a
    // roster of 45 is a wall between signing a client and doing anything for
    // them. The agent knows whether their own client is eighteen; they do not
    // always know the date.
    //
    // A DOB STILL WINS when we have one -- it is checkable and this is not, so
    // this only ever fills a gap, never overrides. `source` travels with the
    // answer so the compliance log records WHICH kind of evidence decided a
    // send, and an attested adult can be told apart from a verified one later.
    //
    // What this does NOT do is open the hard categories. Every restricted
    // category's `adult` severity is 'hold' or 'block', never 'pass', so an
    // attested adult still gets a human decision on alcohol, tobacco, cannabis,
    // gambling and firearms. It moves them from block to hold, not to send.
    if (opts.over18 === true) {
      return { known: true, minor: false, years: null, reason: null, source: 'attested' };
    }
    // An explicit "no" is stronger information than silence and is treated as
    // such: a known minor, blocked outright rather than merely held.
    if (opts.over18 === false) {
      return { known: true, minor: true, years: null, reason: null, source: 'attested' };
    }
    return { known: false, minor: null, years: null, reason: 'absent' };
  }
  const d = new Date(dob);
  const bad = (why) => ({ known: false, minor: null, years: null, reason: 'unreadable', detail: why });
  if (isNaN(d.getTime())) return bad(`the stored date of birth (${String(dob).slice(0, 32)}) is not a date`);
  const ref = now ? new Date(now) : new Date();
  if (d.getTime() > ref.getTime()) return bad('the stored date of birth is in the future');
  let years = ref.getUTCFullYear() - d.getUTCFullYear();
  const m = ref.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < d.getUTCDate())) years--;
  if (years < 0 || years > 120) return bad(`the stored date of birth implies an age of ${years}`);
  // A real date, so `source` says so -- the attestation above never reaches here.
  return { known: true, minor: years < 18, years, reason: null, source: 'dob' };
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

    const age = ageFrom(ctx.dob, ctx.now, {
      sourceUnreadable: !!ctx.athleteUnreadable,
      sourceDetail: ctx.athleteUnreadableDetail,
      // The agent's over-18 answer, used only when no date of birth is on file.
      over18: ctx.over18,
    });

    // ── THE SOURCE ITSELF IS BROKEN. ERROR, NOT HOLD. ───────────────────────
    // A hold says "a person needs to decide". Nobody can decide anything about
    // an athlete we cannot read, and a queue of holds that all say "unknown age"
    // is indistinguishable from a roster where nobody has entered a birthday --
    // which is precisely how an empty roster table went unnoticed. This is a
    // fault to fix, so it is reported as one and it stops the send either way.
    if (age.reason === 'unreadable') {
      return {
        decision: 'block',
        findings: [{
          ruleKey: 'source-unreadable',
          ruleLabel: 'the athlete record could not be read',
          severity: 'block',
          reason: `${age.detail || 'the athlete record could not be read'}. This is not a `
            + 'missing birthday, it is a broken read: nothing can be decided about this '
            + 'athlete until it is fixed. Nothing was sent.',
        }],
        unchecked: UNCHECKED, rulesVersion: RULES_VERSION, ranAt: new Date(),
        sourceError: true,
      };
    }

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
    // AGENT-SUPPLIED SCHOOL RESTRICTIONS. The agent ticked this category on the
    // athlete, saying their school forbids it. We did not check with the school
    // and this never claims we did -- but a stated restriction is a block, not a
    // hold: the agent already made the decision when they ticked it, and asking
    // them to re-approve their own rule every time is not a safeguard.
    const stated = new Set(Array.isArray(ctx.schoolRestrictions)
      ? ctx.schoolRestrictions.map((x) => String(x).toLowerCase()) : []);

    for (const h of cls.hits) {
      if (stated.has(h.key)) {
        findings.push({
          ruleKey: 'school-restricted-' + h.key,
          ruleLabel: h.label + ' — restricted by the school',
          severity: 'block',
          source: 'agent',
          reason: `${brandName} looks like ${h.why} — ${h.basis}. You recorded that `
            + `${ctx.school || 'this athlete\'s school'} restricts this category. `
            + 'That came from you, not from the school — we hold no school policy data and did not check.',
        });
        decision = worst(decision, 'block');
        continue;   // the school rule is the stricter answer; do not also file the age one
      }
      let sev = severityFor(h.key, age);
      // A STATE RULE CAN TIGHTEN, NEVER LOOSEN. If the table says this state
      // blocks the category, that wins. If it says 'allow', the category table's
      // answer still stands: a state permitting alcohol advertising says nothing
      // about whether this athlete's school does, and we hold no school policy.
      // The only thing 'allow' changes is what the record says.
      const sRule = ctx.stateRule && ctx.stateRule[h.key];
      let stateNote = null;
      if (sRule) {
        const stateSev = age.known && age.minor ? sRule.minor_rule : sRule.adult_rule;
        if (stateSev !== 'allow') sev = worst(sev, stateSev);
        stateNote = ` ${sRule.state_code} rule: ${sRule.citation}`
          + (sRule.confidence === 'verify' ? ' (marked for verification)' : '')
          + `, checked ${new Date(sRule.date_checked).toISOString().slice(0, 10)}.`;
      }
      const who = age.known
        ? (age.minor ? `${ctx.athleteName || 'This athlete'} is ${age.years}, a minor`
                     : `${ctx.athleteName || 'This athlete'} is ${age.years}`)
        : `We do not hold a date of birth for ${ctx.athleteName || 'this athlete'}, so we cannot rule out that they are a minor`;
      findings.push({
        ruleKey: 'category-' + h.key,
        ruleLabel: h.label,
        severity: sev,
        source: sRule ? 'state-rule' : 'rule',
        reason: `${brandName} looks like ${h.why} — ${h.basis}. ${who}.`
          + (stateNote || '')
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

// ── STATE CATEGORY RULES ─────────────────────────────────────────────────────
// Reads the structured table, never nilStateRules.js. That file is prose written
// to be read by a person; this is a lookup meant to be read by a gate, and the
// two must not be confused.
//
// A MISSING ROW IS NOT PERMISSION. There is deliberately no fallback: no row
// means the gate applies its own category table, which holds. Adding a state
// rule can tighten the outcome for that state, or record that the state
// genuinely allows it -- it can never loosen the gate by being absent.
async function stateRuleFor(pool, stateCode, category) {
  if (!pool || !stateCode || !category) return null;
  try {
    const r = await pool.query(
      `SELECT * FROM state_category_rules
        WHERE state_code = UPPER($1) AND category = LOWER($2) LIMIT 1`, [stateCode, category]);
    return r.rows[0] || null;
  } catch (e) {
    // A table that cannot be read is not a table that says yes.
    console.error('[compliance] state rule lookup failed:', e.message);
    return null;
  }
}

// Resolve the athlete's state from their school, using the SAME resolution the
// rest of the app uses. Returns null when it does not resolve, and null means
// no state rule applies -- which leaves the category table's answer standing.
function stateCodeForSchool(school) {
  if (!school) return null;
  try {
    const { stateCodeFromText } = require('../nilStateRules');
    const ai = require('../ai');
    const loc = ai.lookupSchoolLocation ? ai.lookupSchoolLocation(String(school)) : null;
    if (loc && loc.state) return stateCodeFromText(loc.state);
    return stateCodeFromText(String(school));
  } catch (_) { return null; }
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
            // WHERE THE RULE CAME FROM. 'agent' means a person ticked a box on
            // the athlete; 'rule' means a category table in this codebase. A
            // record that cannot tell those apart is a record that lets an
            // agent's own note be read back as something we verified.
            source: f.source || 'rule',
            schoolRestrictions: Array.isArray(ctx.schoolRestrictions) ? ctx.schoolRestrictions : [],
            dob: ctx.dob ? 'on file' : null,      // the VALUE never goes in the log
            // WHICH kind of evidence decided this, so an attested adult is never
            // mistaken for a verified one when someone audits a send later.
            age: ageFrom(ctx.dob, ctx.now, { over18: ctx.over18 }),
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
  stateRuleFor, stateCodeForSchool,
  prepareDisclosureFiling,
};
