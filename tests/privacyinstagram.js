'use strict';
// No database needed.
//
//   node tests/privacyinstagram.js
//
// ── THE PRIVACY POLICY COVERS INSTAGRAM ─────────────────────────────────────
// public/privacy.html says what NILDash collects from Instagram, why, who sees
// it, how it is stored and how to remove it, and every privacy contact on the
// page is contact@mynildash.com. Where the page makes a claim about the code
// (the routes, the encrypted token, the 25 posts), the code is read too, so
// the two cannot drift apart unnoticed.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..') + path.sep;
const read = (f) => fs.readFileSync(REPO + f, 'utf8');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 600) : '')); } };

const HTML = read('public/privacy.html');
// What a reader sees: tags out, entities decoded, spaces collapsed.
const textOf = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
const TEXT = textOf(HTML);
const at = HTML.indexOf('<!-- 5. Instagram Data -->');
const SEC_HTML = at > -1 ? HTML.slice(at, HTML.indexOf('<!-- 6. ', at)) : '';
const SEC = textOf(SEC_HTML);

console.log('\n1. THE SECTION');
ok('the page has an "Instagram Data" section', /<h2 class="section-title">Instagram Data<\/h2>/.test(HTML) && SEC.length > 500, SEC.slice(0, 200));
ok('  numbered 05, between Google API Services and Data Storage',
  /Section 04 Google API Services/.test(TEXT) && /Section 05 Instagram Data/.test(TEXT) && /Section 06 Data Storage and Security/.test(TEXT));
ok('  collected only after the athlete taps Connect Instagram and approves', /nothing from Instagram until the athlete taps Connect Instagram and approves access/.test(SEC), SEC.slice(0, 400));

console.log('\n2. WHAT WE COLLECT');
for (const [what, re] of [
  ['username', /username/], ['account type', /account type/], ['follower and following counts', /follower count, following count/],
  ['media count', /media count/], ['the last 25 posts', /last 25 posts/],
  ['each post\'s caption, type, timestamp, likes and comments', /caption, type, timestamp, likes and comments/],
  ['reach', /reach/], ['views', /views/], ['profile visits', /profile visits/],
  ['audience age, gender and location', /age, gender and location/],
]) ok(`  ${what}`, re.test(SEC));

console.log('\n3. WHY, WHO, STORAGE');
ok('why: accurate reach and engagement for the athlete and their agent', /To show the athlete and their agent accurate reach and engagement/.test(SEC));
ok('why: the media kit', /To build the athlete's media kit/.test(SEC));
ok('why: brands that fit their audience', /To match the athlete with brands that fit their audience/.test(SEC));
ok('who: the athlete and the agent they connected for', /The athlete, and the agent the athlete connected their account for/.test(SEC));
ok('never sold, never used for advertising', /We never sell it, and we never use it for advertising/.test(SEC));
ok('access tokens are encrypted; kept while the connection is active', /Instagram access tokens are encrypted/.test(SEC) && /keep the data while the connection is active/.test(SEC));

console.log('\n4. HOW TO REMOVE IT');
ok('in NILDash: Disconnect on the athlete page, which deletes the token and the data right away', /In NILDash: Disconnect on the athlete page in NILDash\. The athlete's agent can do it for them\. We delete the access token and everything we fetched from the account right away\./.test(SEC), SEC.match(/In NILDash:[^\n]*/));
ok('in Instagram: Settings > Apps and websites, remove NILDash', /Settings > Apps and websites, find NILDash and remove it/.test(SEC), SEC.match(/In Instagram:[^.]*\./));
ok('Meta\'s data deletion callback deletes the fetched data', /Meta's data deletion callback tells us, and we delete everything we fetched/.test(SEC));
ok('by email: contact@mynildash.com', /By email: write to contact@mynildash\.com/.test(SEC) && /mailto:contact@mynildash\.com/.test(SEC_HTML));
ok('the status page: /api/instagram/deletion-status', /https:\/\/mynildash\.com\/api\/instagram\/deletion-status/.test(SEC));
ok('  and where to enter a code (the status page needs one in its link)', /href="https:\/\/mynildash\.com\/api\/instagram\/data-deletion"/.test(SEC_HTML));

console.log('\n5. THE PAGE MATCHES THE CODE');
const routes = read('server/routes/instagram.js');
const IGC = read('server/services/instagramConnect.js');
ok('the deletion-status and data-deletion routes exist', /app\.get\('\/api\/instagram\/deletion-status'/.test(routes) && /app\.post\('\/api\/instagram\/data-deletion'/.test(routes) && /app\.get\('\/api\/instagram\/data-deletion'/.test(routes));
ok('  and the code-entry form is on the data-deletion page', /action="\/api\/instagram\/deletion-status"/.test(routes));
ok('the access token is stored encrypted', /C\.encrypt\(ex\.accessToken\)/.test(IGC) && /access_token_enc/.test(IGC));
ok('25 posts, as the page says', /const MEDIA_LIMIT = 25;/.test(IGC));
ok('a data deletion request deletes the fetched stats', /async function deleteData\(/.test(IGC) && /DELETE FROM instagram_stats/.test(IGC));

console.log('\n6. THE CONTACT ADDRESS, AND THE RULES FOR THE COPY');
ok('no personal address anywhere on the page', !/jmcompton04/.test(HTML));
const mailtos = [...HTML.matchAll(/mailto:([^"?&'\s]+)/g)].map((m) => m[1]);
ok('every email link on the page is contact@mynildash.com', mailtos.length >= 5 && mailtos.every((m) => m === 'contact@mynildash.com'), mailtos);
ok('  the contact card and the questions box say it too', /Questions\? Contact us at any time at contact@mynildash\.com/.test(TEXT) && /please contact us: contact@mynildash\.com/.test(TEXT));
ok('the "last updated" date is the day the Instagram section was added', /Last updated: October 21, 2026/.test(TEXT));
ok('no em dash in the new section', !/—|&mdash;/.test(SEC_HTML));
ok('no em dash anywhere on the page, the older sections and the title included', !/—|&mdash;|&#8212;/.test(HTML) && /<title>Privacy Policy \| NILDash<\/title>/.test(HTML));
ok('  the list labels read "Label: text" instead', /<strong>Platform functionality<\/strong>: to authenticate users/.test(HTML) && /<strong>Deletion<\/strong>: you may request deletion/.test(HTML)
  && /<strong>Railway<\/strong> \(cloud hosting and database infrastructure\):/.test(HTML) && /one-way cryptographic hash; we never store your plaintext password/.test(HTML));
ok('Meta is listed among the third-party services', /Meta \(Instagram API, only for athletes who connect Instagram\)/.test(TEXT));
ok('section references still point at the right sections', /\(see Section 8\)/.test(HTML) && /Section 08 Third-Party Services/.test(TEXT) && /described in Section 4\./.test(TEXT));
const nums = [...HTML.matchAll(/<div class="section-number">Section (\d+)<\/div>/g)].map((m) => Number(m[1]));
ok('sections run 01 to 10 in order', nums.length === 10 && nums.every((n, i) => n === i + 1), nums);

console.log(`\n${N - F}/${N} passed`);
process.exit(F ? 1 : 0);
