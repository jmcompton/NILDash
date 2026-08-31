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
// "PHONE FOUND 20/20" IS NOT A MEASUREMENT.
//
// A restaurant's landline and a sole proprietor's cell are different channels.
// One is a call at 2pm on a Tuesday; the other is a text. The sampler counted
// them as the same thing.
//
// Two classifications, and only one of them costs money:
//
//   KIND       main line vs a named person's direct line. FREE -- the ladder
//              already decides this (phoneKind 'direct' is set only when a
//              contact's own digits differ from the business main line).
//   LINE TYPE  mobile vs landline vs voip. Needs a live carrier lookup, because
//              US number portability means NPA-NXX no longer says which. Off
//              unless --carrier is passed, so a run never spends by accident.
//
// The headline number is NAMED + MOBILE: a person we can name and a number we can
// text. Split by whose number it is, because "her own cell" and "the shop line
// that happens to be a mobile" are not equally good.
const fs = require('fs');
const R = REPO;
let f = 0;
const ok = (n, c, got) => {
  if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); }
  else console.log('  PASS ' + n);
};

const S = require(R + 'scripts/ladder-sample.js');
const LT = (() => { try { return require(R + 'scripts/line-type.js'); } catch (_) { return null; } })();
const { buildContactLadder } = require(R + 'server/services/contactLadder');

