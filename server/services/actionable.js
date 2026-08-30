'use strict';
// ── ONE QUEUE, TWO TABLES ────────────────────────────────────────────────────
//
// The morning queue is a MIXED queue. It always was in the data and never was on
// the page: the nightly job writes call and DM cards into outreach_queue and has
// no email branch at all, while draftPrewarm -- fired by a Deal Scan click --
// writes email drafts into outreach_logs. Home read outreach_logs only, so the
// 82% of a night's work that is a phone number or a handle was invisible on the
// one page an agent opens every morning, and the 18% that is emailable looked
// like the whole product.
//
// This module is the single definition of "a card an agent can act on today". It
// exists because there were two answers and they disagreed in front of a
// customer: Home gated on a usable address and showed five, the shift report
// counted raw outreach_logs rows and said 118. Both numbers were computed
// correctly. They were answers to different questions printed under the same
// word.
//
// EVERY CALLER USES THE SAME PREDICATE, AS A STRING. The WHERE fragments below
// are exported constants, not copied SQL, so the two readers cannot drift apart
// by editing one and forgetting the other. The JS gate is one function for the
// same reason.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
//
//   PROGRAM CARDS. A program card is an application to a brand's athlete
//   programme, not an approach to a business, and it has no person on the other
//   end. 72 of the 121 queued cards in production are program cards, so folding
//   them in would make "five cards for this athlete" mean two different things.
//   They stay on the Outreach tab and are counted SEPARATELY in the report --
//   excluded, never dropped.
//
//   A SHARED FIT SCORE. There isn't one. brand_match_scores has no brand_key
//   column at all; it joins on athlete_id plus a lowercase brand_name, which is
//   the same weak matching the identity work replaced everywhere else. Two of 49
//   non-program queue cards carry a score -- 4%. Email drafts, written after a
//   scan, mostly do. So sorting the union by compatibility_score DESC NULLS LAST
//   would put every email above every call and DM card and quietly rebuild the
//   single-channel page this module exists to replace. The score is not used.

const BI = require('./brandIdentity');

// Five per athlete, whatever the channel. Same constant Home already used.
const SHOWN_MAX = parseInt(process.env.HOME_CARDS_PER_ATHLETE, 10) || 5;

// AT LEAST this many of the five are email drafts when that many exist. A FLOOR,
// never a cap: if the six best cards are all email, all five shown are email.
//
// Why a floor at all, when the ranking below is deliberately channel-blind: an
// email card is the only one that sends itself. The agent approves and walks
// away; the send window, the cadence and the media kit are all automatic. A DM
// or a call costs a person several minutes each. At an 18% email share a purely
// ranked five will be all-DM most mornings for most athletes, which turns the
// morning from "approve a batch" into twenty-five manual actions. Two slots is
// the smallest reservation that keeps the automatic channel present without
// letting a thin email outrank a strong DM for the other three.
const EMAIL_RESERVE = parseInt(process.env.HOME_EMAIL_RESERVE, 10) || 2;

// A card older than this is promoted above the ranking, so a mediocre card at a
// busy athlete surfaces instead of ageing out unseen. Without it the ranking has
// no tail: the same top five are shown every morning and everything behind them
// is, in practice, deleted by silence.
const STARVE_DAYS = parseInt(process.env.HOME_STARVE_DAYS, 10) || 7;

// EMAIL DRAFTS ARE PROMOTED A DAY EARLIER, because they are also DELETED on a
// clock. shiftReport.DRAFT_EXPIRY_DAYS expires a draft at 7 days, so a promotion
// that fires at 7 fires on the morning the draft is expired -- the agent is
// shown it for the first time in the same run that takes it away. Queue cards
// never expire, so they promote at STARVE_DAYS proper.
function starveDaysFor(channel) {
  if (channel !== 'email') return STARVE_DAYS;
  let expiry = 7;
  try { expiry = require('./shiftReport').DRAFT_EXPIRY_DAYS || 7; } catch (e) { /* default */ }
  return Math.max(1, Math.min(STARVE_DAYS, expiry - 1));
}

