'use strict';
// ── EVERY APPROVED EMAIL REACHES A REAL PERSON ──────────────────────────────
//
// Jabree Belcher approved everything for a month: four emails went out, three
// of them to info@ inboxes; five DM cards were marked sent that nobody sent;
// three approved emails expired with no address. This file is the one gate an
// address passes before it can be an EMAIL CARD, used by the nightly fill
// (before a card is shown), by Home, by Approve, and by the cleanup.
//
// RULE 1. An email card needs an address that
//   (a) belongs to a NAMED PERSON at the business: the address carries their
//       name, on the business's own domain, or it is the owner's own address
//       (a personal mailbox with their name in it); and
//   (b) PASSED VERIFICATION as deliverable. Invalid can never be sent. A
//       catch-all domain (the verifier cannot tell) is accepted only for a
//       named person's address. Not yet verified is not an email card: the
//       address is verified before the card is shown, never after approval.
//
// RULE 2. Role inboxes.
//   NEVER: customerservice@, support@, webmaster@, legal@, general.counsel@,
//   careers@, jobs@, noreply@ and the like, and any address at a national
//   brand's corporate domain, for a local pitch.
//   GENERAL INBOX: info@, hello@ and contact@ only, only for a small owner-run
//   business, only when no person's address exists, only verified valid (not
//   catch-all). Labelled "General inbox" on the card; never counted toward the
//   daily five.
//   Any other desk address (office@, sales@, team@...) is not a person and not
//   one of the three general inboxes: never an email card.

const NEVER_LOCAL = /^(customer[._-]?(service|services|care|support|success|relations)|cs|support|help|helpdesk|webmaster|web|legal|general[._-]?counsel|counsel|careers?|jobs?|hiring|recruit(ing|ment)?|hr|human[._-]?resources|no[._-]?reply|do[._-]?not[._-]?reply|donotreply|postmaster|mailer[._-]?daemon|abuse|privacy|compliance|security|billing|invoices?|accounts?([._-]?payable)?|ap|ar|press|media|pr|unsubscribe|bounce|returns?|warranty|claims?)$/i;
const GENERAL_LOCAL = /^(info|hello|contact)$/i;
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|comcast|att|sbcglobal|verizon|bellsouth|cox|charter|earthlink)\.[a-z.]+$/i;

const lc = (s) => String(s || '').trim().toLowerCase();
function localOf(email) { return lc(email).split('@')[0] || ''; }
function domainOf(email) { return lc(email).split('@')[1] || ''; }
function root(host) {
  const h = lc(host).replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  return /^(co|com|org|net|gov|edu)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join('.') : two;
}
// The local part without digits and separators, for the list checks:
// "info1", "info.cypress" and "customer-service" read as the words they are.
function bare(local) { return String(local || '').toLowerCase().replace(/\d+$/, '').split(/[+]/)[0]; }
function firstToken(local) { return bare(local).split(/[._-]+/)[0]; }

function isNever(email) {
  const l = bare(localOf(email));
  return NEVER_LOCAL.test(l) || NEVER_LOCAL.test(l.replace(/[._-]/g, '')) || NEVER_LOCAL.test(firstToken(l));
}
function isGeneral(email) {
  const l = bare(localOf(email));
  return GENERAL_LOCAL.test(l) || GENERAL_LOCAL.test(firstToken(l));
}
function isFreeMail(email) { return FREE_MAIL.test(domainOf(email)); }

// The address carries the person's name: a first or last name of three letters
// or more appears in the local part (walt@, wprice@, walt.price@).
function nameTokens(name) {
  return lc(name).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s'-]+/).filter((t) => t.length >= 3);
}
function carriesName(email, name) {
  const l = localOf(email).replace(/[^a-z]/g, '');
  const t = nameTokens(name);
  return !!l && t.length > 0 && t.some((x) => l.includes(x));
}

// A national brand's corporate domain: the domain is a known chain's own
// (campusQuality.chainDomain), or the finder marked it corporate (siteEmail),
// or the business is a chain location and the address is not at a domain of its own.
function corporateDomain(email, ctx = {}) {
  if (ctx.corporate) return `a corporate address (${domainOf(email)})`;
  try {
    const hit = require('./campusQuality').chainDomain(domainOf(email));
    if (hit) return `${domainOf(email)} is ${hit}'s corporate domain`;
  } catch (_) { /* no chain list */ }
  return null;
}

// A small, owner-run business: not a national chain or a franchise location,
// not flagged corporate, and not so reviewed it is a regional operation.
function ownerRun(ctx = {}) {
  if (ctx.ownerRun === true) return true;
  if (ctx.ownerRun === false || ctx.franchise || ctx.chain || ctx.corporate) return false;
  try { if (require('./nationalChains').isNationalChain(ctx.brandName || '')) return false; } catch (_) { /* no list */ }
  const n = Number(ctx.reviews);
  if (Number.isFinite(n) && n >= 1500) return false;
  return true;
}

// The address is on the business's own domain, or it is the owner's own
// personal mailbox. With no website on file, a non-personal domain that
// carries the business's name counts as its own.
function onTheirDomain(email, ctx = {}) {
  const d = root(domainOf(email));
  if (!d) return false;
  if (isFreeMail(email)) return 'personal';
  if (ctx.website && root(ctx.website) === d) return 'business';
  if (!ctx.website) {
    const sld = d.split('.')[0];
    const toks = lc(ctx.brandName).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !/^(the|and|llc|inc|company|shop|store)$/.test(t));
    if (toks.some((t) => sld.includes(t))) return 'business';
  }
  return false;
}

