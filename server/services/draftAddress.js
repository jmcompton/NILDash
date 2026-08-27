'use strict';
// ── THE ADDRESS THE DRAFT NEVER CARRIED ──────────────────────────────────────
//
// 115 of 120 drafts were skipped by the Closer for "no email address on file",
// while /admin/local-coverage reported 268 of 387 validated businesses WITH a
// working email. Both were true. The addresses exist; they were never written
// onto the outreach row.
//
// draftPrewarm's INSERT names eleven columns and none of them is sent_to_email,
// contact_id or enrichment_id. So every nightly draft was born with no address,
// and the Closer's batch query -- which reads COALESCE(brand_contacts.email,
// outreach_logs.sent_to_email) through a contact_id that is always NULL --
// correctly found nothing, every time.
//
// brand_contacts IS populated, but only on the AI Outreach workflow path
// (workflowOrchestrator), never on the nightly one. So the nightly drafts had no
// route to an address at all.
//
// WHERE THE ADDRESSES ACTUALLY ARE. siteEmail writes them to
// brand_evidence_cache under lane 'siteemail', keyed by site root rather than by
// brand, with the display name in the `brand` column and the address in
// evidence->>'email'. That is the join this file makes.
//
// IT NEVER INVENTS ONE. A brand with no cached address gets null and the draft
// says so; guessing info@<brand>.com would be a fabricated address on a real
// business, and the bounce would land on the agent's own sending reputation.

// A corporate address on a franchise is not the local owner. It is still a real
// address and still worth having, but it is TAGGED so the Closer and the writer
// can treat it differently rather than discovering it at the reply.
function classify(ev) {
  if (!ev) return null;
  if (!ev.email) return null;
  return {
    email: String(ev.email).trim().toLowerCase(),
    kind: ev.corporate ? 'corporate' : (ev.type === 'personal' ? 'personal' : 'generic'),
    corporate: !!ev.corporate,
    sourceUrl: ev.sourceUrl || null,
    formUrl: ev.formUrl || null,
    siteRoot: ev.siteRoot || null,
  };
}

