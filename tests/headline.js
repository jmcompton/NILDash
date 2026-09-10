'use strict';
// Runs from a checkout on any machine and needs NO database.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/headline.js       just this one

// ── THE FIRST LINE OF THE MORNING ───────────────────────────────────────────
//
// The 7am email and Home both opened with `sentence` -- what the overnight job
// DID. On a slow night with a full queue that read:
//
//   "Your team wrote one pitch. Across 1 of 9 athletes, 8 had nothing new to work"
//
// while the same email listed 54 cards ready to work and 32 pitches waiting on
// approval. True, and completely misleading: an agent with a full morning
// opened an email that read like the product had done nothing.
//
// The lead is now `headline` -- what is WAITING on the agent -- and the run
// sentence is the second line, prefixed "Last night:". This suite pins:
//
//   1. A full queue leads with the queue, never with what the job wrote.
//   2. The headline ranks the same way the subject does: hold > reply > pile.
//      A body that led with a different fact than its own subject would be a
//      second copy of the same bug.
//   3. The run sentence is not lost -- it is second, and prefixed.
//   4. Both the email (html AND text) and the page render in that order.
//
// buildHeadline is pure, so the report is synthesised here; nothing about the
// database is under test.

const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const fs = require('fs');
const { buildHeadline } = require(REPO + 'server/services/shiftReport');
const { renderShiftEmail } = require(REPO + 'server/services/shiftEmail');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

// The exact morning from the bug report: one pitch written, nine athletes,
// eight blank -- and 54 cards plus 32 pitches waiting.
const SLOW_NIGHT_FULL_QUEUE = {
  run: { ran: true, finished: true, inProgress: false },
  sentence: 'Your team wrote one pitch.',
  coverage: { line: 'Across 1 of 9 athletes — 8 had nothing new to work' },
  needsYou: { items: [
    { kind: 'approve', id: 'ready', priority: 1, count: 10, total: 54, line: '54 cards ready to work' },
  ], overflow: 0, total: 1 },
  closer: { pendingApproval: 32, byAthlete: [] },
};
const rep = (over) => Object.assign({}, SLOW_NIGHT_FULL_QUEUE, over);

// ── 1. THE BUG, EXACTLY ───────────────────────────────────────────────────
{
  const h = buildHeadline(SLOW_NIGHT_FULL_QUEUE);
  ok('a full queue on a slow night leads with the queue',
    h === '54 cards are ready to work and 32 pitches are waiting on your approval.', h);
  ok('  and never with what the job wrote', !/wrote|nothing new/.test(h), h);
  const r = rep({ headline: h });
  const mail = renderShiftEmail(r, { appUrl: 'https://app.test', agentName: 'Sam Rivera' });
  const iHead = mail.html.indexOf('54 cards are ready to work');
  const iRun = mail.html.indexOf('wrote one pitch');
  ok('the email bolds the headline first', iHead > -1 && iRun > -1 && iHead < iRun, { iHead, iRun });
  ok('  the run sentence is still there, one line down', iRun > -1, null);
  ok('  and is prefixed so it cannot be read as the lead', /Last night: Your team wrote one pitch\./.test(mail.html), null);
  ok('  coverage still follows the run line', mail.html.indexOf('Across 1 of 9') > iRun, null);
  const tHead = mail.text.indexOf('54 cards are ready'), tRun = mail.text.indexOf('Last night: Your team wrote');
  ok('the plain-text part is in the same order', tHead > -1 && tRun > tHead, { tHead, tRun });
  ok('the subject and the headline agree on the lead fact', /54 cards ready to work/.test(mail.subject), mail.subject);
}

