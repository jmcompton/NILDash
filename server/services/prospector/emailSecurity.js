'use strict';
// ── SIGNAL: CAN THIS BUSINESS'S EMAIL BE FAKED? ─────────────────────────────
//
// Public DNS only: MX, SPF (TXT on the domain) and DMARC (TXT on _dmarc.).
// Nothing is sent to the business and nothing touches its systems; this is
// the same lookup any mail server does before accepting a message.
//
// A finding is something an IT company can fix and a business owner can
// understand:
//   high    no DMARC record, or no SPF record: anyone can send as @domain
//   medium  DMARC set to monitor only (p=none), or SPF that does not reject
//           unlisted senders (+all / ?all / none)
//   none    protected (DMARC quarantine or reject, SPF ending ~all or -all)
//   skip    no mail server at all (nothing to protect, nobody to email)
//
// Pure decision (assess) is separate from the lookups (check) so it can be
// tested without a network.

const dns = require('dns').promises;

const TIMEOUT_MS = 4000;
const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), TIMEOUT_MS))]);
const joinTxt = (rec) => (Array.isArray(rec) ? rec.join('') : String(rec || ''));

async function txt(name, resolver) {
  try { return (await withTimeout(resolver.resolveTxt(name))).map(joinTxt); }
  catch (e) { if (e && (e.code === 'ENODATA' || e.code === 'ENOTFOUND')) return []; throw e; }
}
async function mx(name, resolver) {
  try { return (await withTimeout(resolver.resolveMx(name))).map((r) => r.exchange); }
  catch (e) { if (e && (e.code === 'ENODATA' || e.code === 'ENOTFOUND')) return []; throw e; }
}

function provider(mxHosts) {
  const s = mxHosts.join(' ').toLowerCase();
  if (!mxHosts.length) return null;
  if (s.includes('google')) return 'Google Workspace';
  if (s.includes('outlook') || s.includes('microsoft')) return 'Microsoft 365';
  if (s.includes('pphosted') || s.includes('proofpoint')) return 'Proofpoint';
  if (s.includes('mimecast')) return 'Mimecast';
  if (s.includes('iphmx')) return 'Cisco';
  return 'other';
}

// { mx: [...], spf: [...], dmarc: [...] } -> the finding.
function assess(domain, rec) {
  const mailHosts = rec.mx || [];
  const spf = (rec.spf || []).filter((t) => /^v=spf1\b/i.test(t.trim()));
  const dmarc = (rec.dmarc || []).filter((t) => /^v=dmarc1\b/i.test(t.trim()));
  const out = { domain, mail: provider(mailHosts), spf: spf[0] || null, dmarc: dmarc[0] || null, level: 'none', problems: [] };
  if (!mailHosts.length) { out.level = 'skip'; out.problems.push('no mail server'); return out; }
  let level = 0;
  const say = (lvl, text, short) => { level = Math.max(level, lvl); out.problems.push(text); if (!out.short) out.short = short; };
  if (!dmarc.length) say(2, `No DMARC record. Anyone can send email pretending to be @${domain}, and many inboxes will accept it.`, 'no DMARC');
  else {
    const p = (dmarc[0].replace(/\s+/g, '').toLowerCase().match(/(^|;)p=([a-z]+)/) || [])[2] || '';
    out.dmarcPolicy = p || null;
    if (!p || p === 'none') say(1, `DMARC is set to monitor only. Fake email from @${domain} is reported, not blocked.`, 'DMARC monitor only');
  }
  if (!spf.length) say(2, `No SPF record, so receiving servers cannot tell which senders are allowed to use @${domain}.`, 'no SPF');
  else {
    if (spf.length > 1) say(2, `Two SPF records. Mail servers ignore both, so @${domain} effectively has none.`, 'duplicate SPF');
    const all = (spf[0].toLowerCase().match(/[-~?+]all\b/) || [])[0] || '';
    out.spfAll = all || null;
    if (!all || all === '+all' || all === '?all') say(1, `SPF does not reject unlisted senders${all ? ' (' + all + ')' : ''}.`, 'weak SPF');
  }
  out.level = level === 2 ? 'high' : level === 1 ? 'medium' : 'none';
  return out;
}

async function check(domain, opts = {}) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return { domain: d, level: 'skip', problems: ['no domain'] };
  const resolver = opts.resolver || dns;
  try {
    const [mxHosts, root, dm] = await Promise.all([mx(d, resolver), txt(d, resolver), txt('_dmarc.' + d, resolver)]);
    return assess(d, { mx: mxHosts, spf: root, dmarc: dm });
  } catch (e) {
    return { domain: d, level: 'error', problems: ['DNS lookup failed: ' + e.message] };
  }
}

module.exports = { check, assess, provider };
