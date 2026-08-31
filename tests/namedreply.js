'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
process.env.OUTREACH_REPLY_CAPTURE_ENABLED = '1';
process.env.OUTREACH_REPLY_DOMAIN = 'mynildash.com';
const RC = require(REPO + 'server/services/replyCapture.js');

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

// ── local part derivation ───────────────────────────────────────────────────
ok('given names, not just the first token: "John Mark Compton" -> johnmark',
  RC.localPartFrom('John Mark Compton') === 'johnmark', RC.localPartFrom('John Mark Compton'));
ok('a plain two-part name uses the first name', RC.localPartFrom('Jane Smith') === 'jane', RC.localPartFrom('Jane Smith'));
ok('a single-token name uses it whole', RC.localPartFrom('Cher') === 'cher');
ok('punctuation and case are stripped', RC.localPartFrom("Mary-Anne O'Brien") === 'maryanne', RC.localPartFrom("Mary-Anne O'Brien"));
ok('an empty name yields nothing', RC.localPartFrom('   ') === null);
ok('the address is built on the ROOT domain, not a reply subdomain',
  RC.agentReplyAddress('johnmark') === 'johnmark@mynildash.com', RC.agentReplyAddress('johnmark'));

// ── collision ladder ────────────────────────────────────────────────────────
const cands = RC.localPartCandidates('John Mark Compton', 'jm@x.com');
ok('first choice is the clean name', cands[0] === 'johnmark', cands.slice(0, 4));
ok('  then surname initial', cands[1] === 'johnmarkc', cands.slice(0, 4));
ok('  then full surname', cands[2] === 'johnmarkcompton', cands.slice(0, 4));
ok('  and only then a number', cands[3] === 'johnmark2', cands.slice(0, 4));
// "John Smith" -> given names are just ["John"], so the ladder is
// john -> johns -> johnsmith. Two Johns get john@ and johns@, and a third
// falls to johnsmith@ -- all still human-looking.
const johnSmith = RC.localPartCandidates('John Smith', 'a@x.com');
ok('two agents sharing a FIRST name diverge at the surname initial',
  johnSmith[0] === 'john' && johnSmith[1] === 'johns' && johnSmith[2] === 'johnsmith', johnSmith.slice(0, 3));
ok('an agent with no usable name still gets an address from their email',
  RC.localPartCandidates('', 'dana.reed@x.com')[0] === 'danareed',
  RC.localPartCandidates('', 'dana.reed@x.com').slice(0, 2));
ok('reserved local parts are never offered', RC.localPartCandidates('Support Team', 's@x.com').indexOf('support') === -1,
  RC.localPartCandidates('Support Team', 's@x.com').slice(0, 3));
ok('  nor noreply', RC.localPartCandidates('Noreply', 'n@x.com').indexOf('noreply') === -1);

// ── recipient classification ────────────────────────────────────────────────
ok('a named agent address resolves to a local part',
  RC.classifyRecipient('johnmark@mynildash.com').localPart === 'johnmark');
ok('  case-insensitively', RC.classifyRecipient('JohnMark@MyNILDash.com').localPart === 'johnmark');
ok('  and plus-addressing is stripped to the same agent',
  RC.classifyRecipient('johnmark+acme@mynildash.com').localPart === 'johnmark');
ok('a LEGACY token address still resolves exactly (in-flight replies keep working)',
  RC.classifyRecipient('r8b3e030aceadf56c@reply.mynildash.com').logId === 'out_8b3e030aceadf56c',
  RC.classifyRecipient('r8b3e030aceadf56c@reply.mynildash.com'));
ok('  and a token on the NEW domain also resolves', RC.classifyRecipient('r8b3e030aceadf56c@mynildash.com').logId === 'out_8b3e030aceadf56c');
ok('another domain entirely is not ours', RC.classifyRecipient('johnmark@gmail.com') === null);
ok('the catch-all domain still refuses reserved addresses (noreply@ is not an agent)',
  RC.classifyRecipient('noreply@mynildash.com') === null);

