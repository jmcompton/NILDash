'use strict';
// ── DNS, OFFLINE (for the suites that check mail servers) ──────────────────
//
// services/emailVerify asks DNS whether a domain takes mail (MX, then A /
// AAAA). These suites were written against the live resolver, so with no
// network every domain "did not exist" and every address was refused. This
// answers the way the internet does for the domains the suites use:
//
//   a reserved name (.example, .invalid, .test, .localhost, RFC 2606 / 6761)
//   or one named not to exist          -> ENOTFOUND (the domain does not exist)
//   any other domain                   -> one MX record and an A record
//
// Not a test of DNS: emailVerify's own handling of each answer (null MX,
// implicit MX, a lookup that did not complete) is tested with explicit stubs.
// Lives under tests/helpers/ so the runner (tests/run.js reads tests/*.js)
// never runs it as a suite.
const dns = require('dns').promises;

const NX = /(^|\.)(example|invalid|test|localhost)$|should-not-exist|does-not-exist|nonexistent/i;
const fail = (code) => { const e = new Error(code); e.code = code; return e; };

function install({ nx = NX } = {}) {
  dns.resolveMx = async (d) => { if (nx.test(String(d))) throw fail('ENOTFOUND'); return [{ exchange: 'mx.' + d, priority: 10 }]; };
  dns.resolve4 = async (d) => { if (nx.test(String(d))) throw fail('ENOTFOUND'); return ['192.0.2.10']; };
  dns.resolve6 = async (d) => { if (nx.test(String(d))) throw fail('ENOTFOUND'); throw fail('ENODATA'); };
  return { nx };
}

module.exports = { install, NX };