// ── 2. SAME PRIORITY AS THE SUBJECT ───────────────────────────────────────
{
  const withReply = rep({ needsYou: { items: [
    { kind: 'reply', id: 'r1', priority: 0, count: 1, line: 'Ourisman Chevrolet of Bowie replied about Kaden House' },
    { kind: 'approve', id: 'ready', priority: 1, count: 10, total: 54, line: '54 cards ready to work' },
  ], overflow: 0, total: 2 } });
  const h = buildHeadline(withReply);
  ok('a reply outranks the pile', /^A brand replied/.test(h), h);
  ok('  and the pile still rides along', h === 'A brand replied — and 32 pitches are ready to send.', h);
  const m = renderShiftEmail(Object.assign({}, withReply, { headline: h }), { appUrl: 'https://app.test' });
  ok('  the subject leads with the brand by name', /^Ourisman Chevrolet of Bowie replied/.test(m.subject), m.subject);
  // The reply block, directly beneath, is where the name lives in the body --
  // with the button. The headline must not restate it: the same sentence three
  // times on one screen is what the first draft of this did.
  ok('  the body names the brand exactly once, in the reply block',
    (m.html.match(/Ourisman Chevrolet of Bowie replied/g) || []).length === 1,
    (m.html.match(/Ourisman Chevrolet of Bowie replied/g) || []).length);
  ok('  and the block still sits above NEEDS YOU',
    m.html.indexOf('A BRAND REPLIED') > -1 && m.html.indexOf('A BRAND REPLIED') < m.html.indexOf('NEEDS YOU'), null);

  const two = rep({ needsYou: { items: [
    { kind: 'reply', id: 'r1', priority: 0, count: 1, line: 'A replied about X' },
    { kind: 'reply', id: 'r2', priority: 0, count: 1, line: 'B replied about Y' },
  ], overflow: 0, total: 2 }, closer: { pendingApproval: 0 } });
  ok('two replies are counted, not listed', buildHeadline(two) === '2 brands replied.', buildHeadline(two));

  const hold = rep({ needsYou: { items: [
    { kind: 'compliance', id: 'h1', priority: -1, count: 1, severity: 'block',
      line: 'Kaden House × Bowie Liquors is held: alcohol, athlete under 21' },
    { kind: 'reply', id: 'r1', priority: 0, count: 1, line: 'A replied about X' },
  ], overflow: 0, total: 2 } });
  const hh = buildHeadline(hold);
  ok('a hold outranks a reply', /^Cannot send: Kaden House × Bowie Liquors is held/.test(hh), hh);
  const mh = renderShiftEmail(Object.assign({}, hold, { headline: hh }), { appUrl: 'https://app.test' });
  ok('  and so does the subject', /^Cannot send: /.test(mh.subject), mh.subject);
  const softHold = rep({ needsYou: { items: [
    { kind: 'compliance', id: 'h1', priority: -1, count: 1, severity: 'warn', line: 'One pitch needs a date of birth' },
  ], overflow: 0, total: 1 } });
  ok('  a non-blocking hold says On hold, not Cannot send', /^On hold: /.test(buildHeadline(softHold)), buildHeadline(softHold));
  const manyHolds = rep({ needsYou: { items: [
    { kind: 'compliance', severity: 'block', line: 'a' }, { kind: 'compliance', severity: 'warn', line: 'b' },
    { kind: 'compliance', severity: 'block', line: 'c' },
  ], overflow: 0, total: 3 } });
  ok('  several holds are counted with the blocked subset',
    buildHeadline(manyHolds) === '3 pitches on hold — 2 cannot be sent.', buildHeadline(manyHolds));
}

// ── 3. THE PILE IN ITS UNITS ──────────────────────────────────────────────
{
  const same = rep({ needsYou: { items: [
    { kind: 'approve', total: 32, count: 10, line: '32 cards ready to work' } ], overflow: 0, total: 1 },
    closer: { pendingApproval: 32 } });
  ok('when the pitches ARE the pile, only that is named',
    buildHeadline(same) === '32 pitches are waiting on your approval.', buildHeadline(same));
  const cardsOnly = rep({ closer: { pendingApproval: 0 } });
  ok('cards with nothing to approve', buildHeadline(cardsOnly) === '54 cards are ready to work.', buildHeadline(cardsOnly));
  const one = rep({ needsYou: { items: [
    { kind: 'approve', total: 1, count: 1, line: '1 card ready to work' } ], overflow: 0, total: 1 },
    closer: { pendingApproval: 1 } });
  ok('singular agrees', buildHeadline(one) === '1 pitch is waiting on your approval.', buildHeadline(one));
  const prog = rep({ needsYou: { items: [
    { kind: 'queue', id: 'programs', total: 3, count: 3, line: '3 programme applications waiting' } ], overflow: 0, total: 1 },
    closer: { pendingApproval: 0 } });
  ok('programme applications when that is all there is',
    buildHeadline(prog) === '3 programme applications are waiting.', buildHeadline(prog));
}

// ── 4. NOTHING WAITING, AND NO RUN ────────────────────────────────────────
{
  const quiet = rep({ needsYou: { items: [], overflow: 0, total: 0 }, closer: { pendingApproval: 0 } });
  const h = buildHeadline(quiet);
  ok('nothing waiting is said plainly', h === 'Nothing is waiting on you.', h);
  const m = renderShiftEmail(Object.assign({}, quiet, { headline: h }), { appUrl: 'https://app.test' });
  ok('  and the run sentence explains why, beneath it',
    m.html.indexOf('Nothing is waiting on you') < m.html.indexOf('Last night: Your team wrote one pitch'), null);
  ok('no run at all yields no headline', buildHeadline({ run: { ran: false }, needsYou: { items: [] } }) === null, null);
  ok('  and a missing report yields null, not a throw', buildHeadline() === null, null);
  // A report from before this field existed still renders: the sentence leads,
  // with no "Last night:" prefix, because there is nothing above it.
  const legacy = rep({ headline: undefined });
  const ml = renderShiftEmail(legacy, { appUrl: 'https://app.test' });
  ok('a report without a headline falls back to the sentence as the lead',
    /<b>Your team wrote one pitch\.<\/b>/.test(ml.html) && !/Last night:/.test(ml.html), null);
}

// ── 5. THE PAGE RENDERS IN THE SAME ORDER ─────────────────────────────────
{
  const html = fs.readFileSync(REPO + 'public/index.html', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const i = html.indexOf('class="sr-sentence">');
  const block = html.slice(i, i + 400);
  ok('Home leads with d.headline', /hmEsc\(d\.headline \|\| d\.sentence\)/.test(block), block.slice(0, 120));
  ok('  and prefixes the run sentence beneath it', /'Last night: ' \+ d\.sentence/.test(html), null);
  const rep2 = fs.readFileSync(REPO + 'server/services/shiftReport.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok('the report carries headline next to sentence',
    /headline: buildHeadline\(\{ needsYou, closer: closerBlock/.test(rep2), null);
  const route = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('  and the route spreads the report, so headline reaches the page',
    /const \{ roles, \.\.\.home \} = r;/.test(route), null);
}

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