// ── matching ────────────────────────────────────────────────────────────────
const R = (id, to, sentAt, replied) => ({ id, sent_to_email: to, sent_at: sentAt, replied_at: replied || null });

let m = RC.matchOutreach([R('out_1', 'dana@acme.com', '2026-08-01')], 'dana@acme.com');
ok('exact sender match resolves to that outreach', m.row.id === 'out_1' && m.precision === 'exact', m);
ok('  and is not flagged ambiguous', m.ambiguous === false);

// The common case: we mailed a general inbox, a human replies from their own.
m = RC.matchOutreach([R('out_2', 'info@acme.com', '2026-08-01')], 'dana@acme.com');
ok('DOMAIN match catches the general-inbox-to-human case', m.row.id === 'out_2' && m.precision === 'domain', m);

m = RC.matchOutreach([R('out_3', 'info@acme.com', '2026-08-01')], 'someone@other.com');
ok('a sender from an unrelated domain matches nothing', m.row === null, m);
ok('  and says why', /no outreach from this agent was sent to/.test(m.reason), m.reason);

// Exact beats domain even when the domain row is newer.
m = RC.matchOutreach([
  R('out_exact', 'dana@acme.com', '2026-08-01'),
  R('out_dom', 'info@acme.com', '2026-08-09'),
], 'dana@acme.com');
ok('an exact match outranks a NEWER domain-only match', m.row.id === 'out_exact', m.row.id);
ok('  and that is unambiguous', m.ambiguous === false);

// THE QUESTION ASKED: same business, two outreaches, same agent.
m = RC.matchOutreach([
  R('out_old', 'info@acme.com', '2026-08-01'),
  R('out_new', 'info@acme.com', '2026-08-09'),
], 'dana@acme.com');
ok('two OPEN outreaches to one business -> attributed to the most recent', m.row.id === 'out_new', m.row.id);
ok('  AND flagged ambiguous rather than silently guessed', m.ambiguous === true, m);
ok('  with a reason naming the count and the domain', /2 open outreaches/.test(m.reason) && /acme\.com/.test(m.reason), m.reason);

// An already-answered older pitch is not competing for this reply.
m = RC.matchOutreach([
  R('out_done', 'info@acme.com', '2026-08-01', '2026-08-02'),
  R('out_open', 'info@acme.com', '2026-08-09'),
], 'dana@acme.com');
ok('an already-replied outreach does not make a second reply ambiguous', m.ambiguous === false, m);
ok('  and the open one wins', m.row.id === 'out_open', m.row.id);

// Rows with no recorded recipient (sent before sent_to_email existed) cannot match.
m = RC.matchOutreach([{ id: 'out_legacy', sent_to_email: null, sent_at: '2026-08-01' }], 'dana@acme.com');
ok('a pre-change row with no sent_to_email is not matchable', m.row === null, m);

ok('emailDomain parses a bare address', RC.emailDomain('Dana <dana@acme.com>') === 'acme.com', RC.emailDomain('Dana <dana@acme.com>'));

// ── wiring ──────────────────────────────────────────────────────────────────
const fs = require('fs');
const outSrc = fs.readFileSync(REPO + 'server/routes/outreach.js', 'utf8');
ok('the send route records who it emailed', /sent_to_email=\$4/.test(outSrc));
ok('the reply-to is the agent address, not a token', /agentReplyAddress\(await ensureReplyLocalPart/.test(outSrc));
ok('the local part is claimed against the unique index, not a pre-flight SELECT',
  /reply_local_part IS NULL RETURNING/.test(outSrc) && /23505/.test(outSrc));
const inSrc = fs.readFileSync(REPO + 'server/routes/resendInbound.js', 'utf8');
ok('the webhook drops mail that is not an agent address', /is not an agent address/.test(inSrc));
ok('an ambiguous match is surfaced to the agent, not hidden', /match && match\.ambiguous/.test(inSrc));

OUT.push(''); OUT.push('failures: ' + FAIL);
console.log(OUT.join('\n'));
process.exit(FAIL ? 1 : 0);