// ── THE PREDICATES, ONCE ─────────────────────────────────────────────────────
// $1 is always agent_id. Callers append their own athlete filter and columns.
// These are the whole reason two readers cannot disagree: there is one string.

const EMAIL_WHERE = `l.agent_id = $1
    AND l.status = 'draft' AND l.approved_at IS NULL
    AND l.cadence_stopped_at IS NULL`;

// 'program' is excluded HERE rather than at the caller, so nobody can include it
// by writing their own query and forgetting.
const QUEUE_WHERE = `q.agent_id = $1
    AND q.state = 'queued'
    AND q.channel IN ('dm','call')`;

const PROGRAM_WHERE = `q.agent_id = $1
    AND q.state = 'queued'
    AND q.channel = 'program'`;

// ── IDS ARE NAMESPACED ───────────────────────────────────────────────────────
//
// outreach_logs.id is TEXT and outreach_queue.id is a SERIAL integer. Put both
// in one list and an approve handler that filters by `id = ANY($2::text[])`
// cannot tell them apart: at best a queue id matches nothing and the card
// silently fails to approve, at worst it matches an unrelated draft and sends a
// real email to a real business. Neither is acceptable on a live database, and
// neither announces itself.
//
// So every id that crosses the wire carries its table. Parsers reject what they
// do not own rather than filtering it away.
const NS = { EMAIL: 'email', QUEUE: 'queue' };

function tagId(ns, rawId) { return ns + ':' + String(rawId); }

// Returns { ns, rawId }. Throws for anything the caller must not act on.
// `assume` is the namespace a BARE id is read as -- a page cached before this
// shipped posts unprefixed draft ids, and those are still email drafts.
function parseId(id, assume) {
  const s = String(id == null ? '' : id);
  const i = s.indexOf(':');
  if (i === -1) {
    if (!assume) throw new BadId(`"${s}" has no table on it`);
    return { ns: assume, rawId: s };
  }
  const ns = s.slice(0, i);
  const rawId = s.slice(i + 1);
  if (ns !== NS.EMAIL && ns !== NS.QUEUE) throw new BadId(`"${s}" names a table that does not exist`);
  if (!rawId) throw new BadId(`"${s}" has a table but no id`);
  return { ns, rawId };
}

class BadId extends Error {
  constructor(msg) { super(msg); this.name = 'BadId'; this.badId = true; }
}

// ── LOADING ──────────────────────────────────────────────────────────────────
// Two shapes of read over the same predicate. `lite` selects only what the gate
// and the ranking need, for counting a whole roster; `full` adds the body, the
// pitch and the contact for the athlete actually being rendered. Sharing the
// WHERE is the point; sharing the SELECT would mean pulling every draft body on
// the roster to print a tab count.

function emailSql(full, athleteScoped) {
  const cols = full
    ? `l.id, l.athlete_id, l.brand_name, l.created_at, l.sent_to_email,
       l.subject, l.body_html, l.edited_before_approval,
       e.website,
       c.contact_name, c.contact_title, c.why, m.reasoning`
    : `l.id, l.athlete_id, l.brand_name, l.created_at, l.sent_to_email, e.website`;
  const joins = full
    ? `LEFT JOIN company_enrichment e ON e.id = l.enrichment_id
       LEFT JOIN LATERAL (
         SELECT contact_name, contact_title, why FROM outreach_queue q2
          WHERE q2.athlete_id = l.athlete_id
            AND LOWER(q2.brand_name) = LOWER(l.brand_name)
          ORDER BY q2.created_at DESC LIMIT 1
       ) c ON TRUE
       LEFT JOIN LATERAL (
         SELECT reasoning FROM brand_match_scores m2
          WHERE m2.agent_id = l.agent_id AND m2.athlete_id = l.athlete_id
            AND LOWER(m2.brand_name) = LOWER(l.brand_name)
          ORDER BY m2.created_at DESC LIMIT 1
       ) m ON TRUE`
    : `LEFT JOIN company_enrichment e ON e.id = l.enrichment_id`;
  return `SELECT ${cols} FROM outreach_logs l ${joins}
           WHERE ${EMAIL_WHERE}${athleteScoped ? ' AND l.athlete_id = $2' : ''}`;
}

