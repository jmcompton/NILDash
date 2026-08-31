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
const d = require(REPO + 'server/services/weeklyDigest.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

// ── Central time, across a DST boundary ─────────────────────────────────────
console.log('-- week start is the Monday in Central --');
// 2026-08-12 is a Wednesday. CDT = UTC-5.
ok('Wednesday resolves to that Monday',
  d.weekStartCentral(Date.parse('2026-08-12T15:00:00Z')) === '2026-08-10',
  d.weekStartCentral(Date.parse('2026-08-12T15:00:00Z')));
ok('Monday resolves to itself',
  d.weekStartCentral(Date.parse('2026-08-10T15:00:00Z')) === '2026-08-10',
  d.weekStartCentral(Date.parse('2026-08-10T15:00:00Z')));
ok('Sunday belongs to the PREVIOUS Monday',
  d.weekStartCentral(Date.parse('2026-08-16T15:00:00Z')) === '2026-08-10',
  d.weekStartCentral(Date.parse('2026-08-16T15:00:00Z')));
// 04:00Z Monday is 23:00 Sunday Central: still last week.
ok('early Monday UTC is still Sunday in Central',
  d.weekStartCentral(Date.parse('2026-08-10T04:00:00Z')) === '2026-08-03',
  d.weekStartCentral(Date.parse('2026-08-10T04:00:00Z')));

console.log('-- DST is handled, not hardcoded --');
// January = CST (UTC-6). 2026-01-14 is a Wednesday.
ok('winter week start',
  d.weekStartCentral(Date.parse('2026-01-14T15:00:00Z')) === '2026-01-12',
  d.weekStartCentral(Date.parse('2026-01-14T15:00:00Z')));
// 05:30Z on Mon 2026-01-12 is 23:30 Sunday CST -> previous week.
ok('winter early-Monday UTC is still Sunday Central',
  d.weekStartCentral(Date.parse('2026-01-12T05:30:00Z')) === '2026-01-05',
  d.weekStartCentral(Date.parse('2026-01-12T05:30:00Z')));
// Same wall clock in summer (CDT, UTC-5): 05:30Z Mon = 00:30 Mon CDT -> this week.
ok('summer 05:30Z Monday IS Monday in Central',
  d.weekStartCentral(Date.parse('2026-08-10T05:30:00Z')) === '2026-08-10',
  d.weekStartCentral(Date.parse('2026-08-10T05:30:00Z')));

console.log('-- the send window opens at 7am Central Monday and stays open --');
ok('Monday 06:59 Central is too early',
  d.sendWindowOpen(Date.parse('2026-08-10T11:59:00Z')) === false,
  d.centralParts(Date.parse('2026-08-10T11:59:00Z')));
ok('Monday 07:00 Central opens it',
  d.sendWindowOpen(Date.parse('2026-08-10T12:00:00Z')) === true,
  d.centralParts(Date.parse('2026-08-10T12:00:00Z')));
ok('Monday 07:03 still sends, a restart does not skip the week',
  d.sendWindowOpen(Date.parse('2026-08-10T12:03:00Z')) === true, null);
ok('Wednesday is open (catch-up)', d.sendWindowOpen(Date.parse('2026-08-12T15:00:00Z')) === true, null);

// ── The never-empty gate ────────────────────────────────────────────────────
const agent = { id: 'a1', name: 'Duncan Reeves', email: 'duncan@x.com' };
const mk = (over) => Object.assign({
  agent, weekStart: '2026-08-10',
  counts: { newMatches: 0, awaitingReply: 0, goingCold: 0 },
  action: null, newOpps: [],
}, over);

console.log('-- never send an empty digest --');
ok('nothing at all: skipped', d.shouldSend(mk()) === false, null);
ok('counts but no action and no opps: STILL skipped',
  d.shouldSend(mk({ counts: { newMatches: 0, awaitingReply: 2, goingCold: 1 } })) === false, null);
ok('the skip reason explains itself',
  /nothing to say/.test(d.skipReason(mk({ counts: { newMatches: 0, awaitingReply: 2, goingCold: 1 } }))),
  d.skipReason(mk({ counts: { newMatches: 0, awaitingReply: 2, goingCold: 1 } })));
ok('an action alone is enough',
  d.shouldSend(mk({ action: { brand_name: 'X', days_since: 5 } })) === true, null);
ok('a new opportunity alone is enough',
  d.shouldSend(mk({ newOpps: [{ brand_name: 'X' }] })) === true, null);

console.log('-- unsubscribe is honored --');
ok('unsubscribed agent never sends',
  d.shouldSend(mk({ agent: { ...agent, digest_unsubscribed: true }, newOpps: [{ brand_name: 'X' }] })) === false, null);
ok('and the reason says so',
  d.skipReason(mk({ agent: { ...agent, digest_unsubscribed: true } })) === 'unsubscribed', null);

// ── Subject lines ───────────────────────────────────────────────────────────
console.log('-- the subject names the content, never generic --');
const s1 = d.buildSubject(mk({
  counts: { newMatches: 3, awaitingReply: 2, goingCold: 0 },
  newOpps: [{ athlete_name: 'Duncan Webb' }, { athlete_name: 'Duncan Webb' }],
}));
ok('names count and athlete and waiting', s1 === '3 new deals for Duncan and 2 people waiting on you', s1);
const s2 = d.buildSubject(mk({
  counts: { newMatches: 1, awaitingReply: 0, goingCold: 0 },
  newOpps: [{ athlete_name: 'Maya Ortiz' }],
}));
ok('singular deal, no waiting clause', s2 === '1 new deal for Maya', s2);
const s3 = d.buildSubject(mk({
  counts: { newMatches: 2, awaitingReply: 0, goingCold: 0 },
  newOpps: [{ athlete_name: 'Duncan Webb' }, { athlete_name: 'Maya Ortiz' }],
}));
ok('two athletes both named', s3 === '2 new deals for Duncan and Maya', s3);
const s4 = d.buildSubject(mk({
  counts: { newMatches: 0, awaitingReply: 0, goingCold: 1 },
  action: { brand_name: 'Riverside Coffee', days_since: 21 },
}));
ok('action-only subject names the business and the wait',
  s4 === '1 person waiting on you', s4);
const s5 = d.buildSubject(mk({ action: { brand_name: 'Riverside Coffee', days_since: 21 } }));
ok('with zero counts it falls back to the business name',
  s5 === 'Riverside Coffee has not replied in 21 days', s5);
for (const s of [s1, s2, s3, s4, s5]) {
  ok(`"${s}" is not generic`, !/weekly summary|weekly update|your week/i.test(s), s);
  ok(`"${s}" is non-empty`, s.length > 0, s);
}

// ── Rendering ───────────────────────────────────────────────────────────────
console.log('-- the email renders, mobile first --');
const rich = mk({
  counts: { newMatches: 3, awaitingReply: 2, goingCold: 1 },
  action: {
    brand_name: 'Riverside Coffee Co', contact_name: 'Sample Contact', contact_title: 'Owner',
    contact_email: 'owner@riverside.example', athlete_name: 'Duncan Webb', days_since: 9,
    subject: 'Partnership with Duncan Webb',
    followUpSubject: 'Re: Partnership with Duncan Webb',
    followUpBody: 'Following up on my note about Duncan. Would Thursday work for a quick call?',
  },
  newOpps: [
    { brand_name: 'Northside Auto', athlete_name: 'Duncan Webb', compatibility_score: 82,
      contact_name: 'Sample Manager', contact_title: 'GM', contact_email: 'gm@northside.example' },
    { brand_name: 'Lakeview Dental', athlete_name: 'Maya Ortiz', compatibility_score: 71, contact_name: null },
  ],
});
const html = d.renderHtml(rich, { appUrl: 'https://mynildash.com', unsubToken: 'tok123' });

ok('has a viewport meta for phones', /name="viewport"/.test(html), null);
ok('single column: no float and no multi-column body layout',
  !/float:\s*(left|right)/i.test(html), null);
// Single column means: no ROW anywhere holds more than one cell, except the counts
// strip, which is three short numbers and is legible at 320px.
// Nested tables defeat regex row-matching, so assert the property directly:
// two cells sitting SIDE BY SIDE means </td> immediately followed by <td>.
const adjacent = html.match(/<\/td>\s*<td/g) || [];
ok('only two side-by-side cell joins exist, the counts strip', adjacent.length === 2, adjacent.length);
const statCells = html.match(/<td align="center" style="padding:10px 4px">/g) || [];
ok('and they belong to the 3-cell counts strip', statCells.length === 3, statCells.length);
ok('the counts strip cells are the ones carrying the labels',
  (html.match(/new matches|awaiting reply|going cold/g) || []).length === 3,
  (html.match(/new matches|awaiting reply|going cold/g) || []).length);
// A fixed-width cell is the other way a phone layout breaks.
ok('no cell declares a fixed pixel width', !/<td[^>]*width="\d/.test(html), null);
const btns = html.match(/min-height:44px/g) || [];
ok('every button declares a 44px minimum tap target', btns.length >= 2, btns.length);
ok('the unsubscribe link is also a 44px target', /min-height:44px;line-height:44px/.test(html), null);
ok('max width is phone friendly', /max-width:520px/.test(html), null);

console.log('-- content order: counts, then DO THIS FIRST, then opportunities, then CTA --');
const iCounts = html.indexOf('new matches');
const iAction = html.indexOf('DO THIS FIRST');
const iOpps = html.indexOf('New this week');
const iCta = html.indexOf('Open Deal Scan');
ok('counts come first', iCounts > 0 && iCounts < iAction, { iCounts, iAction });
ok('DO THIS FIRST comes before the opportunities', iAction < iOpps, { iAction, iOpps });
ok('opportunities come before the CTA', iOpps < iCta, { iOpps, iCta });
ok('exactly one Open Deal Scan button', (html.match(/Open Deal Scan/g) || []).length === 1, null);

console.log('-- the action block carries the draft and a working button --');
ok('names the person', /Sample Contact/.test(html), null);
ok('names the business', /Riverside Coffee Co/.test(html), null);
ok('includes the drafted body', /Would Thursday work/.test(html), null);
ok('the button is a mailto with the draft prefilled', /href="mailto:owner%40riverside\.example\?subject=/.test(html), null);
ok('the draft body is in the mailto', /Following%20up%20on%20my%20note/.test(html), null);

console.log('-- opportunities show business, athlete, fit and contact --');
ok('business', /Northside Auto/.test(html), null);
ok('athlete', /Duncan Webb/.test(html), null);
ok('fit score', /fit 82/.test(html), null);
ok('contact', /gm@northside\.example/.test(html), null);
ok('a missing contact says so rather than showing nothing',
  /No contact found yet/.test(html), null);

console.log('-- unsubscribe link is present and tokenised --');
ok('token in the url', /token=tok123/.test(html), null);
ok('no raw email address used as the unsubscribe key', !/unsubscribe\?email=/.test(html), null);

console.log('-- escaping --');
const nasty = mk({
  counts: { newMatches: 1, awaitingReply: 0, goingCold: 0 },
  newOpps: [{ brand_name: '<script>alert(1)</script>', athlete_name: 'A B', compatibility_score: 50 }],
});
const nastyHtml = d.renderHtml(nasty, {});
ok('a brand name cannot inject script', !/<script>alert/.test(nastyHtml), null);
ok('it is escaped instead', /&lt;script&gt;/.test(nastyHtml), null);

console.log('-- plain text alternative --');
const text = d.renderText(rich);
ok('has the counts', /3 new matches \| 2 awaiting reply \| 1 going cold/.test(text), text.slice(0, 80));
ok('has the action', /DO THIS FIRST/.test(text), null);
ok('has the draft', /Would Thursday work/.test(text), null);
ok('has no html tags', !/<[a-z]/i.test(text), text);

// ── The drafted follow-up ───────────────────────────────────────────────────
console.log('-- follow-up drafting --');
(async () => {
  const action = { brand_name: 'Riverside', contact_name: 'Sample Contact', athlete_name: 'Duncan Webb', days_since: 9, subject: 'Partnership' };

  const noAi = await d.draftFollowUp(action, null);
  ok('works with no AI at all', !!noAi.body && noAi.body.length > 20, noAi);
  ok('the fallback names the contact', /Sample/.test(noAi.body), noAi.body);

  let captured = null;
  const fakeAi = { oneShot: async (p, s, max, model) => { captured = { p, s, max, model }; return '{"subject":"Re: Partnership","body":"Short and specific."}'; } };
  const good = await d.draftFollowUp(action, fakeAi);
  ok('parses the model reply', good.body === 'Short and specific.', good);
  ok('NO model override is passed, so ai.oneShot uses its Sonnet default',
    captured.model === undefined, captured.model);
  ok('token budget is small', captured.max <= 400, captured.max);

  const badAi = { oneShot: async () => 'not json at all' };
  const bad = await d.draftFollowUp(action, badAi);
  ok('a bad model reply degrades to the template, it does not throw',
    !!bad.body && bad.body.length > 20, bad);
  const throwAi = { oneShot: async () => { throw new Error('rate limited'); } };
  const threw = await d.draftFollowUp(action, throwAi);
  ok('a model outage degrades too', !!threw.body, threw);

  ok('no action means no draft and no AI call', (await d.draftFollowUp(null, fakeAi)) === null, null);

  console.log('');
  console.log('failures: ' + fails);
  process.exit(fails ? 1 : 0);
})();
