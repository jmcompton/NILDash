'use strict';
// No database needed. No network: every model call is a stub.
//
//   node tests/pitchask.js
//
// ── THE FIRST EMAIL: "NIL OPPORTUNITY FOR {BUSINESS}", AND THE ASK LAST ─────
// 1. A first email's subject is "NIL opportunity for {Business}" wherever it
//    is drafted (the nightly cards, prewarmed drafts, Generate pitch, Write
//    Outreach, the athlete's own pitch), "Endorsement opportunity for" for a
//    pro (who never says NIL). Follow-ups keep their reply subject.
// 2. The last line before the sign-off is the ask: one question, one
//    sentence, alone on its line after a blank line. The writer's check
//    rejects a draft that does not end that way (after a layout-only repair
//    that never changes a word), and the retry is told why.
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..') + path.sep;
delete process.env.ANTHROPIC_API_KEY;

// The Generate pitch writer reads ai.oneShot when it is loaded: stubbed first.
const ai = require(REPO + 'server/ai');
let genAnswers = [];
const genPrompts = [];
ai.oneShot = async (prompt) => { genPrompts.push(String(prompt)); return genAnswers.length ? genAnswers.shift() : '{}'; };

const PS = require(REPO + 'server/services/pitchSubject');
const Q = require(REPO + 'server/services/outreachQueue');
const W = require(REPO + 'server/services/pitchWriter');
const FU = require(REPO + 'server/services/followUps');
const DP = require(REPO + 'server/services/draftPrewarm');
const PG = require(REPO + 'server/services/pitchGeneration');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const read = (f) => fs.readFileSync(REPO + f, 'utf8');
const lastLines = (t, n) => String(t).trim().split('\n').slice(-n);