function queueSql(athleteScoped, where) {
  return `SELECT q.id, q.athlete_id, q.brand_name, q.brand_key, q.created_at, q.channel,
                 q.slot, q.why, q.contact_name, q.contact_title, q.dm_text,
                 q.instagram, q.instagram_scope, q.phone, q.phone_ask_for,
                 q.sponsor_note, q.source_note, q.affiliation_scope, q.lane, q.program_url
            FROM outreach_queue q
           WHERE ${where || QUEUE_WHERE}${athleteScoped ? ' AND q.athlete_id = $2' : ''}`;
}

// One card shape out of two schemas. Everything downstream -- the gate, the
// ranking, the collapse, the renderer -- sees only this.
function normEmail(r) {
  return {
    ns: NS.EMAIL, rawId: r.id, id: tagId(NS.EMAIL, r.id), channel: 'email',
    athleteId: r.athlete_id, createdAt: r.created_at,
    // brand_name and website are what BI.identitiesOf reads.
    brand_name: r.brand_name, website: r.website || null,
    toEmail: r.sent_to_email ? String(r.sent_to_email).trim().toLowerCase() : null,
    subject: r.subject || null, bodyHtml: r.body_html || null,
    edited: !!r.edited_before_approval,
    contactName: r.contact_name || null, contactTitle: r.contact_title || null,
    why: r.why || null, reasoning: r.reasoning || null,
    verified: null,   // filled by the gate
  };
}

function normQueue(r) {
  return {
    ns: NS.QUEUE, rawId: r.id, id: tagId(NS.QUEUE, r.id), channel: r.channel,
    athleteId: r.athlete_id, createdAt: r.created_at,
    brand_name: r.brand_name, brand_key: r.brand_key || null, website: null,
    slot: r.slot,
    dmText: r.dm_text || null,
    instagram: r.instagram || null, instagramScope: r.instagram_scope || null,
    phone: r.phone || null, phoneAskFor: r.phone_ask_for || null,
    contactName: r.contact_name || null, contactTitle: r.contact_title || null,
    why: r.why || null, reasoning: null,
    sponsorNote: r.sponsor_note || null, sourceNote: r.source_note || null,
    affiliationScope: r.affiliation_scope || null, lane: r.lane || null,
    programUrl: r.program_url || null,
  };
}

// ── THE GATE ─────────────────────────────────────────────────────────────────
//
// CHANNEL-AWARE, because the version that shipped was not. Home's gate was
// written when every card was an email and reads:
//
//     if (!a) { withheld.push({... 'no email address found for this business yet'}); return false; }
//
// Run that over the mixed queue and every call and DM card is withheld, with a
// reason that is false about each of them. A DM card is reachable when it has a
// handle and something to send; a call card is reachable when it has a number.
// That is the same standard outreachQueue.passesBar already applies at insert --
// `const reachable = !!(handle || phone || inbox)` -- so this is that bar, read
// back per channel rather than reinvented.
//
// Nothing is dropped silently. Everything held back is named with a reason a
// person can act on, which is what makes "where did that business go" answerable.
function screenAddr(addr) {
  try { return require('./siteEmail').screenEmail(addr, null); }
  catch (e) { return { ok: true }; }   // cannot screen: do not invent a rejection
}

