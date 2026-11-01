'use strict';
// ── LOOK UP A LIST OF PEOPLE: OUR OWN SALES LIST ────────────────────────────
//
// Prospector's customers are IT companies. To sell to them we need each owner's
// address: rows of { company, domain, first?, last?, title? }. With a name,
// Hunter's email finder looks that person up; without one (or when the finder
// has nothing), the same ladder Prospector uses for its leads, with the titles
// that buy for an IT company (owner, president, CEO...).
//
// Every address is verified. Only "valid" is called verified; "invalid" is
// never returned as an address.
//
// A job runs in the background and is polled: 50 owners take minutes (the
// finder waits on each company's mail server). Jobs live in memory only; the
// caller keeps the result.

const H = require('../hunterLookup');
const Contacts = require('./contacts');

const SELL = {
  key: 'sell-msp',
  label: 'IT company owner',
  reachTitles: ['owner', 'founder', 'president', 'ceo', 'managing partner', 'principal', 'coo', 'vp of sales', 'sales director', 'general manager'],
  avoidTitles: ['intern', 'technician', 'help desk', 'support', 'student'],
};

const jobs = new Map();
let seq = 0;

function cleanDomain(d) {
  return String(d || '').toLowerCase().replace(/\s*\(.*\)\s*$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
}

async function one(row, deps = {}) {
  const domain = cleanDomain(row.domain);
  if (!domain) return { ...row, ok: false, why: 'no domain' };
  const finder = deps.findEmail || H.findEmail;
  const verify = deps.verifyEmail || H.verifyEmail;
  const first = String(row.first || '').trim(), last = String(row.last || '').trim();
  const tried = [];
  if (first && last) {
    const f = await finder(first, last, domain);
    if (f && f.fault) tried.push(`finder: ${f.fault.reason || f.fault.outcome}`);
    else if (f && f.email) {
      const v = await verify(f.email);
      const status = v && v.ok ? (v.status || v.result || null) : null;
      if (status !== 'invalid') {
        return { ...row, domain, ok: true, kind: 'named', source: 'hunter finder', email: String(f.email).toLowerCase(), first, last,
          title: row.title || '', score: f.score || null, verified: status === 'valid', verifyStatus: status || 'unknown' };
      }
      tried.push(`${f.email} is invalid`);
    } else tried.push(`Hunter has no address for ${first} ${last}`);
  }
  const c = await Contacts.findPerson(SELL, domain, deps, { website: 'https://' + domain, name: row.company || domain });
  if (!c.ok) return { ...row, domain, ok: false, why: [...tried, c.why].filter(Boolean).join('; ') };
  return { ...row, domain, ok: true, kind: c.kind, source: c.source, email: c.person.email, first: c.person.first || '', last: c.person.last || '',
    title: c.person.title || '', verified: c.verified, verifyStatus: c.verifyStatus, note: tried.join('; ') || undefined };
}

function start(rows, deps = {}) {
  const id = ++seq;
  const list = (rows || []).slice(0, 80);
  const job = { id, status: 'running', total: list.length, done: 0, results: new Array(list.length), startedAt: new Date().toISOString() };
  jobs.set(id, job);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const k = i++;
      try { job.results[k] = await one(list[k], deps); }
      catch (e) { job.results[k] = { ...list[k], ok: false, why: 'error: ' + e.message }; }
      job.done++;
    }
  };
  job.promise = Promise.all(Array.from({ length: Math.min(3, list.length) }, worker))
    .then(() => { job.status = 'done'; job.finishedAt = new Date().toISOString(); });
  return job;
}

function get(id) {
  const j = jobs.get(Number(id));
  if (!j) return null;
  const { promise, ...rest } = j;
  return rest;
}

module.exports = { start, get, one, cleanDomain, SELL };