// ── THE JUDGEMENT (pure) ────────────────────────────────────────────────────
// ctx: { email, contactName, brandName, website, corporate, franchise, chain,
//        ownerRun, reviews, verify: { result, status } | null,
//        personEmailExists (a named person's address exists for this business) }
// -> { ok, kind: 'person'|'general'|null, label, why, needsVerify }
function judge(ctx = {}) {
  const email = lc(ctx.email);
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return { ok: false, kind: null, why: 'no email address' };
  if (isNever(email)) return { ok: false, kind: null, why: `${localOf(email)}@ is a department inbox, never used for a pitch` };
  const corp = corporateDomain(email, ctx);
  if (corp) return { ok: false, kind: null, why: `${corp}: never used for a local pitch` };
  const v = ctx.verify || null;
  const status = lc(v && v.status);
  const verdict = !v ? null : v.result === 'valid' ? 'valid' : v.result === 'invalid' ? 'invalid' : (status === 'accept_all' ? 'catch-all' : 'unknown');
  // A named person's address.
  if (ctx.contactName && carriesName(email, ctx.contactName) && !isGeneral(email)) {
    const where = onTheirDomain(email, ctx);
    if (!where) return { ok: false, kind: null, why: `${email} is not on ${ctx.brandName || 'the business'}'s domain or the owner's own mailbox` };
    if (verdict === 'invalid') return { ok: false, kind: 'person', why: `${email} failed verification (${(v && v.detail) || 'invalid'})` };
    if (verdict === 'valid') return { ok: true, kind: 'person', label: where === 'personal' ? 'Verified (their own address)' : 'Verified', why: null };
    if (verdict === 'catch-all') return { ok: true, kind: 'person', label: 'Verified (catch-all domain)', why: null };
    return { ok: false, kind: 'person', why: `${email} is not verified yet`, needsVerify: verdict === null };
  }
  // The three general inboxes, for a small owner-run business only.
  if (isGeneral(email)) {
    if (ctx.personEmailExists) return { ok: false, kind: null, why: `${email} is a general inbox and a person's address exists for this business` };
    if (!ownerRun(ctx)) return { ok: false, kind: null, why: `${email} is a general inbox at a business that is not small and owner-run` };
    if (!onTheirDomain(email, ctx)) return { ok: false, kind: null, why: `${email} is not on ${ctx.brandName || 'the business'}'s domain` };
    if (verdict === 'valid') return { ok: true, kind: 'general', label: 'General inbox', why: null };
    if (verdict === 'invalid') return { ok: false, kind: 'general', why: `${email} failed verification` };
    if (verdict === 'catch-all') return { ok: false, kind: 'general', why: `${email} is at a catch-all domain: allowed only for a named person's address` };
    return { ok: false, kind: 'general', why: `${email} is not verified yet`, needsVerify: verdict === null };
  }
  if (!ctx.contactName) return { ok: false, kind: null, why: 'no named person at the business' };
  return { ok: false, kind: null, why: `${email} does not carry ${ctx.contactName}'s name: not their address` };
}

// ── VERIFY, THEN JUDGE ──────────────────────────────────────────────────────
// Verifies the addresses that need it (Hunter's mailbox check, budgeted and
// logged per run in email_verify_credit_log), then judges each. Cached
// verdicts (email_verification, 90 days) cost nothing.
// opts: { agentId, athleteId, run, source, perAthleteBudget, verifier (tests) }
async function verifyAndJudge(pool, items, opts = {}) {
  const EV = require('./emailVerify');
  const need = items.filter((it) => {
    const j = judge({ ...it, verify: null });
    return j.needsVerify;
  }).map((it) => lc(it.email));
  let verdicts = new Map();
  if (need.length) {
    let verifier = opts.verifier || null;
    if (!verifier) {
      const VB = require('./verifyBudget');
      const acct = await VB.accountStatus(pool).catch(() => null);
      const lim = VB.limiter(pool, {
        agentId: opts.agentId || null, athleteId: opts.athleteId || null, day: opts.day || new Date().toISOString().slice(0, 10),
        budget: Number.isFinite(opts.perAthleteBudget) ? opts.perAthleteBudget : NIGHT_VERIFY_PER_ATHLETE,
        accountLeft: acct && Number.isFinite(acct.remaining) ? acct.remaining : 0,
        source: opts.source || 'nightly', run: opts.run || null,
        emailToBusiness: new Map(items.map((it) => [lc(it.email), it.brandName || null])),
        verifier: require('./hunterLookup').verifyEmail,
      });
      verifier = lim.verifier;
    }
    verdicts = await EV.verifyMany(pool, need, { verifier, deadlineMs: opts.deadlineMs });
  }
  // What is already known (email_verification, 90 days) costs nothing.
  const cachedAll = await EV.cached(pool, items.map((it) => lc(it.email)).filter((e) => e && !verdicts.has(e))).catch(() => new Map());
  return items.map((it) => {
    const e = lc(it.email);
    const v = verdicts.get(e) || cachedAll.get(e) || null;
    // Only a verdict counts: the verifier's (or a cached one), or a domain that
    // cannot receive mail. "MX passed, nobody checked the mailbox" is not one.
    const real = v && (v.source === 'hunter' || v.result === 'invalid' || cachedAll.has(e)) ? v : null;
    return { ...it, verify: real, judgement: judge({ ...it, verify: real }) };
  });
}
const NIGHT_VERIFY_PER_ATHLETE = parseInt(process.env.NIGHT_VERIFY_PER_ATHLETE, 10) || 15;

module.exports = { judge, verifyAndJudge, isNever, isGeneral, isFreeMail, carriesName, ownerRun, corporateDomain, onTheirDomain, root,
  NEVER_LOCAL, GENERAL_LOCAL, NIGHT_VERIFY_PER_ATHLETE };