function gate(cards, ctx) {
  const suppressed = (ctx && ctx.suppressed) || new Set();
  const verdicts = (ctx && ctx.verdicts) || new Map();
  const kept = [];
  const withheld = [];
  const hold = (c, why) => withheld.push({ id: c.id, channel: c.channel, business: c.brand_name, why });

  for (const c of cards) {
    if (c.channel === 'email') {
      const a = c.toEmail;
      // NO ADDRESS IS NOT A PASS. This is the guard that was missing: both bad-
      // address checks were written `if (a && ...)`, so a card with no address
      // fell between them onto the page as an approve button over an empty To.
      if (!a) { hold(c, 'no email address found for this business yet'); continue; }
      const s = screenAddr(a);
      if (!s.ok) { hold(c, s.reason); continue; }
      if (suppressed.has(a)) { hold(c, 'this address bounced before'); continue; }
      const v = verdicts.get(a) || null;
      if (v && v.result === 'invalid') { hold(c, 'the address does not accept mail'); continue; }
      c.verified = v;
      kept.push(c);
      continue;
    }
    if (c.channel === 'dm') {
      if (!c.instagram) { hold(c, 'no Instagram handle for this business yet'); continue; }
      // A DM card with no message is not one click, it is a blank box and a
      // homework assignment. The nightly job writes dm_text whenever it marks a
      // card dmable, so a missing one is a fault worth naming rather than a card
      // worth showing.
      if (!c.dmText || !String(c.dmText).trim()) { hold(c, 'no DM written for this card yet'); continue; }
      kept.push(c);
      continue;
    }
    if (c.channel === 'call') {
      if (!c.phone) { hold(c, 'no phone number for this business yet'); continue; }
      kept.push(c);
      continue;
    }
    // A channel this module does not know how to action must not be rendered as
    // though it could be. 'program' never reaches here (the SQL excludes it);
    // anything else is new and unhandled.
    hold(c, 'this card has no way to contact the business');
  }
  return { kept, withheld };
}

// ── THE RANKING ──────────────────────────────────────────────────────────────
//
// FOUR SIGNALS, NONE OF WHICH IS A SCORE. See the header: there is no fit score
// that spans both tables, and the one that exists covers 4% of queue cards.
// Every signal below is present, and means the same thing, on both sides.
//
//   1. STARVED       older than the promotion age. Above everything, so the tail
//                    surfaces instead of ageing out unseen.
//   2. REACH         how likely this card is to reach a human, per channel. A
//                    confirmed mailbox, a storefront handle, a number with a
//                    name to ask for -- 2. The weaker form of each -- 1. The
//                    gate already removed 0.
//   3. HAS A REASON  whether we hold a stated reason for this pairing at all.
//                    Binary on purpose: scoring the QUALITY of a reason would
//                    have to weigh a sponsor note against a pitch opener, and
//                    sponsor notes exist only on queue cards, so any such scale
//                    is a channel preference wearing a evidence's clothes.
//   4. OLDEST FIRST  created_at, the only column that is literally the same on
//                    both tables. Then the id, so the order is total and a page
//                    reload cannot reshuffle two otherwise-equal cards.
// MILLISECONDS, FROM EITHER SHAPE. node-postgres returns a timestamptz as a
// Date; Date.parse() takes a STRING, so passing it a Date coerces through
// toString() and silently drops the sub-second part. Every card written in the
// same second then compared equal, the age tie-break stopped working, and the
// order fell through to the id -- which sorts "email:" above "queue:" and
// quietly reintroduced the channel bias this ranking exists to avoid.
function ms(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return isFinite(t) ? t : 0;
}

function ageDays(c, now) {
  const t = ms(c.createdAt);
  if (!t) return 0;
  return (now - t) / 86400000;
}

function isStarved(c, now) { return ageDays(c, now) >= starveDaysFor(c.channel); }

function reachScore(c) {
  if (c.channel === 'email') return c.verified && c.verified.result === 'valid' ? 2 : 1;
  // A brand account is a real channel and it is NOT this storefront, so the DM
  // lands with a national social team rather than the owner who signs the deal.
  if (c.channel === 'dm') return c.instagramScope === 'brand' ? 1 : 2;
  // A switchboard is a worse call than a number with a name attached to it.
  return (c.phoneAskFor || c.contactName) ? 2 : 1;
}

function hasReason(c) {
  return (c.sponsorNote || c.reasoning || c.why || c.bodyHtml) ? 1 : 0;
}

function rankKey(c, now) {
  return [
    isStarved(c, now) ? 0 : 1,
    -reachScore(c),
    -hasReason(c),
    ms(c.createdAt),
    // Last resort only. It is a namespaced id, so it sorts by TABLE first --
    // which is a channel preference, and must never decide anything above here.
    String(c.id),
  ];
}

