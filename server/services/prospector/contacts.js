'use strict';
// ── THE PERSON TO WRITE TO, AND IS THEIR ADDRESS REAL? ──────────────────────
//
// Hunter's domain search lists the people it has seen at the domain. The best
// one is the highest-ranked title for the playbook (owner and office manager
// for an IT company's prospect; HR and operations for a staffing agency's),
// a named personal address only: never info@ or office@, which reach nobody
// in particular. Then Hunter's verifier: only "valid" counts as verified.
// "accept_all" (a catch-all domain) is kept but marked, never called verified.
//
// Both calls go through services/hunterLookup, so they share NILDash's key,
// cache, monthly budget, pacing and fault log. Nothing here spends past them.

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

const VERIFIED = new Set(['valid']);

async function findPerson(playbook, domain, deps = {}) {
  const find = deps.findDomainEmails || H.findDomainEmails;
  const verify = deps.verifyEmail || H.verifyEmail;
  const r = await find(domain);
  if (r && r.fault) return { ok: false, why: `Hunter: ${r.fault.reason || r.fault.outcome}` };
  const person = pick(playbook, r && r.emails);
  if (!person) return { ok: false, why: r && r.emails && r.emails.length ? 'only shared or unranked addresses' : 'Hunter knows no one at this domain' };
  const v = await verify(person.email);
  const status = v && v.ok ? (v.status || v.result || null) : null;
  return {
    ok: true,
    person: { first: person.firstName, last: person.lastName || '', title: person.position || '', email: person.email, confidence: person.confidence || 0, sourceUrl: person.sourceUrl || null },
    verified: VERIFIED.has(String(status)),
    verifyStatus: status || (v && v.why) || 'unknown',
  };
}

module.exports = { pick, findPerson, VERIFIED };