(async () => {
  console.log('\n1. THE SUBJECT');
  ok('"NIL opportunity for {Business}"', PS.firstTouchSubject('Trak Shak') === 'NIL opportunity for Trak Shak');
  ok('  a pro athlete never says NIL: "Endorsement opportunity for {Business}"', PS.firstTouchSubject('Trak Shak', { pro: true }) === 'Endorsement opportunity for Trak Shak');
  ok('  no business name: "your business"', PS.firstTouchSubject('  ') === 'NIL opportunity for your business');
  ok('the nightly card\'s subjectFor builds it', Q.subjectFor('Trak Shak') === 'NIL opportunity for Trak Shak' && Q.subjectFor('Trak Shak', { pro: true }) === 'Endorsement opportunity for Trak Shak');
  const ladder = { tiers: [{ tier: 1, rows: [{ name: 'Dana Cole', title: 'Owner', source: 'site', sources: ['site'], affiliationScope: 'this-location', email: 'dana@trakshak.com', emailKind: 'published' }] }] };
  const card = Q.buildCard({ brandKey: 'name:trak shak', brand: 'Trak Shak', athleteName: 'Jo Doe', pitch: { message: 'Hi Dana,\n\nx\n\nJohn' } }, ladder, null);
  ok('  an email card carries it', card.channel === 'email' && card.subject === 'NIL opportunity for Trak Shak', { channel: card.channel, subject: card.subject });
  const proCard = Q.buildCard({ brandKey: 'name:trak shak', brand: 'Trak Shak', athleteName: 'Jo Doe', pro: true, pitch: { message: 'Hi Dana,\n\nx\n\nJohn' } }, ladder, null);
  ok('  a pro\'s email card says Endorsement', proCard.subject === 'Endorsement opportunity for Trak Shak', proCard.subject);
  ok('  the nightly job tells the card when the athlete is a pro', /athleteName, pitch, pro: proLane,/.test(read('server/jobs/outreachQueue.js')));
  ok('no "Quick idea for" left anywhere a subject is built', !/Quick idea for/.test(read('server/services/outreachQueue.js') + read('server/services/draftPrewarm.js') + read('server/services/pitchGeneration.js') + read('server/ai.js')));
  ok('follow-ups keep their reply subject', FU.subjectFor('NIL opportunity for Trak Shak', 2) === 'Re: NIL opportunity for Trak Shak'
    && FU.subjectFor('Quick idea for Trak Shak', 2) === 'Re: Quick idea for Trak Shak');
  const pw = read('server/services/draftPrewarm.js');
  ok('a prewarmed draft is stored with the built subject, not the model\'s', /require\('\.\/pitchSubject'\)\.firstTouchSubject\(brand, \{ pro: require\('\.\/proLane'\)\.isPro\(athlete \|\| \{\}\) \}\), toHtml\(parsed\.body\)/.test(pw) && !/parsed\.subject, toHtml/.test(pw));
  const aiSrc = read('server/ai.js');
  ok('Write Outreach (generateOutreach): the first email\'s subject is built, the follow-up keeps "Re:"', (aiSrc.match(/return _firstTouchSubjectOn\(JSON\.parse\(match\[0\]\), athlete, targetBrand\);/g) || []).length === 2
    && /out\.sponsorshipEmail\.subject = require\('\.\/services\/pitchSubject'\)\.firstTouchSubject\(targetBrand/.test(aiSrc) && /"subject": "Re: \$\{athlete\.name\}/.test(aiSrc));
  ok('the athlete\'s own pitch (generateDealPitch): built, written or fallback', /out\.subject = require\('\.\/services\/pitchSubject'\)\.firstTouchSubject\(brand\.brand \|\| brand\.brand_name/.test(aiSrc)
    && /subject: require\('\.\/services\/pitchSubject'\)\.firstTouchSubject\(bn,/.test(aiSrc) && !/local partnership idea/.test(aiSrc));

  console.log('\n2. THE ASK, LAST: THE CHECK');
  const good = 'Hi Dana,\n\nJo posts training clips.\n\nWould you like to learn more about Jo?\n\nJohn';
  ok('one question, alone on its line after a blank line, then the sign-off: no problem', W.askProblem(good) === null);
  ok('a statement last: rejected', /does not end with the ask/.test(W.askProblem('Hi Dana,\n\nJo posts clips. Thanks for reading.\n\nJohn')));
  ok('a question that is not on its own line: rejected', /not on its own line after a blank line/.test(W.askProblem('Hi Dana,\n\nJo posts clips.\nWould you like to learn more?\n\nJohn')));
  ok('two sentences on the ask line: rejected', /not one sentence/.test(W.askProblem('Hi Dana,\n\nJo posts clips. Would you like to learn more?\n\nJohn')));
  ok('the Instagram link after the ask: rejected', /does not end with the ask/.test(W.askProblem('Hi Dana,\n\nJo posts clips.\n\nWould you like to learn more?\ninstagram.com/jodoe\n\nJohn')));
  ok('lintMessage applies it only when asked (the writer asks; follow-ups do not)',
    W.lintMessage('Hi Dana,\n\nJo plays guard at Alabama. Jo posts training clips. Jo has a big local following. Thanks for reading.\n\nJohn', { requireAsk: true }).problems.some((p) => /does not end with the ask/.test(p))
      && !W.lintMessage('Hi Dana,\n\nJo plays guard at Alabama. Jo posts training clips. Jo has a big local following. Thanks for reading.\n\nJohn', {}).problems.some((p) => /ask/.test(p)));
  ok('  the follow-up writer still lints without it', /W\.lintMessage\(textOf\(body\), \{\}\)/.test(read('server/services/followUps.js')));

  console.log('\n3. THE LAYOUT REPAIR: NEVER A WORD CHANGED');
  const r1 = W.repairAsk('Hi Dana,\n\nI wanted to call your attention to Jo Doe, guard on the Tide. Jo posts training clips. Would you like to learn more about this NIL opportunity with Jo?\ninstagram.com/jodoe\n\nJohn');
  ok('the old shape (question, then the link): the link moves above, the question goes last on its own line',
    r1 === 'Hi Dana,\n\nI wanted to call your attention to Jo Doe, guard on the Tide. Jo posts training clips.\n\ninstagram.com/jodoe\n\nWould you like to learn more about this NIL opportunity with Jo?\n\nJohn' && W.askProblem(r1) === null, r1);
  const r2 = W.repairAsk('Hi Dana,\n\nJo posts clips.\nWould you like to learn more?\n\nJohn');
  ok('a blank line is put before the ask', r2 === 'Hi Dana,\n\nJo posts clips.\n\nWould you like to learn more?\n\nJohn', r2);
  const words = (t) => t.replace(/\s+/g, ' ').trim().split(' ').sort().join(' ');
  ok('  the words are the same words', words(r1) === words('Hi Dana,\n\nI wanted to call your attention to Jo Doe, guard on the Tide. Jo posts training clips. Would you like to learn more about this NIL opportunity with Jo?\ninstagram.com/jodoe\n\nJohn'));
  const r3 = W.repairAsk('Hi Dana,\n\nJo posts clips. Thanks for reading.\n\nJohn');
  ok('a statement last is left alone, for the check to reject and the retry to rewrite', r3 === 'Hi Dana,\n\nJo posts clips. Thanks for reading.\n\nJohn' && W.askProblem(r3) !== null);
  ok('a draft with no sign-off keeps none', W.repairAsk('Hi,\n\nJo posts clips. Worth a short call?') === 'Hi,\n\nJo posts clips.\n\nWorth a short call?');

  console.log('\n4. THE NIGHTLY WRITER');
  ok('the prompt: the link before the ask, the ask last on its own line, college and pro', /4\. The athlete's Instagram link on its own line, when one is given\.\n5\. THE ASK, LAST: one question, one sentence, alone on its own line after a\s+blank line\./.test(W.SYSTEM)
    && /5\. The athlete's Instagram link on its own line, when one is given\.\n6\. THE ASK, LAST/.test(W.SYSTEM_PRO)
    && /The last line before your sign-off is the ask: one question, one sentence, on its own line after a blank line\./.test(W.SYSTEM));
  ok('  no em dash in what was added', !/—/.test(W.SYSTEM.slice(W.SYSTEM.indexOf('THE ASK, LAST'), W.SYSTEM.indexOf('THE ASK, LAST') + 500)));
  const ctx = { agentFirstName: 'John',
    athlete: { name: 'Jo Doe', sport: 'basketball', school: 'Alabama', position: 'guard', instagramHandle: 'jodoe' },
    business: { name: 'Trak Shak', category: 'running store', greetFirstName: 'Dana' }, channel: 'email' };
  const S1 = 'I wanted to call your attention to Jo Doe, guard on the Alabama basketball team. Jo is building a local following. Jo posts training clips and game day photos.';
  const reply = (message) => JSON.stringify({ angle: 'local runners', angleKey: 'local-runners', ask: 'a store visit', confidence: 'strong', evidenceUsed: 0, message });
  const run = async (answers) => {
    const prompts = [];
    const q = answers.slice();
    const r = await W.writePitch(ctx, { oneShot: async (p) => { prompts.push(p); return q.shift(); } });
    return { r, prompts };
  };
  {
    const { r, prompts } = await run([reply(`Hi Dana,\n\n${S1} Would you like to learn more about this NIL opportunity with Jo?\ninstagram.com/jodoe\n\nJohn`)]);
    ok('a draft in the old shape is accepted, laid out with the ask last', !r.skipped && !r.retried && prompts.length === 1
      && lastLines(r.message, 3).join('|') === 'Would you like to learn more about this NIL opportunity with Jo?||John' && /instagram\.com\/jodoe\n\nWould you like/.test(r.message), r);
  }
  {
    const { r, prompts } = await run([
      reply(`Hi Dana,\n\n${S1} We think it could be a good match for your store.\ninstagram.com/jodoe\n\nJohn`),
      reply(`Hi Dana,\n\n${S1}\n\ninstagram.com/jodoe\n\nWould you like to learn more about this NIL opportunity with Jo?\n\nJohn`)]);
    ok('a draft that ends on a statement is rejected and rewritten once, told why', !r.skipped && r.retried && (r.firstProblems || []).some((p) => /does not end with the ask/.test(p))
      && /rejected for: .*does not end with the ask/.test(prompts[1] || ''), { r, p2: (prompts[1] || '').slice(-400) });
    ok('  the rewrite ends on the ask', lastLines(r.message, 3)[0] === 'Would you like to learn more about this NIL opportunity with Jo?', r.message);
  }
  {
    const bad = reply(`Hi Dana,\n\n${S1} We think it could be a good match for your store.\ninstagram.com/jodoe\n\nJohn`);
    const { r } = await run([bad, bad]);
    ok('twice without the ask: not written (the card is not placed with it)', r.skipped && r.lintFailed && /does not end with the ask/.test(r.reason), r);
  }

  console.log('\n5. THE OTHER FIRST-EMAIL WRITERS');
  // Prewarmed drafts (Deal Scan): the same check, after the same repair.
  const pcard = { brand: 'Trak Shak', contactName: 'Dana Cole' };
  const pbody = 'Hi Dana,\n\nJo Doe plays guard at Alabama and runs the river trail near Trak Shak every morning. Jo would post a short run from the store.';
  ok('a prewarmed draft that ends on a statement is rejected', /does not end with the ask/.test((DP.checkDraft(pbody, pcard) || {}).why || ''), DP.checkDraft(pbody, pcard));
  ok('  one that ends on the ask passes', DP.checkDraft(pbody + '\n\nWould Trak Shak be open to that?', pcard).ok === true, DP.checkDraft(pbody + '\n\nWould Trak Shak be open to that?', pcard));
  ok('  the prompt asks for the ask last, and the draft is repaired before the check', /A short question that can be answered yes or no, LAST, alone on its own line after a blank line\./.test(pw)
    && /parsed\.body = require\('\.\/pitchWriter'\)\.repairAsk\(parsed\.body\);\s*\n\s*const check = checkDraft/.test(pw));
  // Generate pitch (pitchGeneration): subject built, ask last, checked.
  const BODY = (end) => 'Hi Dana,\n\nJo Doe plays guard at Alabama and trains a mile from Trak Shak. Jo would film a store run for the feed.' + end;
  genAnswers = [JSON.stringify({ subject_line: 'Jo Doe x Trak Shak', full_email_body: BODY(' Would you be open to a quick call this week?'), campaign_ideas: [] })];
  const g1 = await PG.generatePitch({ athlete: { name: 'Jo Doe', sport: 'basketball', school: 'Alabama', position: 'guard' }, enrichment: { brand_name: 'Trak Shak' },
    matchScore: null, contact: { name: 'Dana Cole', email: 'dana@trakshak.com', title: 'Owner' }, dealScanData: {}, agentName: 'John', agentEmail: 'j@x.com' });
  ok('Generate pitch: the subject is built, whatever the model wrote', g1.subject_line === 'NIL opportunity for Trak Shak', g1.subject_line);
  ok('  the closing question is laid out last on its own line', lastLines(g1.full_email_body, 2).join('|') === '|Would you be open to a quick call this week?', g1.full_email_body);
  genAnswers = [JSON.stringify({ full_email_body: BODY(' Happy to share more if helpful.') }), JSON.stringify({ full_email_body: BODY(' Happy to share more if helpful.') })];
  const g2 = await PG.generatePitch({ athlete: { name: 'Jo Doe', sport: 'basketball', school: 'Alabama', position: 'guard' }, enrichment: { brand_name: 'Trak Shak' },
    matchScore: null, contact: null, dealScanData: {}, agentName: 'John', agentEmail: 'j@x.com' });
  ok('  a pitch that ends "Happy to share more if helpful." is rewritten once, then refused', g2.refused === true && g2.reasons.some((x) => /full_email_body does not end with the ask/.test(x)), g2);
  ok('  its prompt asks for the ask last, and the CTA is a question', /Last line, on its own after a blank line: the ask, one question, one sentence/.test(genPrompts[0] || '') && /"cta": "Would you be open to a quick call this week\?"/.test(genPrompts[0] || ''));
  ok('  its subject line in the prompt is the built one', /"subject_line": "NIL opportunity for Trak Shak"/.test(genPrompts[0] || ''));
  const pg = read('server/services/pitchGeneration.js');
  ok('  and its fallback ends on the ask, with no "Best regards," and no em dash in that body', /\\n\\nWould you be open to a brief call this week\?`,/.test(pg) && !/Best regards/.test(pg));

  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
