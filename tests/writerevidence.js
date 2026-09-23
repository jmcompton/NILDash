'use strict';
// Runs against the local test Postgres (the pool round trip). No network and
// no model: the writer is driven with a stub.
//
//   node tests/run.js                 every suite, against the committed baseline
//   node tests/writerevidence.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE EVIDENCE REACHES THE WRITER, AND THE WRITER IS HELD TO IT ───────────
//
// Discovery found marketing-activity evidence per business and used it only to
// rank; the queue handed the writer siteSummary: null and sponsorsLocal: null.
// Now the writer gets the evidence, and the rule is narrow: exactly one line,
// meaning what it says, and nothing else about the business. No evidence,
// nothing about the business, same as before.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const WE = require(REPO + 'server/services/writerEvidence.js');
const PW = require(REPO + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

const SCAN = 'Sponsors Homewood High athletics';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));

  // ── 1. WHAT GOES IN: PUBLIC EVIDENCE ONLY ────────────────────────────────
  OUT.push('-- what the writer is handed --');
  ok('the scan line goes in', JSON.stringify(WE.evidenceFor({ evidence_text: SCAN })) === JSON.stringify([SCAN]));
  ok('  as does a publicly reported deal',
    WE.evidenceFor({ sponsorSignal: { kind: 'reported-deal-at-school', detail: 'publicly reported an NIL deal with an athlete at Auburn' } })[0]
      === 'Publicly reported an NIL deal with an athlete at Auburn');
  ok('  and a programme\'s own offer page', WE.evidenceFor({ offerSummary: 'Runs a student-athlete ambassador program.' })[0]
    === 'Runs a student-athlete ambassador program');
  ok('THE AGENT\'S OWN BOOK NEVER GOES IN',
    WE.evidenceFor({ sponsorSignal: { kind: 'agent-closed-at-school', detail: 'you have already closed a deal with them at Auburn' } }).length === 0);
  ok('INBOX-DERIVED REPLIES NEVER GO IN',
    WE.evidenceFor({ sponsorSignal: { kind: 'replied-at-school', detail: 'replied to outreach for another Auburn athlete' } }).length === 0);
  ok('OTHER AGENTS\' DEALS NEVER GO IN', WE.evidenceFor({ nilFlags: { nilActive: true } }).length === 0);
  ok('a national lane\'s evidence OBJECT is not a sentence and is ignored',
    WE.evidenceFor({ evidence: { kind: 'deals', deals: [{ athlete: 'x' }] } }).length === 0);
  ok('dashes are cleaned and a one-word line is dropped',
    JSON.stringify(WE.evidenceFor({ evidence_text: 'Sponsors — Homewood High', offerSummary: 'Sponsors' })) === '["Sponsors, Homewood High"]');

  // ── 2. WHAT THE WRITER IS TOLD ───────────────────────────────────────────
  OUT.push('', '-- the prompt --');
  const withEv = PW.describeBusiness({ name: 'Trak Shak', evidence: [SCAN, 'Runs local radio ads'] });
  ok('the evidence is listed, numbered', /EVIDENCE OF THEIR MARKETING ACTIVITY[^\n]*\n  1\. Sponsors Homewood High athletics\n  2\. Runs local radio ads/.test(withEv), withEv);
  const noEv = PW.describeBusiness({ name: 'Trak Shak' });
  ok('with none, the block says to say nothing about the business', /none supplied\. The message says nothing about this business at all/.test(noEv), noEv);
  ok('the two dead fields are gone', !/What their own website says|already sponsor local teams/.test(PW.describeBusiness({ siteSummary: 'x', sponsorsLocal: true })));
  ok('the rule is in both system prompts', /ONE FACT ABOUT THE BUSINESS, FROM THE EVIDENCE, OR NONE/.test(PW.SYSTEM)
    && /ONE FACT ABOUT THE BUSINESS, FROM THE EVIDENCE, OR NONE/.test(PW.SYSTEM_PRO));
  ok('  and the old ban on any business fact is replaced, not left beside it', !/DO NOT WRITE ABOUT THE BRAND/.test(PW.SYSTEM));
  ok('the model reports which line it used', /"evidenceUsed": the number of the ONE evidence line/.test(
    PW.buildPrompt({ agentFirstName: 'Sam', business: { name: 'X' }, athlete: { name: 'Jo Doe' } })));

  // ── 3. THE CHECK ─────────────────────────────────────────────────────────
  OUT.push('', '-- checkEvidence --');
  const EV = [SCAN, 'Runs local radio ads'];
  const M1 = 'Hi Dana, I saw you sponsor Homewood High athletics. Jo Doe plays basketball at Alabama.';
  let c = PW.checkEvidence(M1, EV, 1);
  ok('one line, stated as written: accepted', c.ok && c.used === 1, c);
  c = PW.checkEvidence(M1, EV, 0);
  ok('  an undeclared line that is plainly stated still counts as the one', c.ok && c.used === 1, c);
  c = PW.checkEvidence('Hi Dana, Jo Doe plays basketball at Alabama.', EV, 1);
  ok('claims line 1 but never says it: rejected', !c.ok && /does not say it/.test(c.problems.join()), c);
  c = PW.checkEvidence(M1, EV, 7);
  ok('cites a line that was not supplied: rejected', !c.ok && /was not supplied/.test(c.problems.join()), c);
  c = PW.checkEvidence(M1, [], 1);
  ok('cites evidence when none was supplied: rejected', !c.ok, c);
  c = PW.checkEvidence(M1 + ' Your local radio ads caught my ear too.', EV, 1);
  ok('TWO FACTS: rejected', !c.ok && /more than one fact/.test(c.problems.join()), c);
  c = PW.checkEvidence('Hi Dana, as a family-owned shop you know the town. Jo Doe plays basketball.', [], 0);
  ok('NO EVIDENCE, but a stock claim ("family-owned"): rejected', !c.ok && /family-owned/.test(c.problems.join()), c);
  c = PW.checkEvidence('Hi Dana, with 300 reviews on Google you are busy.', EV, 0);
  ok('  reviews are a claim the evidence did not make: rejected', !c.ok && /reviews/.test(c.problems.join()), c);
  c = PW.checkEvidence('Hi Dana, I saw the shop is family-owned since 1987.', ['Family-owned since 1987'], 1);
  ok('  but a claim the stated line itself makes is allowed', c.ok, c);
  c = PW.checkEvidence('Hi Dana, Jo Doe plays basketball at Alabama and posts every game day.', [], 0);
  ok('no evidence and nothing about the business: accepted', c.ok, c);

  // ── 4. THE WRITER, END TO END ────────────────────────────────────────────
  OUT.push('', '-- writePitch --');
  const BODY = (biz) => 'Hi Dana,\n\n' + biz + 'I work with Jo Doe, who plays basketball at Alabama. '
    + 'Her feed is training days and game days. She would be glad to talk about a partnership. '
    + 'Would you like to learn more about this NIL opportunity with Jo?\n\nSam';
  const stub = (msgs, used) => { let i = 0; const calls = { n: 0 };
    const f = async () => { calls.n++; const m = msgs[Math.min(i++, msgs.length - 1)];
      return JSON.stringify({ angle: 'a', angleKey: 'a', ask: 'a', confidence: 'strong', evidenceUsed: used, message: m }); };
    f.calls = calls; return f; };
  const ctx = (evidence) => ({ agentFirstName: 'Sam', channel: 'email',
    business: { name: 'Trak Shak', greetFirstName: 'Dana', ownerName: 'Dana Roberts', evidence },
    athlete: { name: 'Jo Doe', sport: 'basketball', school: 'Alabama' } });

  let one = stub([BODY('I saw you sponsor Homewood High athletics. ')], 1);
  let r = await PW.writePitch(ctx([SCAN]), { oneShot: one });
  ok('WITH EVIDENCE, the pitch states the one line and is accepted', !r.skipped && /sponsor Homewood High athletics/.test(r.message), r);
  ok('  and says which line it rests on', r.evidenceUsed === 1 && JSON.stringify(r.evidence) === JSON.stringify([SCAN]), r);

  one = stub([BODY('I saw you sponsor Homewood High athletics, and your 5-star reviews show it. ')], 1);
  r = await PW.writePitch(ctx([SCAN]), { oneShot: one });
  ok('evidence plus an invented claim is retried, then refused', r.skipped === true && one.calls.n === 2
    && /not in the evidence/.test(r.reason), { r, calls: one.calls.n });

  one = stub([BODY('You have been a local favorite since 1987. '), BODY('')], 0);
  r = await PW.writePitch(ctx([]), { oneShot: one });
  ok('WITHOUT EVIDENCE, a business claim is rejected and the clean retry is accepted',
    !r.skipped && !/1987/.test(r.message) && one.calls.n === 2 && r.evidenceUsed === 0, r);

  // ── 5. THE QUEUE PASSES IT, AND THE POOL KEEPS IT ────────────────────────
  OUT.push('', '-- wiring --');
  const job = read('server/jobs/outreachQueue.js');
  ok('both writer calls in the queue pass the evidence',
    (job.match(/evidence: WriterEvidence\.evidenceFor\(cand\),/g) || []).length === 2);
  ok('  and neither passes the two hard-wired nulls any more', !/siteSummary:|sponsorsLocal:/.test(job));
  const scout = read('server/services/scout.js');
  ok('both local pools carry the line, as evidence_text',
    /m\.evidence AS evidence_text/.test(scout) && /AS evidence_text\s*\n\s*FROM brand_engagement be/.test(scout));
  ok('  and the shown pool\'s ranking input is unchanged (it reads the line only, never has_evidence)',
    /\(SELECT ms\.evidence FROM market_business_seen ms/.test(scout) && !/ms\.has_evidence/.test(scout));

  const P = store.pool;
  const town = 'Evidenceville, AL';
  const { marketPoolKey } = require(REPO + 'server/services/regionKey');
  const key = marketPoolKey(town);
  await P.query('DELETE FROM market_business_seen WHERE market_key = $1', [key]).catch(() => {});
  await store.recordMarketPool([{ name: 'Trak Shak Evidenceville', evidence: SCAN, market: 'school', category: 'store' },
    { name: 'Quiet Cafe Evidenceville', evidence: null, market: 'school' }], { schoolMarket: town });
  let rows = (await P.query('SELECT brand, has_evidence, evidence FROM market_business_seen WHERE market_key = $1 ORDER BY brand', [key])).rows;
  const ts = rows.find((x) => x.brand === 'Trak Shak Evidenceville');
  ok('THE POOL KEEPS THE LINE, not just the flag', ts && ts.evidence === SCAN && ts.has_evidence === true, rows);
  await store.recordMarketPool([{ name: 'Trak Shak Evidenceville', market: 'school' }], { schoolMarket: town });
  rows = (await P.query('SELECT evidence FROM market_business_seen WHERE market_key = $1 AND brand = $2', [key, 'Trak Shak Evidenceville'])).rows;
  ok('  and a thinner rescan does not erase it', rows[0] && rows[0].evidence === SCAN, rows);
  await P.query('DELETE FROM market_business_seen WHERE market_key = $1', [key]).catch(() => {});

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('writerevidence: FAILED', e); process.exit(1); });
