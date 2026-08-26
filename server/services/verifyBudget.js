'use strict';
// ── WHAT A HOME PAGE LOAD IS ALLOWED TO SPEND ────────────────────────────────
//
// Moving draftAddress.attach from approve time to Home-build time moved
// verification from "cards that get sent" to "cards that get looked at". Those
// are very different volumes: an agent who opens Home, reads the slate and
// approves nothing has, under the new arrangement, spent Hunter credits.
//
// MX IS FREE AND IS NOT BUDGETED. A domain that publishes no mail exchanger is
// caught for every card, always, budget or no budget -- that is a DNS lookup
// against a resolver, not a vendor. Only the Hunter mailbox check consumes a
// credit, so only that is counted here.
//
// THE LOG IS THE COUNTER. There is no separate tally to drift out of step with
// the truth: the per-athlete-per-day budget is a COUNT over the same rows that
// answer "where did my credits actually go". One write, one meaning.
//
// WHY 3 A DAY PER ATHLETE.
//
//   A slate is five cards, so three is deliberately less than a full slate. The
//   budget is a safety valve, not a target: the cards it cannot pay for still
//   appear, marked unverified, which is the same stance the compliance gate and
//   the domain gate take -- proceed, and say what you do not know.
//
//   The arithmetic that picked it. Verdicts cache for 90 days, so the steady
//   state is far below the worst case; the number has to survive the worst case
//   anyway. Eight athletes viewed every day for a month:
//
//     3/athlete/day x 8 athletes x 30 days = 720   (36% of a 2,000 cap)
//     5/athlete/day x 8 athletes x 30 days = 1,200 (60%)
//
//   Hunter Domain Search draws on the SAME account, and hunterLookup already
//   holds a monthly ceiling of 1,800 for it. Five would leave that ceiling
//   competing with this one for the same credits. Three leaves roughly two
//   thirds of the account for the contact ladder, which is the thing that finds
//   the addresses in the first place.
//
// Set HOME_VERIFY_PER_ATHLETE_DAY to change it.

// ── AND A CEILING ON THE WHOLE ACCOUNT ──────────────────────────────────────
//
// The per-athlete number was sized against eight athletes. It does not survive
// twenty: 3 x 20 x 30 = 1,800 credits a month from verification alone, which
// eats a 2,000-credit account by itself and leaves the contact ladder -- the
// thing that FINDS the addresses -- with nothing.
//
// So the per-athlete budget is no longer the only limit. It is the smaller of
// two, and the account ceiling wins.
//
// A GAP THIS CLOSES. hunterLookup.creditsThisMonth counts rows in
// brand_evidence_cache lane 'hunter' -- Domain Search, and only Domain Search.
// Verification credits never landed in that lane, so hunterLookup's monthly
// ceiling could report plenty remaining while verification quietly spent the
// account. Both are counted here.
//
// THE LADDER GETS A RESERVE. Verification is a nice-to-have on a card; Domain
// Search is how an address exists at all. So verification may spend down to the
// reserve and no further, and when the reserve is what stops it the cards say
// unverified rather than the ladder going dark.
const sendGuard = require('./sendGuard');

const PER_ATHLETE_DAY = parseInt(process.env.HOME_VERIFY_PER_ATHLETE_DAY, 10) || 3;

// The real plan. Set HUNTER_ACCOUNT_MONTHLY if the plan changes -- this is the
// number on the invoice, not a policy choice.
const ACCOUNT_MONTHLY = parseInt(process.env.HUNTER_ACCOUNT_MONTHLY, 10) || 2000;
// Held back for Domain Search. 40% of a 2,000 account is 800 lookups a month
// for the ladder, which at the current scan rate is the binding number for
// whether addresses get found at all.
const LADDER_RESERVE_PCT = Number(process.env.HUNTER_LADDER_RESERVE_PCT || 0.40);
// Verification's own hard share, independent of what the ladder happens to have
// spent. Two limits rather than one because a quiet ladder month must not
// silently license verification to spend the whole account.
const VERIFY_MONTHLY_CAP = parseInt(process.env.HOME_VERIFY_MONTHLY_CAP, 10)
  || Math.round(ACCOUNT_MONTHLY * (1 - LADDER_RESERVE_PCT));
// Warn from here. 75% of the way through the month's verification share is
// early enough to do something about and late enough not to cry wolf.
const WARN_AT_PCT = Number(process.env.HOME_VERIFY_WARN_AT_PCT || 0.75);

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verify_credit_log (
      id          BIGSERIAL PRIMARY KEY,
      agent_id    TEXT,
      athlete_id  TEXT,
      business    TEXT,
      email       TEXT,
      source      TEXT,
      local_date  DATE NOT NULL,
      checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((e) => console.error('[verifyBudget] ensureTable:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_verify_credit_athlete_day
    ON email_verify_credit_log (athlete_id, local_date)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_verify_credit_at
    ON email_verify_credit_log (checked_at DESC)`).catch(() => {});
}

// The agent's own calendar date, from sendGuard.localDate, because there is
// already one definition of "a day" in this codebase and a second one that
// disagreed with it by a few hours would be worse than none.
async function dayFor(pool, agentId) {
  try {
    const r = await pool.query(`SELECT report_tz FROM users WHERE id = $1`, [agentId]);
    return sendGuard.localDate((r.rows[0] && r.rows[0].report_tz) || sendGuard.DEFAULT_TZ);
  } catch (_) {
    return sendGuard.localDate(sendGuard.DEFAULT_TZ);
  }
}

async function spentToday(pool, athleteId, day) {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM email_verify_credit_log
        WHERE athlete_id = $1 AND local_date = $2`, [athleteId, day]);
    return (r.rows[0] && r.rows[0].n) || 0;
  } catch (e) {
    console.error('[verifyBudget] spentToday:', e.message);
    // A budget we cannot read must not hand out unlimited credits.
    return PER_ATHLETE_DAY;
  }
}

