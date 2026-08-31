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

window.addEventListener('load', function(){
  try {
  // Marcus: nothing queued, but the last run tried 2 businesses and named why.
  // Amari: has a real card.
  renderOutreachQueue({
    groups: [{ athleteId: 'ath_amari', athleteName: 'Amari Allen', cards: [{
      id: 9, brand_name: 'Onyx Coffee Lab', why: 'Coffee shop near campus',
      contact_name: 'Andrea Allen', contact_title: 'Co-Owner', instagram: 'onyxcoffeelab',
      instagram_scope: 'business', phone: '(479) 200-0000', phone_ask_for: 'Andrea',
      channel: 'dm', dm_text: 'Hi! ...',
    }] }],
    waiting: [],
    lastRun: { date: '2026-08-19', details: [
      { athleteId: 'ath_marcus', athleteName: 'Marcus Johnson', filled: 0, open: 3,
        note: '2 businesses tried, none passed the bar',
        tried: [
          { brand: "Saw's BBQ", result: 'rejected', reason: 'no named decision maker — found a main line' },
          { brand: 'Rally House Fayetteville', result: 'rejected', reason: 'found Dana Reed but no way to reach them — no phone, no handle' },
        ] },
      { athleteId: 'ath_amari', athleteName: 'Amari Allen', filled: 1, open: 2, note: null, tried: [] },
    ] },
  });

  var sections = document.querySelectorAll('.hq-athlete');
  ok('BOTH athletes appear, not just the one with a card', sections.length === 2,
    Array.prototype.map.call(sections, function(s){return s.textContent;}));
  ok('  even for an ordinary (non-admin) agent', !hqIsAdmin(), null);

  var text = document.getElementById('hm-queue').textContent;
  ok('Marcus\'s note is on the page', /none passed the bar/.test(text), null);
  ok('  naming Saw\'s BBQ', /Saw.s BBQ/.test(text), null);
  ok('  and its rejection reason', /no named decision maker/.test(text), null);
  ok('  naming Rally House', /Rally House Fayetteville/.test(text), null);
  ok('  and ITS reason', /no way to reach them/.test(text), null);
  ok('Amari\'s real card still renders', /Onyx Coffee Lab/.test(text), null);
  ok('  and her section has no spurious "nothing queued" note',
    document.querySelectorAll('.hq-athlete')[1].nextElementSibling
      && !/Nothing queued/.test(document.querySelectorAll('.hq-athlete')[1].parentElement.textContent.split('Amari Allen')[1] || ''),
    null);

  OUT.push(''); OUT.push('failures: '+FAIL);
  document.getElementById('results').textContent=OUT.join('\n');
  } catch (e) {
    document.getElementById('results').textContent = OUT.join('\n') + '\nTHREW: ' + e.message + '\n' + (e.stack||'').split('\n').slice(0,4).join('\n');
  }
});