function byRank(now) {
  return (a, b) => {
    const ka = rankKey(a, now), kb = rankKey(b, now);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  };
}

// ── ONE CARD PER BUSINESS, ACROSS BOTH TABLES ────────────────────────────────
//
// The same business can hold an email draft AND a queue card: draftPrewarm
// writes from a Deal Scan, the nightly job writes from the slate, and neither
// knows about the other. Merged naively, an athlete's five can be three cards
// for one coffee shop.
//
// BI.dedupe keeps the FIRST occurrence, so the input order decides the winner.
// It is sorted email-first here rather than by rank: when one business is
// reachable both ways, the email is the one that sends itself, and approaching
// the same owner twice through two channels in one morning is the outcome this
// exists to prevent. Within a channel, rank decides. The kept list is re-sorted
// by rank afterwards, so preferring email as a WINNER never promotes it in the
// DISPLAY order.
//
// NO MARKET IS PASSED, deliberately. identitiesOf suffixes a name key with the
// market when it has one, so an email draft (which carries no market) and a
// queue card (which does) would produce `name:cahaba brewing` and
// `name:cahaba brewing@birmingham-al` and never touch. Everything here belongs
// to ONE athlete, so there is exactly one market by construction and the suffix
// separates nothing.
function collapse(cards, now, tag) {
  const ordered = cards.slice().sort((a, b) => {
    const ea = a.channel === 'email' ? 0 : 1, eb = b.channel === 'email' ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return byRank(now)(a, b);
  });
  const { kept, collapses } = BI.dedupe(ordered);
  for (const x of collapses) {
    // Both names, both keys, both CHANNELS, and which key decided it -- the same
    // line the slate dedupe logs, so one grep answers "what is being collapsed
    // and on what basis" across the whole product.
    //
    // brand_key is printed AS IT IS, which for an email draft is nothing:
    // outreach_logs has no brand_key column. "(no key)" on one side of every
    // cross-table collapse is not noise, it is the finding -- it says these
    // collapses can only ever be decided on the weakest basis, the normalised
    // name, until drafts carry an identity.
    //
    // The TAG says which pass produced the line. A page load counts the whole
    // roster and then builds one athlete's cards, so the same collapse is
    // legitimately reached twice; distinct tags keep one grep to one line per
    // collapse per pass rather than making them indistinguishable.
    console.log(BI.describeCollapse(
      { ...x,
        winner: { ...x.winner, pool: x.winner.channel },
        loser: { ...x.loser, pool: x.loser.channel } },
      tag || 'home'));
  }
  return { kept: kept.sort(byRank(now)), collapses };
}

// ── THE FIVE ─────────────────────────────────────────────────────────────────
// Reserve first, then fill by rank, then re-sort so what is shown is in ranked
// order rather than reserved-first order.
function select(ranked, opts = {}) {
  const max = opts.max || SHOWN_MAX;
  const reserve = opts.reserve == null ? EMAIL_RESERVE : opts.reserve;
  const now = opts.now || Date.now();
  const out = [];
  const taken = new Set();
  for (const c of ranked) {
    if (out.length >= Math.min(reserve, max)) break;
    if (c.channel !== 'email') continue;
    out.push(c); taken.add(c.id);
  }
  for (const c of ranked) {
    if (out.length >= max) break;
    if (taken.has(c.id)) continue;
    out.push(c); taken.add(c.id);
  }
  return out.sort(byRank(now));
}