// ── WHERE THE ACCOUNT STANDS THIS MONTH ─────────────────────────────────────
// Both consumers, counted together, because they draw on one Hunter account and
// a ceiling that can only see half of it is not a ceiling.
async function accountStatus(pool) {
  let verifyUsed = 0;
  let ladderUsed = 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM email_verify_credit_log
        WHERE checked_at >= date_trunc('month', NOW())`);
    verifyUsed = (r.rows[0] && r.rows[0].n) || 0;
  } catch (e) {
    console.error('[verifyBudget] accountStatus verify:', e.message);
    // Fail safe, the same way hunterLookup does: an unreadable budget must not
    // read as "plenty left".
    verifyUsed = VERIFY_MONTHLY_CAP;
  }
  try {
    ladderUsed = await require('./hunterLookup').creditsThisMonth(false);
  } catch (e) {
    console.error('[verifyBudget] accountStatus ladder:', e.message);
    ladderUsed = 0;
  }

  const accountUsed = verifyUsed + ladderUsed;
  const accountLeft = Math.max(0, ACCOUNT_MONTHLY - accountUsed);
  const reserve = Math.round(ACCOUNT_MONTHLY * LADDER_RESERVE_PCT);
  // Verification stops at whichever bites first: its own share, or the point
  // where continuing would eat into the ladder's reserve.
  const shareLeft = Math.max(0, VERIFY_MONTHLY_CAP - verifyUsed);
  const reserveLeft = Math.max(0, accountLeft - Math.max(0, reserve - ladderUsed));
  const remaining = Math.min(shareLeft, reserveLeft);
  const usedPct = VERIFY_MONTHLY_CAP > 0 ? verifyUsed / VERIFY_MONTHLY_CAP : 1;

  return {
    verifyUsed, ladderUsed, accountUsed, accountMonthly: ACCOUNT_MONTHLY,
    verifyCap: VERIFY_MONTHLY_CAP, ladderReserve: reserve,
    remaining, usedPct: Math.round(usedPct * 1000) / 10,
    low: remaining <= 0 || usedPct >= WARN_AT_PCT,
    exhausted: remaining <= 0,
    // Said in words once, here, so every surface that reports this says the same
    // thing rather than inventing its own phrasing.
    line: remaining <= 0
      ? `Address verification is paused for the rest of the month — ${verifyUsed} of `
        + `${VERIFY_MONTHLY_CAP} checks used, and the rest of the Hunter account is held `
        + 'back for finding addresses. Cards still appear; they are marked unverified.'
      : `Address verification has used ${verifyUsed} of ${VERIFY_MONTHLY_CAP} checks this `
        + `month (${Math.round(usedPct * 100)}%). At this rate it runs out before the month does.`,
  };
}

async function record(pool, { agentId, athleteId, business, email, day, source }) {
  try {
    await pool.query(
      `INSERT INTO email_verify_credit_log
         (agent_id, athlete_id, business, email, source, local_date)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [agentId || null, athleteId || null, business || null,
        String(email || '').trim().toLowerCase(), source || 'home', day]);
  } catch (e) { console.error('[verifyBudget] record:', e.message); }
}

// ── The gate a caller wraps its verifier in ─────────────────────────────────
// Returns { verifier, spent(), left(), skipped() }. The wrapped verifier
// decrements BEFORE the await, so two concurrent lookups cannot both spend the
// last credit -- the same rule the send ceiling follows.
//
// When the budget is gone the wrapper returns a refusal rather than calling
// Hunter. emailVerify turns that into `unknown`, which is NOT cached and does
// NOT hold a card back, so an exhausted budget costs accuracy on the card and
// nothing else.
function limiter(pool, { agentId, athleteId, day, budget, emailToBusiness, verifier }) {
  let left = Math.max(0, budget);
  let spent = 0;
  let skipped = 0;
  return {
    spent: () => spent,
    left: () => left,
    skipped: () => skipped,
    verifier: async (email) => {
      if (left <= 0) {
        skipped++;
        return { ok: false, why: 'the daily verification budget for this athlete is spent' };
      }
      left--;                       // before the await, deliberately
      spent++;
      const business = (emailToBusiness && emailToBusiness.get(String(email).trim().toLowerCase())) || null;
      // Logged at the moment the credit is committed, not after the answer comes
      // back: a lookup that times out still cost a credit and still belongs in
      // the burn report.
      await record(pool, { agentId, athleteId, business, email, day, source: 'home' });
      console.log(`[verify-credit] athlete=${athleteId || '-'} business=${business || '-'} `
        + `email=${email} at=${new Date().toISOString()} left=${left}`);
      return verifier(email);
    },
  };
}

module.exports = {
  ensureTable, dayFor, spentToday, record, limiter, accountStatus,
  PER_ATHLETE_DAY, ACCOUNT_MONTHLY, VERIFY_MONTHLY_CAP, LADDER_RESERVE_PCT, WARN_AT_PCT,
};
