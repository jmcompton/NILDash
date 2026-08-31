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
const H = require(REPO + 'server/services/homeQueue.js');
let F=0; const ok=(n,c,g)=>{if(c)console.log('  PASS '+n);else{F++;console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):''));}};

console.log('\n-- the pitch wins, and the greeting is not the pitch --');
const p = H.deriveWhy({ body_html: '<p>Hi Chris,</p><p>You roast two miles from campus and already sponsor the Hyattsville 5K.</p>',
  why: 'Local roaster', reasoning: 'Sponsors races' });
ok('takes the pitch over the stored fields', p.from === 'pitch', p);
ok('  and drops the greeting', !/Hi Chris/.test(p.text), p.text);

console.log('\n-- filler openers are stepped over, not printed --');
for (const opener of ['I hope this finds you well.', 'My name is Jordan and I represent Kaden.',
  'Just reaching out about a partnership.', 'Hope you are having a good week.']) {
  const r = H.deriveWhy({ body_html: `<p>Hi Dana,</p><p>${opener} Board and Brew sits on Route 1 with a student-heavy lunch crowd and no athlete on the wall yet.</p>` });
  ok(`steps over "${opener.slice(0,26)}..."`, r.text && /Route 1/.test(r.text) && !new RegExp(opener.split(' ')[0]+'\\b').test(r.text.slice(0,12)), r.text);
}

console.log('\n-- no pitch: why and match reasoning --');
ok('combines when neither stands alone',
  H.deriveWhy({ why: 'College Park bike shop', reasoning: 'Customers are students on the trail.' }).from === 'why+match');
ok('takes the richer one when one is substantial',
  /thirty years/.test(H.deriveWhy({ why: 'Hardware store', reasoning: 'A family hardware store that has sponsored town teams for thirty years and knows every coach in the county.' }).text));
ok('why alone works', H.deriveWhy({ why: 'Running store that sponsors half the road races in the county' }).from === 'why');
ok('match alone works', H.deriveWhy({ reasoning: 'A food hall built around game-day traffic, the same crowd he brings.' }).from === 'match');

console.log('\n-- it never invents --');
const none = H.deriveWhy({ body_html: '<p>Hi,</p>', why: null, reasoning: null });
ok('no source means no sentence', none.text === null && none.from === null, none);
ok('  a two-word why is not a reason', H.deriveWhy({ why: 'Coffee shop' }).text === 'Coffee shop.');

console.log('\n-- it does not run away --');
const longWhy = 'x'.repeat(400);
const t = H.deriveWhy({ reasoning: longWhy }).text;
ok('capped at the read limit', t.length <= H.MAX_LEN + 1, t.length);
ok('  and does not cut mid-word', !/\w…\w/.test(t));
ok('abbreviations do not split the sentence',
  /Liquid I\.V\. is/.test(H.deriveWhy({ body_html:'<p>Hey,</p><p>Liquid I.V. is a national brand with a real local footprint here in town.</p>' }).text || ''),
  H.deriveWhy({ body_html:'<p>Hey,</p><p>Liquid I.V. is a national brand with a real local footprint here in town.</p>' }).text);

console.log('\n-- there is no model call in this file --');
const src = require('fs').readFileSync(REPO + 'server/services/homeQueue.js','utf8');
ok('no anthropic client', !/anthropic|messages\.create|oneShot|webSearch/i.test(src));
ok('no require of ai.js', !/require\(.*\bai\b/.test(src));

console.log('\nfailures: '+F);
process.exit(F?1:0);