const AI = fs.readFileSync(R + 'server/ai.js', 'utf8');
const rankOf = (() => {
  const sig = 'function _contactAuthorityRank(title) {';
  const start = AI.indexOf(sig);
  let d = 0, j = AI.indexOf('{', start), end = j;
  for (; j < AI.length; j++) { if (AI[j] === '{') d++; else if (AI[j] === '}') { d--; if (!d) { end = j; break; } } }
  return new Function(AI.slice(start, end + 1) + '\n return _contactAuthorityRank;')();
})();
const mk = (res, b) => buildContactLadder(res, {
  rankOf, rootDomain: (u) => String(u || '').replace(/^https?:\/\//, '').split('/')[0], category: null, brand: b || 'X',
});
const row = (brand, res, lines) => S.classify(brand, res, mk(res, brand),
  { served: 'web', cost: S.costOf({}, 6000) }, lines);

const MAIN = '(205) 555-0100';
const CELL = '(205) 555-0199';

(async () => {
  console.log('-- MAIN LINE VS A NAMED PERSON\'S DIRECT LINE, WHICH IS FREE --');
  {
    const r = row('Shop Only', { contacts: [], businessPhone: MAIN });
    ok('a business with only a shop number is a MAIN line', r.phoneKind === 'mainline', r.phoneKind);
    ok('  it has no direct line', r.directPhone === null, r.directPhone);
    ok('  and the main line is recorded', r.mainLinePhone === MAIN, r.mainLinePhone);
  }
  {
    // The ladder donates the main line to a named contact who has none. That is
    // "ask for Bryan", NOT a direct line, and it must not be counted as one.
    const r = row('Ask For Bryan', {
      contacts: [{ name: 'Bryan Hembree', title: 'Owner', phone: MAIN, affiliationScope: 'this-location' }],
      businessPhone: MAIN,
    });
    ok('a named person on the SHARED number is still a main line', r.phoneKind === 'mainline', r.phoneKind);
    ok('  and gets no direct number', r.directPhone === null, r.directPhone);
  }
  {
    const r = row('Own Cell', {
      contacts: [{ name: 'Dawn Mercer', title: 'Owner', phone: CELL, affiliationScope: 'this-location' }],
      businessPhone: MAIN,
    });
    ok('a genuinely different number IS a direct line', r.phoneKind === 'direct', r.phoneKind);
    ok('  and is attributed to her', r.directPhone === CELL && r.directName === 'Dawn Mercer', [r.directPhone, r.directName]);
    ok('  the main line is still recorded separately', r.mainLinePhone === MAIN, r.mainLinePhone);
  }

  console.log('\n-- THE LINE TYPE LOOKUP --');
  ok('scripts/line-type.js exists', !!LT);
  if (LT) {
    {
      let calls = 0;
      const provider = async (digits) => { calls++; return digits.endsWith('0199') ? 'mobile' : 'landline'; };
      const l = LT.newLookup({ provider });
      const a = await l.classify(CELL);
      const b = await l.classify(CELL);
      ok('a number is classified', a === 'mobile', a);
      ok('  and looked up ONCE, not per call', calls === 1, { calls });
      ok('  the second answer comes from cache', b === 'mobile', b);
      const c = await l.classify(MAIN);
      ok('a different number costs a second lookup', calls === 2 && c === 'landline', { calls, c });
      ok('  and the meter counts what was spent', l.count() === 2, l.count());
    }
    {
      const l = LT.newLookup({ provider: async () => { throw new Error('402 payment required'); } });
      const v = await l.classify(CELL);
      ok('a provider failure yields "unknown", never a guess', v === 'unknown', v);
    }
    {
      const l = LT.newLookup({ provider: async () => 'something-odd' });
      ok('an unrecognised provider answer is "unknown"', (await l.classify(CELL)) === 'unknown');
    }
    {
      const l = LT.newLookup({ provider: async () => 'mobile' });
      ok('a number that is not a real 10-digit US number is not looked up',
        (await l.classify('n/a')) === null, await l.classify('n/a'));
      ok('  and null in means null out', (await l.classify(null)) === null);
    }
    {
      // NO SPEND WITHOUT THE FLAG. newLookup with no provider is inert.
      const l = LT.newLookup({});
      ok('with no provider configured nothing is classified', (await l.classify(CELL)) === null);
      ok('  and nothing is metered', l.count() === 0, l.count());
    }
  }

  console.log('\n-- THE ROW CARRIES THE LINE TYPE --');
  {
    const r = row('Own Cell', {
      contacts: [{ name: 'Dawn Mercer', title: 'Owner', phone: CELL, affiliationScope: 'this-location' }],
      businessPhone: MAIN,
    }, { [CELL]: 'mobile', [MAIN]: 'landline' });
    ok('her direct line is typed', r.directLineType === 'mobile', r.directLineType);
    ok('  the main line is typed separately', r.mainLineType === 'landline', r.mainLineType);
    ok('  the business counts as mobile-reachable', r.mobile === true, r.mobile);
    ok('  and as NAMED + MOBILE, which is the text lane', r.namedPlusMobile === true, r.namedPlusMobile);
    ok('  specifically on HER OWN number', r.namedPlusOwnMobile === true, r.namedPlusOwnMobile);
  }
  {
    // The sole proprietor case: the shop number IS the owner's cell.
    const r = row('Sole Trader', {
      contacts: [{ name: 'Gil Pruitt', title: 'Owner', phone: MAIN, affiliationScope: 'this-location' }],
      businessPhone: MAIN,
    }, { [MAIN]: 'mobile' });
    ok('a main line that is a mobile is still textable', r.mobile === true, r.mobile);
    ok('  and counts as named + mobile', r.namedPlusMobile === true, r.namedPlusMobile);
    ok('  but NOT as their own mobile, because it is the shared line',
      r.namedPlusOwnMobile === false, r.namedPlusOwnMobile);
  }
  {
    const r = row('Landline Only', { contacts: [], businessPhone: MAIN }, { [MAIN]: 'landline' });
    ok('a landline-only business is not mobile', r.mobile === false, r.mobile);
    ok('  and not named + mobile', r.namedPlusMobile === false, r.namedPlusMobile);
  }
  {
    const r = row('Unknown Type', { contacts: [], businessPhone: MAIN }, { [MAIN]: 'unknown' });
    ok('an unknown line type is NOT counted as mobile', r.mobile === false, r.mobile);
  }
  {
    const r = row('No Lookup Run', { contacts: [], businessPhone: MAIN });
    ok('with no lookup, line type is null rather than assumed', r.mainLineType === null, r.mainLineType);
    ok('  and mobile is false, not null, so the summary can count it', r.mobile === false, r.mobile);
  }

  console.log('\n-- THE SUMMARY SAYS WHICH CHANNEL, NOT JUST "PHONE" --');
  {
    const rows = [
      row('a', { contacts: [{ name: 'A One', title: 'Owner', phone: CELL, affiliationScope: 'this-location' }], businessPhone: MAIN }, { [CELL]: 'mobile', [MAIN]: 'landline' }),
      row('b', { contacts: [{ name: 'B Two', title: 'Owner', phone: MAIN, affiliationScope: 'this-location' }], businessPhone: MAIN }, { [MAIN]: 'mobile' }),
      row('c', { contacts: [], businessPhone: MAIN }, { [MAIN]: 'landline' }),
      row('d', { contacts: [], businessPhone: null }),
    ];
    const s = S.summarize(rows);
    const get = (label) => s.metrics.find((m) => m.label.trim().startsWith(label));
    ok('main lines are counted', get('Main line').count === 3, get('Main line'));
    ok('  direct lines to a named person', get('Direct line').count === 1, get('Direct line'));
    ok('  mobile numbers', get('Mobile number').count === 2, get('Mobile number'));
    ok('  NAMED PERSON + MOBILE is the headline', get('NAMED PERSON + MOBILE').count === 2, get('NAMED PERSON + MOBILE'));
    ok('    split out by whose number it is', get('of those, their own').count === 1, get('of those, their own'));
    ok('  and "phone found" is still there but no longer the whole story',
      get('Phone found').count === 3, get('Phone found'));
  }

  console.log('\n-- IT RENDERS, AND SAYS WHEN NO LOOKUP RAN --');
  {
    const rows = [row('Own Cell', {
      contacts: [{ name: 'Dawn Mercer', title: 'Owner', phone: CELL, affiliationScope: 'this-location' }],
      businessPhone: MAIN,
    }, { [CELL]: 'mobile', [MAIN]: 'landline' })];
    // 'mainline' is the LONGEST value the PHKIND column takes, and the first
    // fixture used 'direct' -- so the alignment assertion passed while the real
    // report was ragged. Both widths are exercised now.
    rows.push(row('Shop Line', { contacts: [{ name: 'Gil Pruitt', title: 'Owner', phone: MAIN, affiliationScope: 'this-location' }], businessPhone: MAIN }, { [MAIN]: 'landline' }));
    const t = S.renderTable(rows);
    ok('the widest phone-kind value does not break the column',
      t.split('\n').some((l) => /mainline/.test(l)), null);
    ok('the table has a phone-kind column', /PHKIND/.test(t), t.split('\n')[0]);
    ok('  and a line-type column', /LINE/.test(t), t.split('\n')[0]);
    ok('  showing direct + mobile', /direct/.test(t) && /mobile/.test(t), t.split('\n')[2]);
    ok('  columns still line up', new Set(t.split('\n').map((l) => l.length)).size === 1,
      t.split('\n').map((l) => l.length));

    const sum = S.renderSummary(S.summarize(rows),
      { search: 0, output: 0, input: 0, total: 0, searches: 0, outTokens: 0, inTok: 0, cached: 0, priced: 1, lineTypeLookups: 2 },
      { city: 'X', state: 'Y', inTok: 6000, carrier: 'numverify' });
    ok('the summary reports the lookups it paid for', /2 line-type lookups/.test(sum), null);

    const noLookup = S.renderSummary(S.summarize([row('x', { contacts: [], businessPhone: MAIN })]),
      { search: 0, output: 0, input: 0, total: 0, searches: 0, outTokens: 0, inTok: 0, cached: 0, priced: 1, lineTypeLookups: 0 },
      { city: 'X', state: 'Y', inTok: 6000, carrier: null });
    ok('  and says plainly when no carrier lookup ran', /no carrier lookup/i.test(noLookup),
      (noLookup.match(/.*carrier.*/i) || [])[0]);
    ok('  so a zero mobile count is never read as "no mobiles exist"',
      /--carrier/.test(noLookup), null);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => {
  console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  console.log('\nfailures: ' + (f + 1));
  process.exit(1);
});
