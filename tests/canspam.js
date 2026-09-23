'use strict';
// Runs from a checkout on any machine. Pure over the footer, the signed
// unsubscribe token and the wiring in the send paths: no database, no network,
// no key.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/canspam.js          just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.APP_URL = 'https://mynildash.com';
const fs = require('fs');

// ── EVERY COLD EMAIL WENT OUT WITHOUT A POSTAL ADDRESS OR A WAY TO STOP ─────
//
// CAN-SPAM 7704(a)(5) wants a valid physical mailing address in every
// commercial message, and 7704(a)(3) wants a working opt-out that keeps
// working for 30 days. The pitch, the follow-up, the Closer's nightly release,
// the inbox compose and the athlete's own brand email had neither. The penalty
// is per message and the nightly job sends in volume.

const ADDR = 'Compton Group LLC\n123 Example St, Suite 4\nBirmingham, AL 35203';
process.env.BUSINESS_MAILING_ADDRESS = ADDR;
const C = require(REPO + 'server/services/canSpam.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

(async () => {
  // ── THE ADDRESS COMES FROM THE ENVIRONMENT, AND NOWHERE ELSE ──────────
  OUT.push('-- the mailing address --');
  ok('the address is read from BUSINESS_MAILING_ADDRESS', C.ENV_NAME === 'BUSINESS_MAILING_ADDRESS');
  ok('  a multi-line address becomes one footer line', C.mailingAddress() === 'Compton Group LLC, 123 Example St, Suite 4, Birmingham, AL 35203', C.mailingAddress());
  ok('NO ADDRESS IS HARDCODED: the file carries none of it',
    !/\b\d{3,6}\s+[A-Z][a-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Suite)\b/.test(src('server/services/canSpam.js'))
    && !/\b[A-Z]{2}\s+\d{5}\b/.test(src('server/services/canSpam.js')));

  // ── UNSET MEANS NOTHING SENDS, NOT "SEND IT ANYWAY" ───────────────────
  OUT.push('', '-- unset --');
  delete process.env.BUSINESS_MAILING_ADDRESS;
  ok('with no address configured, the footer is not configured', C.configured() === false);
  ok('  and the problem names the variable, so it is fixable without reading code',
    /BUSINESS_MAILING_ADDRESS/.test(C.problem() || '') && /CAN-SPAM/.test(C.problem() || ''), C.problem());
  let threw = null;
  try { C.appendHtml('<p>Hi</p>', 'owner@example.com'); } catch (e) { threw = e; }
  ok('AN EMAIL IS NOT SENT WITHOUT THE ADDRESS: appending throws rather than shipping',
    !!threw && threw.code === 'CANSPAM_UNCONFIGURED', threw && threw.message);
  ok('  and the throw carries the same sentence', !!threw && /BUSINESS_MAILING_ADDRESS/.test(threw.message));
  ok('  the footer is still REQUIRED when it cannot be built (unset never means exempt)', C.required('closer') === true);
  process.env.BUSINESS_MAILING_ADDRESS = ADDR;

  // ── THE FOOTER ────────────────────────────────────────────────────────
  OUT.push('', '-- the footer --');
  const text = C.appendText('Hi Dana,\n\nQuick note.\n\nJohn', 'owner@example.com', { senderName: 'John Compton' });
  ok('the plain-text footer carries the address', text.indexOf('Birmingham, AL 35203') !== -1);
  ok('  and an unsubscribe link', /Unsubscribe: https:\/\/mynildash\.com\/unsubscribe\?u=/.test(text), text);
  ok('  and says why this business got the email', /You received this message because John Compton/.test(text));
  ok('  the body itself is untouched above it', text.startsWith('Hi Dana,\n\nQuick note.\n\nJohn'));
  const html = C.appendHtml('<p>Hi Dana,</p>', 'owner@example.com');
  ok('the HTML footer carries the address and a real anchor',
    html.indexOf('Birmingham, AL 35203') !== -1 && /<a href="https:\/\/mynildash\.com\/unsubscribe\?u=[^"]+"/.test(html), html);
  ok('  the word is "Unsubscribe", which is the word people look for', />Unsubscribe<\/a>/.test(html));

  // Appending twice is the obvious failure and it reaches a real business.
  ok('APPENDING IS IDEMPOTENT: a regenerated draft does not get two footers',
    C.appendHtml(html, 'owner@example.com') === html);
  ok('  and the text side too', C.appendText(text, 'owner@example.com') === text);
  ok('  a body that already carries a link from elsewhere is left alone',
    C.appendText('Hi\n\nUnsubscribe: https://mynildash.com/unsubscribe?u=abc.def', 'owner@example.com')
      .split('unsubscribe?u=').length === 2);

  // ── THE LINK IS SIGNED ────────────────────────────────────────────────
  OUT.push('', '-- the link --');
  const t = C.tokenFor('Owner@Example.COM ');
  ok('the token carries the address, so the click needs no login', C.emailFromToken(t) === 'owner@example.com', C.emailFromToken(t));
  ok('  the address is folded to lower case, the way the suppression list stores it', C.tokenFor('OWNER@EXAMPLE.COM') === t);
  const body = Buffer.from('victim@rival.com').toString('base64').replace(/=+$/, '');
  ok('A FORGED LINK SUPPRESSES NOBODY: an unsigned address is refused',
    C.emailFromToken(body + '.AAAAAAAAAAAAAAAAAAAAAAAAAAA') === null);
  ok('  a token with the signature stripped is refused', C.emailFromToken(body) === null);
  ok('  a tampered address under a valid signature is refused', C.emailFromToken(body + '.' + t.split('.')[1]) === null);
  ok('  and garbage is refused rather than throwing', C.emailFromToken('....') === null && C.emailFromToken(null) === null);
  ok('something that decodes but is not an address is refused',
    C.emailFromToken(C.tokenFor('not-an-address')) === null || C.emailFromToken('x') === null);

  // ── WHO CARRIES IT, AND WHO MUST NOT ──────────────────────────────────
  OUT.push('', '-- which senders --');
  for (const s of ['closer', 'follow-up', 'manual', 'compose', 'athlete', 'growth']) {
    ok(`outreach carries the footer: ${s}`, C.required(s) === true);
  }
  // The link writes to the GLOBAL list. An agent clicking it in their own
  // digest would block their own address for every system we have.
  for (const s of ['nightly-digest', 'weekly-digest', 'shift-report', 'deliverable-digest', 'report', 'media-kit', 'inquiry', 'reply']) {
    ok(`a notice to our own agent does NOT: ${s}`, C.required(s) === false);
  }
  ok('NEITHER DOES A PASSWORD RESET OR A VERIFICATION',
    C.required('password-reset') === false && C.required('verification') === false);
  ok('a sender nobody classified is treated as outreach, because that is the safe way to be wrong',
    C.required('some-new-sender') === true);
  const SR = require(REPO + 'server/services/sendRules.js');
  ok('  and the notice list is sendRules.NOTICE_SYSTEMS, not a second copy of it',
    [...SR.NOTICE_SYSTEMS].every((s) => C.required(s) === false)
    && /NOTICE_SYSTEMS/.test(src('server/services/canSpam.js')));

  // ── IT IS ON THE MESSAGE THAT SHIPS, NOT ON THE DRAFT ─────────────────
  OUT.push('', '-- every send path --');
  const outreach = src('server/routes/outreach.js');
  ok('the agent clicking Send: the footer is appended to what goes on the wire',
    /const bodyHtml = canSpam\.appendHtml\(log\.body_html, toEmail/.test(outreach));
  ok('  all three providers send the footered body, not the stored draft',
    (outreach.match(/bodyHtml,\s*(attachments,\s*)?replyTo, messageId/g) || []).length === 3, (outreach.match(/bodyHtml,\s*(attachments,\s*)?replyTo, messageId/g) || []).length);
  ok('  an unconfigured address answers with the sentence, not a 500 about the mailbox',
    /e\.code === 'CANSPAM_UNCONFIGURED'/.test(outreach) && /reason: 'can-spam'/.test(outreach));

  const closer = src('server/jobs/closerRelease.js');
  ok('the nightly release: the footer is on the body it hands the provider',
    /bodyHtml: canSpam\.appendHtml\(log\.body_html, to/.test(closer));
  ok('  AND THE WHOLE TICK REFUSES when the address is unset, once, rather than failing 200 sends',
    /if \(!canSpam\.configured\(\)\)/.test(closer) && /sent: 0/.test(closer));

  const email = src('server/routes/email.js');
  ok('the inbox compose: a new message to a business carries it',
    /canSpam\.appendHtml\(bodyHtml, recipients\[0\]\)/.test(email));
  ok('  a reply inside a thread does not, because that is a conversation',
    /canSpam\.required\(threadId \? 'reply' : 'compose'\)/.test(email));

  const index = src('server/index.js');
  ok("the athlete's own brand email carries it too",
    /const sendBody = canSpam\.appendText\(body, to/.test(index));
  ok('  and it is the footered text that is sent, on both the Gmail and the Resend path',
    /body: sendBody/.test(index) && /text: sendBody/.test(index) && /sendBody\.replace\(\/&\/g/.test(index));
  ok('  while what we RECORD is what the athlete actually wrote',
    /message_sent, initiated_by, status\)[\s\S]{0,400}?opts\.brand_name \|\| subject, to, body\]/.test(index));

  // ── ONE CLICK STOPS EVERY AGENT ───────────────────────────────────────
  OUT.push('', '-- the click --');
  ok('the page is public: no session, no login, because the recipient has no account',
    /app\.get\('\/unsubscribe'/.test(index) && /app\.post\('\/unsubscribe'/.test(index));
  ok('A GET DOES NOT UNSUBSCRIBE ANYBODY: mail scanners fetch every link in a message',
    index.indexOf("app.get('/unsubscribe'") !== -1
    && /app\.get\('\/unsubscribe', \(req, res\) => \{\s*const address = canSpamSvc\.emailFromToken\(req\.query\.u\);\s*res\.status/.test(index));
  ok('  the POST is what writes, and it writes to the ONE suppression list every sender checks',
    /app\.post\('\/unsubscribe'[\s\S]{0,600}?sendRules\.suppressManually\(store\.pool, address/.test(index));
  ok('  recorded as an unsubscribe, which is not the same thing as a row we added by hand',
    /kind: 'unsubscribe'/.test(index) && /function suppressManually\(pool, email, \{ reason, by, kind \} = \{\}\)/.test(src('server/services/sendRules.js')));
  ok('  and every already-queued message to that address stops, on every roster',
    /UPDATE outreach_logs SET cadence_stopped_at = NOW\(\)[\s\S]{0,200}?WHERE LOWER\(sent_to_email\) = \$1/.test(src('server/services/sendRules.js')));
  ok('the form posts urlencoded, so the button actually carries the token',
    /app\.post\('\/unsubscribe', express\.urlencoded\(/.test(index));
  ok('a bad or expired link says so instead of a blank page', /That link has expired/.test(index));

  // The suppression list is global by construction: isSuppressed keys on the
  // address alone, with no agent in the query. That is what makes one click
  // stop every agent rather than one.
  const sup = src('server/services/suppression.js');
  ok('THE LIST IS GLOBAL: the check is by address, with no agent in it',
    /WHERE email = \$1/.test(sup) && !/isSuppressed[\s\S]{0,400}agent_id = \$/.test(sup));

  // ── THE OPUS LINE ON THE SPEND REPORT ─────────────────────────────────
  OUT.push('', '-- instagram stats: the cheap tier --');
  ok('the Instagram follower lookup no longer runs on Opus',
    !/ai\.oneShotWebSearch\(prompt, system, 900, 4, ai\.MODEL_STANDARD\)/.test(index));
  ok('  it runs on the fast tier, which is what ai.js reserves for extraction',
    /ai\.oneShotWebSearch\(prompt, system, 900, 4, ai\.MODEL_FAST\)/.test(index));
  ok('  and it is labelled, so the next report names the work instead of a line number',
    /scanMeter\.label\(\{ site: \(scanMeter\.ctx\(\)\.site \|\| 'social'\) \+ '\.instagram' \}/.test(index));
  ok('  the null rule and the exact-handle check are unchanged, because they are what stops a made-up number',
    /Never estimate, never guess, never fabricate any number/.test(index)
    && /match the handle character for character/.test(index));
  const ai = require(REPO + 'server/ai.js');
  ok('  the fast tier is a real model id, not a name that fell through', /^claude-haiku/.test(ai.MODEL_FAST), ai.MODEL_FAST);
  ok('OPUS IS STILL USED WHERE IT WAS CHOSEN: contract drafting is untouched',
    /4000, ai\.MODEL_STANDARD(?:, \{ prose: true \})?\)/.test(index) && (index.match(/ai\.MODEL_STANDARD/g) || []).length >= 3);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('canspam: FAILED', e); process.exit(1); });
