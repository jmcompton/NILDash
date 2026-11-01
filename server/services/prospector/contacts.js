'use strict';
// ── WHO TO WRITE TO, AND IS THE ADDRESS REAL? ───────────────────────────────
//
// A ladder, best rung first, stopping at the first that gives an address:
//
//   1. Hunter domain search: a named person with the best title for the
//      playbook (owner, office manager...). Never info@ at this rung.
//   2. The business's own website (services/siteEmail, free, cached): an owner
//      or founder the site names, whose address Hunter's email finder then
//      looks up by name. A named personal address the site publishes is used
//      too, with the name only when it matches someone the site names.
//   3. The office inbox: office@ / frontdesk@ / info@, from the site or from
//      Hunter. For a 10-person dental office this is who reads the mail, so it
//      is a real channel, but it is marked: the email greets nobody by name.
//
// The first live run (Birmingham, Nov 1) found a named person at 2 of 10
// businesses on rung 1 alone. Small local offices are thin in Hunter.
//
// Every address is verified with Hunter's verifier. Only "valid" is called
// verified; "accept_all" (catch-all domain) is kept but marked.
//
// All Hunter calls go through services/hunterLookup (NILDash's key, cache,
// monthly budget and fault log). Nothing here spends past them.

const H = require('../hunterLookup');
const PB = require('./playbooks');

function pick(playbook, emails) {
  const people = (emails || []).filter((e) => e.email && e.type === 'personal' && e.firstName);
  if (!people.length) return null;
  const ranked = people
    .map((e) => ({ e, rank: PB.titleRank(playbook, e.position), conf: e.confidence || 0 }))
    .filter((x) => x.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || b.conf - a.conf);
  return ranked.length ? ranked[0].e : null;
}

// Office inboxes, the ones a small office's staff actually read, best first.
const INBOX_ORDER = ['office', 'frontdesk', 'front.desk', 'front-desk', 'reception', 'info', 'contact', 'hello',
  'admin', 'appointments', 'appts', 'manager', 'scheduling', 'team', 'mail', 'clinic'];
const NEVER = /^(careers?|jobs?|hiring|hr|billing|accounts?|invoices?|payments?|privacy|legal|press|media|marketing|noreply|no-reply|donotreply|webmaster|postmaster|abuse|security|support|sales|unsubscribe)$/;
function inboxRank(addr) {
  const lp = String(addr || '').toLowerCase().split('@')[0];
  if (NEVER.test(lp)) return Infinity;
  const i = INBOX_ORDER.indexOf(lp);
  return i === -1 ? INBOX_ORDER.length : i;
}
function bestInbox(addrs) {
  const r = addrs.filter(Boolean).map((a) => ({ a: String(a).toLowerCase(), r: inboxRank(a) })).filter((x) => x.r !== Infinity)
    .sort((x, y) => x.r - y.r);
  return r.length ? r[0].a : null;
}