// One query for many brands. Matched on the display name, because the cache key
// is the site root and the outreach row only knows the brand.
async function lookupMany(pool, brands) {
  const names = [...new Set((brands || [])
    .map((b) => String(b || '').trim().toLowerCase()).filter(Boolean))];
  if (!names.length) return new Map();
  const out = new Map();
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (LOWER(brand)) LOWER(brand) AS key, evidence, refreshed_at
         FROM brand_evidence_cache
        WHERE lane = 'siteemail' AND brand IS NOT NULL
          AND LOWER(brand) = ANY($1::text[])
        ORDER BY LOWER(brand), refreshed_at DESC`, [names]);
    for (const row of r.rows) {
      const hit = classify(row.evidence || {});
      if (hit) out.set(row.key, hit);
    }
  } catch (e) {
    console.error('[draftAddress] lookupMany:', e.message);
  }
  return out;
}

async function lookupOne(pool, brand) {
  const m = await lookupMany(pool, [brand]);
  return m.get(String(brand || '').trim().toLowerCase()) || null;
}

// Stamp an address onto rows that have none. Used at draft time and by the
// backfill; both go through here so the two cannot drift.
//
// ONLY WHERE IT IS MISSING. An address already on a row was put there by
// something that knew more than this does -- the workflow path attaches a real
// contact_id -- and must not be overwritten by a site-wide generic inbox.
// opts.athleteId + opts.budget turn on the per-athlete-per-day credit ceiling
// (see verifyBudget.js). opts.deadlineMs bounds the whole verification pass, so
// a caller in front of a page load can never hang on a resolver.
async function attach(pool, opts = {}) {
  const { agentId, ids = null, limit = 500 } = opts;
  // athlete_id comes back now because the credit ceiling is per athlete per day
  // and the backfill spans the whole roster. Without it the Closer's 300-draft
  // pass had no athlete to charge, which is why it ran unbudgeted.
  const rows = (await pool.query(
    `SELECT id, brand_name, athlete_id FROM outreach_logs
      WHERE agent_id = $1
        AND (sent_to_email IS NULL OR sent_to_email = '')
        AND status IN ('draft','approved')
        AND ($2::text[] IS NULL OR id = ANY($2::text[]))
      ORDER BY created_at DESC LIMIT $3`,
    [agentId, ids, limit])).rows;
  if (!rows.length) return { considered: 0, attached: 0, missing: 0, details: [] };

  const found = await lookupMany(pool, rows.map((r) => r.brand_name));
  const out = { considered: rows.length, attached: 0, missing: 0, corporate: 0,
    unverifiable: 0, rejected: 0, creditsSpent: 0, creditsSkipped: 0, details: [] };

  // ── VERIFY BEFORE THE ADDRESS IS EVER STAMPED ON A ROW ────────────────────
  // This is THE place, because it is the single point where an address becomes
  // part of a draft -- the nightly path and the backfill both come through here.
  // Checking at send time instead would mean an agent had already approved an
  // email to a dead mailbox, which is exactly the thing the approve card is
  // supposed to be a decision about.
  //
  // MX first (free, no vendor), then Hunter for whatever cleared it, both
  // cached per address for ninety days so the same local business costs nothing
  // on the second athlete. A verdict of `invalid` means the address is NOT
  // attached: the draft keeps no address, says why, and never reaches a card.
  // `unknown` -- which is what every verifier returns for a catch-all domain,
  // and therefore for a large share of small local businesses -- attaches
  // normally and is marked on the card. Proceed, and say what you do not know.
  let verdicts = new Map();
  let budgetNote = null;
  try {
    const EV = require('./emailVerify');
    const hunter = require('./hunterLookup');
    const emailToBusiness = new Map();
    const emailToAthlete = new Map();
    const addrs = rows.map((r) => {
      const h = found.get(String(r.brand_name || '').trim().toLowerCase());
      if (h && h.email) {
        const a = String(h.email).trim().toLowerCase();
        emailToBusiness.set(a, r.brand_name);
        // First draft to claim an address owns the credit. The same business
        // reached for two athletes is one lookup and one charge, because the
        // verdict caches for ninety days and the second read is free.
        if (r.athlete_id && !emailToAthlete.has(a)) emailToAthlete.set(a, r.athlete_id);
      }
      return h && h.email;
    }).filter(Boolean);
    if (addrs.length) {
      // ── WHAT THIS CALL IS ALLOWED TO SPEND ────────────────────────────────
      //
      // EVERY CALLER, ALWAYS. This used to read
      // `if (opts.athleteId && Number.isFinite(opts.budget))`, and the comment
      // under it argued that the Closer's batch prep was "spending on mail that
      // is about to go out, which is what a credit is for".
      //
      // The argument was wrong twice over. First, the backfill runs on a PAGE
      // LOAD -- GET /api/agent/closer/batch -- not at send time, so it is
      // spending on mail nobody has approved. Second and worse, opting out of
      // the limiter also opted out of the LOG, so up to 300 credits per call
      // were spent and none was counted. hunterLookup's own ceiling could not
      // see them either: it counts brand_evidence_cache lane 'hunter', which is
      // Domain Search, and verification never writes that lane. Four page loads
      // was the month, silently, with every counter in the product reading
      // healthy right up to Hunter's 429.
      //
      // A credit nobody counts is a credit nobody can defend. There is no
      // unbudgeted path now.
      let verifier = (e) => hunter.verifyEmail(e);
      let lim = null;
      {
        const VB = require('./verifyBudget');
        const day = await VB.dayFor(pool, agentId);
        const acct = await VB.accountStatus(pool);
        const perAthleteBudget = Number.isFinite(opts.budget) ? opts.budget : VB.PER_ATHLETE_DAY;

        // One spentToday per athlete in this batch, not per draft.
        const athleteIds = Array.from(new Set(
          [opts.athleteId, ...emailToAthlete.values()].filter(Boolean)));
        const per = new Map();
        let meterFault = null;
        for (const aid of athleteIds) {
          const already = await VB.spentToday(pool, aid, day);
          // NULL MEANS THE LOG COULD NOT BE READ. Not "already spent" -- that
          // conflation is the same defect as accountStatus assigning the cap.
          // We cannot meter, so we do not spend, and we say which it is.
          if (already === null) { meterFault = 'the verification credit log could not be read'; break; }
          per.set(aid, Math.max(0, perAthleteBudget - already));
        }

        const accountLeft = meterFault ? 0 : Math.max(0, acct.remaining || 0);
        lim = VB.limiter(pool, {
          agentId, athleteId: opts.athleteId || null, day,
          perAthlete: per, accountLeft,
          emailToBusiness, emailToAthlete, verifier,
          // Which caller spent it, so the burn report can name the page rather
          // than leaving "where did 300 credits go" to be reconstructed.
          source: opts.source || (opts.athleteId ? 'home' : 'closer-backfill'),
        });
        verifier = lim.verifier;
        const perTotal = Array.from(per.values()).reduce((s, n) => s + n, 0);
        budgetNote = {
          budget: perAthleteBudget, day, athletes: athleteIds.length,
          perAthleteLeft: perTotal, account: acct,
          source: opts.source || (opts.athleteId ? 'home' : 'closer-backfill'),
          meterFault: meterFault || (acct.unknown ? acct.fault : null),
          // Which limit actually bit, so a thin slate can be explained rather
          // than guessed at.
          boundBy: meterFault ? 'meter-fault'
            : acct.unknown ? 'meter-fault'
              : accountLeft < perTotal ? 'account-month' : 'athlete-day',
        };
      }
      verdicts = await EV.verifyMany(pool, addrs, {
        // Injected rather than imported inside emailVerify, so that file never
        // owns a key or a budget and can be tested with no network at all.
        verifier,
        deadlineMs: opts.deadlineMs || null,
      });
      if (lim) {
        budgetNote.spent = lim.spent();
        budgetNote.skipped = lim.skipped();
        out.creditsSpent = lim.spent();
        out.creditsSkipped = lim.skipped();
      }
    }
  } catch (e) {
    // A verification pass that could not run must not stop addresses being
    // attached -- that would turn an outage into an empty queue. It degrades to
    // the behaviour that existed before this check did.
    console.error('[draftAddress] verification pass failed:', e.message);
  }
  for (const r of rows) {
    const hit = found.get(String(r.brand_name || '').trim().toLowerCase());
    if (!hit) {
      out.missing++;
      out.details.push({ id: r.id, brand: r.brand_name, result: 'no-address' });
      continue;
    }
    // A DEFINITE NO IS THE ONLY THING THAT STOPS AN ATTACH.
    const v = verdicts.get(String(hit.email).trim().toLowerCase());
    if (v && v.result === 'invalid') {
      out.rejected++;
      out.details.push({ id: r.id, brand: r.brand_name, result: 'rejected',
        email: hit.email, why: v.detail || 'the address does not accept mail' });
      console.log(`[draftAddress] ${r.brand_name}: ${hit.email} NOT attached — ${v.detail}`);
      continue;
    }
    if (!v || v.result === 'unknown') out.unverifiable++;
    await pool.query(
      `UPDATE outreach_logs
          SET sent_to_email = $2, email_kind = $3, updated_at = NOW()
        WHERE id = $1 AND (sent_to_email IS NULL OR sent_to_email = '')`,
      [r.id, hit.email, hit.kind]).catch((e) =>
      console.error('[draftAddress] attach ' + r.id + ':', e.message));
    out.attached++;
    if (hit.corporate) out.corporate++;
    out.details.push({ id: r.id, brand: r.brand_name, result: 'attached',
      email: hit.email, kind: hit.kind,
      verified: v ? v.result : 'unknown' });
  }
  if (budgetNote) {
    out.budget = budgetNote;
    const a = budgetNote.account || {};
    console.log(`[draftAddress] source=${budgetNote.source} athletes=${budgetNote.athletes} `
      + `verification credits: spent=${budgetNote.spent || 0} skipped=${budgetNote.skipped || 0} `
      + `perAthleteLeft=${budgetNote.perAthleteLeft} budget=${budgetNote.budget}/athlete/day `
      + `boundBy=${budgetNote.boundBy} monthUsed=${a.verifyUsed == null ? 'unknown' : a.verifyUsed}`
      + `/${a.verifyCap} ladder=${a.ladderUsed} accountLeft=${a.remaining} day=${budgetNote.day}`);
    // A FAULT IS NOT A BUDGET. Said separately and at error level, because the
    // whole point of this pass is that "we could not count" must never again be
    // reported as "the month is spent".
    if (budgetNote.meterFault) {
      console.error('[verify-budget] FAULT: ' + budgetNote.meterFault
        + ' — verification is off and NOTHING has been spent.');
    } else if (a.low) {
      console.warn('[verify-budget] ' + a.line);
    }
  }
  return out;
}

module.exports = { attach, lookupOne, lookupMany, classify };
