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

// ── THE ONE PART OF THE MESSAGE THAT NEVER CHANGES ──────────────────────────
//
// Set once in Settings, appended to every pitch. The model never writes it: a
// signature that varies is a signature nobody trusts, and a scheduling link a
// model retypes is one that will eventually be retyped wrong.
//
// Two things this suite exists to hold:
//   A URL that will not parse is REFUSED, never silently dropped -- saving an
//   empty string where the agent typed something looks like it worked and then
//   omits the link from every email they send.
//   Appending is IDEMPOTENT. A draft can be regenerated, edited and re-saved,
//   and each of those is a chance to sign it twice, on a real email.

const fs = require('fs');
const ROOT = REPO;
const SIG = require(ROOT + 'server/services/signature');
const store = require(ROOT + 'server/store');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── THE SCHEMA, VIA THE NORMAL INIT PATH ──────────────────────────────────
  const cols = (await P.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='users' AND column_name IN ('signature_text','scheduling_url')`)).rows;
  ok('both signature columns exist', cols.length === 2, cols);
  const st = fs.readFileSync(ROOT + 'server/store.js', 'utf8');
  ok('  added in store.js, not a side script',
    /ADD COLUMN IF NOT EXISTS signature_text/.test(st)
      && /ADD COLUMN IF NOT EXISTS scheduling_url/.test(st), null);

  // ── THE URL ───────────────────────────────────────────────────────────────
  ok('a bare domain gets https', SIG.validSchedulingUrl('calendly.com/jm') === 'https://calendly.com/jm',
    SIG.validSchedulingUrl('calendly.com/jm'));
  ok('  an http link is kept as http', /^http:\/\//.test(SIG.validSchedulingUrl('http://cal.example/jm')));
  ok('  and an https one is unchanged',
    SIG.validSchedulingUrl('https://calendly.com/jm') === 'https://calendly.com/jm');
  ok('blank stays blank', SIG.validSchedulingUrl('') === '' && SIG.validSchedulingUrl(null) === '');
  // A javascript: URL in a signature is an injected script in every email this
  // agent ever sends.
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'not a url',
    'ftp://files.example/x', 'localhost']) {
    ok('  refused: ' + bad, SIG.validSchedulingUrl(bad) === '', SIG.validSchedulingUrl(bad));
  }

  // ── THE TEXT ──────────────────────────────────────────────────────────────
  ok('trailing whitespace is trimmed per line',
    SIG.cleanSignatureText('JohnMark   \n  NILDash  ') === 'JohnMark\n  NILDash');
  ok('  runs of blank lines collapse',
    SIG.cleanSignatureText('A\n\n\n\nB') === 'A\n\nB');
  ok('  and it is capped rather than unbounded',
    SIG.cleanSignatureText('x'.repeat(2000)).length === SIG.MAX_SIGNATURE_CHARS);

  // ── RENDERING ─────────────────────────────────────────────────────────────
  const sig = SIG.signatureOf({ signature_text: 'JohnMark Compton\nNILDash',
    scheduling_url: 'calendly.com/jm' });
  ok('signatureOf normalises both halves',
    sig.has === true && sig.hasLink === true && sig.url === 'https://calendly.com/jm', sig);
  ok('  plain text puts the link on its own line',
    SIG.renderText(sig) === 'JohnMark Compton\nNILDash\nhttps://calendly.com/jm', SIG.renderText(sig));
  const html = SIG.renderHtml(sig);
  ok('THE LINK IS A REAL ANCHOR, NOT A PASTED STRING',
    /<a href="https:\/\/calendly\.com\/jm"[^>]*>Schedule a call<\/a>/.test(html), html);
  ok('  opened safely', /rel="noopener noreferrer"/.test(html) && /target="_blank"/.test(html), html);
  ok('  and the free text is escaped, since the agent typed it',
    /&lt;b&gt;/.test(SIG.renderHtml(SIG.signatureOf({ signature_text: '<b>JM</b>' }))),
    SIG.renderHtml(SIG.signatureOf({ signature_text: '<b>JM</b>' })));
  ok('an empty signature renders nothing at all',
    SIG.renderText(SIG.signatureOf({})) === '' && SIG.renderHtml(SIG.signatureOf({})) === '');
  const linkOnly = SIG.signatureOf({ scheduling_url: 'calendly.com/jm' });
  ok('a link with no text still renders', SIG.renderText(linkOnly) === 'https://calendly.com/jm');
  ok('  and hasLink is what the prompt reads', linkOnly.hasLink === true && linkOnly.has === true);
  const textOnly = SIG.signatureOf({ signature_text: 'JohnMark' });
  ok('text with no link has a signature but no link',
    textOnly.has === true && textOnly.hasLink === false, textOnly);

  // ── APPENDING IS IDEMPOTENT ───────────────────────────────────────────────
  const body = 'Hi Ronda,\n\nFour sentences here.\n\nJohnMark';
  const once = SIG.appendText(body, sig);
  ok('the block is appended once', once.indexOf('calendly.com/jm') > 0, once.slice(-40));
  ok('  AND APPENDING AGAIN DOES NOT SIGN IT TWICE',
    SIG.appendText(once, sig) === once, SIG.appendText(once, sig).slice(-60));
  ok('  three times either', SIG.appendText(SIG.appendText(once, sig), sig) === once);
  const onceHtml = SIG.appendHtml('<p>Body</p>', sig);
  ok('the same holds for HTML', SIG.appendHtml(onceHtml, sig) === onceHtml, null);
  ok('an empty signature leaves the body untouched',
    SIG.appendText(body, SIG.signatureOf({})) === body);
  ok('  and does not add stray blank lines', !/\n\n\n/.test(SIG.appendText(body, SIG.signatureOf({}))));

  // ── THE WIRING ────────────────────────────────────────────────────────────
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok('Settings can read and write it',
    /app\.get\('\/api\/agent\/signature'/.test(idx) && /app\.post\('\/api\/agent\/signature'/.test(idx), null);
  ok('  A BAD LINK IS REFUSED, NOT SILENTLY DROPPED',
    /if \(rawUrl && !url\)/.test(idx) && /not a web address we can link to/.test(idx), null);
  ok('  and the on-demand path carries it too',
    /u\.signature_text, u\.scheduling_url/.test(idx), null);

  const pw = fs.readFileSync(ROOT + 'server/services/pitchWriter.js', 'utf8');
  ok('THE MODEL IS TOLD NOT TO WRITE A SIGNATURE',
    /DO NOT WRITE A SIGNATURE/.test(pw), null);
  ok('  because anything it invents is a second signature on the same email',
    /second signature on the[\s\n]+same email/.test(pw), null);
  ok('the body may reference the link ONLY when there is one',
    /use my scheduling link below to set up a call/.test(pw)
      && /The agent has NO scheduling link\. Do not mention one/.test(pw), null);

  const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the run reads the signature once, not per business',
    /const signature = SIG\.signatureOf\(agent\);/.test(job), null);
  ok('  and appends it to every card the writer produced',
    (job.match(/SIG\.appendText\(/g) || []).length === 2, null);
  // Two writer call sites: the program lane and the local lane. Counted rather
  // than asserted loosely, so a third one added later without the flag shows up
  // here instead of quietly writing pitches that reference a link they were never
  // told about.
  ok('  telling the writer whether a link exists, at BOTH call sites',
    (job.match(/hasSchedulingLink: !!signature\.hasLink/g) || []).length === 2
      && (job.match(/PW\.writePitch\(/g) || []).length === 2, null);
  ok('the agent query loads the columns it needs',
    (job.match(/signature_text, scheduling_url FROM users/g) || []).length >= 1, null);

  const html2 = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  ok('SETTINGS HAS A PLACE TO SET IT',
    /id="sig-text"/.test(html2) && /id="sig-url"/.test(html2), null);
  ok('  with a preview of what will actually be appended',
    /id="sig-preview"/.test(html2) && /renderSignaturePreview/.test(html2), null);
  ok('  loaded when Settings opens',
    /setTimeout\(loadSignature, 60\)/.test(html2), null);
  ok('  and the preview shows the SERVER\'s version, not the textarea',
    /Echo the SERVER's normalised values back/.test(html2), null);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