// "Dr. Jane A. Smith, DMD" -> { first: 'Jane', last: 'Smith' }
function splitName(name) {
  const words = String(name || '').replace(/\b(dr|mr|mrs|ms|miss)\.?\s+/gi, '').replace(/,.*$/, '')
    .split(/\s+/).map((w) => w.replace(/[^A-Za-z'\-]/g, '')).filter((w) => w && !/^(jr|sr|ii|iii|iv|dds|dmd|md|dvm|cpa|esq|pt|dpt)$/i.test(w));
  if (words.length < 2) return null;
  return { first: words[0], last: words[words.length - 1] };
}

const VERIFIED = new Set(['valid']);

async function verified(verify, email) {
  const v = await verify(email);
  const status = v && v.ok ? (v.status || v.result || null) : null;
  return { verified: VERIFIED.has(String(status)), verifyStatus: status || (v && v.why) || 'unknown' };
}
// Hunter says this address bounces: never write to it, go down the ladder.
const DEAD = new Set(['invalid']);

async function findPerson(playbook, domain, deps = {}, biz = {}) {
  const find = deps.findDomainEmails || H.findDomainEmails;
  const finder = deps.findEmail || H.findEmail;
  const verify = deps.verifyEmail || H.verifyEmail;
  const site = deps.findSiteEmail || ((w, o) => require('../siteEmail').findSiteEmail(w, o));
  const tried = [];

  // 1. Hunter: a named person with a ranked title.
  const r = await find(domain);
  if (r && r.fault) tried.push(`Hunter: ${r.fault.reason || r.fault.outcome}`);
  const hp = !(r && r.fault) ? pick(playbook, r && r.emails) : null;
  if (hp) {
    const v = await verified(verify, hp.email);
    if (!DEAD.has(v.verifyStatus)) {
      return { ok: true, kind: 'named', source: 'hunter',
        person: { first: hp.firstName, last: hp.lastName || '', title: hp.position || '', email: hp.email, confidence: hp.confidence || 0, sourceUrl: hp.sourceUrl || null }, ...v };
    }
    tried.push(`${hp.email} is invalid`);
  }
  if (!(r && r.fault) && !hp) tried.push(r && r.emails && r.emails.length ? 'Hunter: only shared or unranked addresses' : 'Hunter knows no one at this domain');

  // 2. Their own website: who it names, and what it publishes.
  let s = null;
  try { s = await site(biz.website || domain, { brand: biz.name || domain }); } catch (e) { tried.push('website: ' + e.message); }
  if (s && s.outcomeKind && s.outcomeKind !== 'found' && !(s.people && s.people.length)) tried.push('website: ' + (s.failureReason || s.outcomeKind));
  const named = ((s && s.people) || [])
    .map((p) => ({ p, n: splitName(p.name), rank: PB.titleRank(playbook, p.title) }))
    .filter((x) => x.n && x.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank);
  const sitePersonal = s && s.personalEmail && !s.corporate ? String(s.personalEmail).toLowerCase() : null;
  // The site's own personal address, named when its local part is someone the site names.
  if (sitePersonal) {
    const lp = sitePersonal.split('@')[0];
    const who = named.find((x) => lp.includes(x.n.first.toLowerCase()) || lp.includes(x.n.last.toLowerCase()));
    const v = await verified(verify, sitePersonal);
    if (!DEAD.has(v.verifyStatus)) {
      return { ok: true, kind: who ? 'named' : 'address', source: 'website',
        person: { first: who ? who.n.first : '', last: who ? who.n.last : '', title: who ? who.p.title : '', email: sitePersonal, sourceUrl: s.personalSourceUrl || null }, ...v };
    }
    tried.push(`${sitePersonal} is invalid`);
  }
  for (const x of named.slice(0, 2)) {
    const f = await finder(x.n.first, x.n.last, domain);
    if (f && f.fault) { tried.push(`Hunter finder: ${f.fault.reason || f.fault.outcome}`); break; }
    if (f && f.email && String(f.email).toLowerCase().endsWith('@' + domain)) {
      const v = await verified(verify, f.email);
      if (!DEAD.has(v.verifyStatus)) {
        return { ok: true, kind: 'named', source: 'website+hunter',
          person: { first: x.n.first, last: x.n.last, title: x.p.title || '', email: String(f.email).toLowerCase(), confidence: f.score || 0, sourceUrl: x.p.sourceUrl || null }, ...v };
      }
      tried.push(`${f.email} is invalid`);
      continue;
    }
    tried.push(`Hunter has no address for ${x.n.first} ${x.n.last}`);
  }

  // 3. The office inbox.
  const generic = ((r && r.emails) || []).filter((e) => e.type === 'generic').map((e) => e.email);
  const siteRole = s && s.roleEmail && !s.corporate ? s.roleEmail : null;
  const inboxes = [...new Set([siteRole, ...generic].filter(Boolean).map((a) => String(a).toLowerCase()))]
    .filter((a) => inboxRank(a) !== Infinity).sort((a, b) => inboxRank(a) - inboxRank(b)).slice(0, 2);
  for (const inbox of inboxes) {
    const v = await verified(verify, inbox);
    if (DEAD.has(v.verifyStatus)) { tried.push(`${inbox} is invalid`); continue; }
    const owner = named[0];
    return { ok: true, kind: 'inbox', source: inbox === String(siteRole || '').toLowerCase() ? 'website' : 'hunter',
      person: { first: '', last: '', title: 'Office inbox', email: inbox, sourceUrl: (s && s.roleSourceUrl) || null,
        owner: owner ? `${owner.n.first} ${owner.n.last}` + (owner.p.title ? `, ${owner.p.title}` : '') : null }, ...v };
  }
  if (s && s.formUrl) tried.push('website has a contact form only');
  return { ok: false, why: tried.join('; ') || 'no address found', formUrl: (s && s.formUrl) || null };
}

module.exports = { pick, findPerson, splitName, bestInbox, inboxRank, VERIFIED };