// ── THE ONE READ BOTH CALLERS MAKE ───────────────────────────────────────────
//
// Home calls this for the athlete it is rendering AND for the whole roster (to
// size the tabs); the shift report calls it for the whole roster. Same function,
// same predicate, same gate, same collapse -- which is the only construction
// under which the two surfaces cannot print different numbers for the same pile.
//
// It does NOT run draftAddress.attach. Attach is Home's display-time rescue for
// the window it fetched, it costs verification credits, and a report build must
// never spend them. Home attaches first and then calls this, so both readers are
// looking at the same rows in the database by the time either counts.
async function load(pool, agentId, opts = {}) {
  const athleteId = opts.athleteId || null;
  const full = !!opts.full;
  const now = opts.now || Date.now();
  const errs = [];
  const q = async (label, sql, params) => {
    try { return (await pool.query(sql, params)).rows; }
    catch (e) { console.error('[actionable] ' + label + ': ' + e.message); errs.push(label + ': ' + e.message); return []; }
  };
  const params = athleteId ? [agentId, athleteId] : [agentId];

  const emailRows = await q('email', emailSql(full, !!athleteId), params);
  const queueRows = await q('queue', queueSql(!!athleteId), params);

  let cards = emailRows.map(normEmail).concat(queueRows.map(normQueue));

  // Suppression and verification, once for every address in the set rather than
  // once per card.
  const addrs = cards.filter((c) => c.channel === 'email' && c.toEmail).map((c) => c.toEmail);
  let suppressed = new Set();
  const verdicts = new Map();
  if (addrs.length) {
    try { suppressed = await require('./suppression').suppressedSet(pool, addrs); }
    catch (e) { errs.push('suppression: ' + e.message); }
    for (const r of await q('verification',
      `SELECT email, result, source FROM email_verification WHERE email = ANY($1::text[])`, [addrs])) {
      verdicts.set(r.email, { result: r.result, source: r.source });
    }
  }

  const g = gate(cards, { suppressed, verdicts });

  // Collapsed PER ATHLETE. Two athletes being shown the same business is a
  // deliberate product behaviour -- the ledger is keyed (athlete_id, brand_key)
  // precisely so a second athlete can still be offered a brand the first was --
  // so collapsing across the roster would delete real work.
  const byAthlete = new Map();
  for (const c of g.kept) {
    if (!byAthlete.has(c.athleteId)) byAthlete.set(c.athleteId, []);
    byAthlete.get(c.athleteId).push(c);
  }
  const out = new Map();
  let collapsed = 0;
  for (const [aid, list] of byAthlete) {
    const r = collapse(list, now, opts.tag || (full ? 'home-cards' : 'roster-count'));
    collapsed += r.collapses.length;
    out.set(aid, r.kept);
  }

  return { byAthlete: out, withheld: g.withheld, collapsed, errors: errs };
}

// Counts for a whole roster, in the shape both the tabs and the report want.
// `program` is counted separately and never folded in.
async function countActionable(pool, agentId, opts = {}) {
  const r = await load(pool, agentId, { ...opts, full: false });
  // Per athlete AND per channel, because "ready to send" and "ready to work" are
  // different questions and answering them from two different queries is how the
  // report came to print two counts of one pile.
  const perAthlete = new Map();
  const byChannel = { email: 0, dm: 0, call: 0 };
  let total = 0;
  for (const [aid, list] of r.byAthlete) {
    const row = { total: list.length, email: 0, dm: 0, call: 0, brands: [] };
    for (const c of list) {
      if (row[c.channel] != null) row[c.channel]++;
      if (byChannel[c.channel] != null) byChannel[c.channel]++;
      if (c.channel === 'email' && row.brands.length < 3) row.brands.push(c.brand_name);
    }
    perAthlete.set(aid, row);
    total += list.length;
  }
  let program = 0;
  try {
    const pr = await pool.query(
      `SELECT COUNT(*)::int AS n FROM outreach_queue q WHERE ${PROGRAM_WHERE}`, [agentId]);
    program = (pr.rows[0] && pr.rows[0].n) || 0;
  } catch (e) { r.errors.push('program: ' + e.message); }

  return { total, byChannel, program, perAthlete, withheld: r.withheld, errors: r.errors };
}

module.exports = {
  NS, BadId, tagId, parseId,
  SHOWN_MAX, EMAIL_RESERVE, STARVE_DAYS, starveDaysFor,
  EMAIL_WHERE, QUEUE_WHERE, PROGRAM_WHERE,
  normEmail, normQueue, gate, rankKey, byRank, collapse, select,
  reachScore, hasReason, isStarved, ageDays,
  load, countActionable,
};
