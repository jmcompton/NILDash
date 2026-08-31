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
// The public landing page. It makes factual claims to strangers, so the numbers on
// it are checked against the code that produces them, not against the brief.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');
const AI = fs.readFileSync(R + 'server/ai.js', 'utf8');
const PM = fs.readFileSync(R + 'server/services/programMap.js', 'utf8');
const CL = fs.readFileSync(R + 'public/assistant.js', 'utf8');
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');

// The marketing block only. Everything below must not leak into assertions about
// the app, and vice versa.
const MKT = IDX.slice(IDX.indexOf('<div id="mktLanding">'), IDX.indexOf('id="authScreen"'));
if (MKT.length < 4000) { console.log('FIXTURE BROKEN: marketing block is ' + MKT.length + ' chars. Aborting.'); process.exit(1); }
// Screenshots are megabytes of base64 that would swamp every regex.
const TEXT = MKT.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'IMG');
// What a visitor actually reads. HTML comments are NOT rendered, so any assertion
// of the form "this copy no longer appears" has to run against this -- a comment
// explaining why a line was removed otherwise reads as the line still being there.
const VISIBLE = TEXT.replace(/<!--[\s\S]*?-->/g, '');
// Same idea for whole files: "no code does X" must not be answered by a comment
// explaining why no code does X. Strips HTML comments and JS line comments.
const nocomment = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
const IDXC = nocomment(IDX);

console.log('-- THE NUMBERS MATCH THE CODE THAT PRODUCES THEM --');
{
  // The brief asked for six. The brand ladder searches SEVEN.
  const sources = /const _CONTACT_SOURCES = \[([^\]]+)\]/.exec(AI)[1]
    .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  ok('the contact ladder has seven sources in code', sources.length === 7, sources);
  ok('and the page says seven, not six', /searches seven sources/.test(TEXT)
    && !/searches six sources/.test(TEXT), (TEXT.match(/searches \w+ sources/) || [])[0]);
  ok('the stat says 7 per contact lookup',
    /<div class="n">7<\/div><div class="l">Sources per contact lookup<\/div>/.test(TEXT));
  // The copy names them in English ("business registries", "the site"), so the stem
  // is what to match -- checking the raw key reported a correct sentence as wrong.
  const stem = { site: 'the site', registry: 'registr' };
  const missing = sources.filter((x) => !new RegExp(stem[x] || x, 'i').test(TEXT));
  ok('and every source is named so the claim is checkable', missing.length === 0, missing);

  // The program map is a DIFFERENT ladder with six sources; the page must not
  // conflate them.
  const psources = /const SOURCE_ORDER = \[([^\]]+)\]/.exec(PM)[1]
    .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  ok('the program map has six sources in code', psources.length === 6, psources);

  ok('the program counts are the measured ones', /119 football programs/.test(TEXT)
    && /126 men&rsquo;s basketball programs/.test(TEXT));
  ok('and they are in the stat strip too',
    /<div class="n">119<\/div>/.test(TEXT) && /<div class="n">126<\/div>/.test(TEXT));
}

console.log('\n-- 1. THE PAGE IS AUDIENCE NEUTRAL --');
{
  ok('the hero eyebrow no longer says NIL agents',
    !/eyebrow">The AI command center for NIL agents/.test(TEXT),
    (TEXT.match(/eyebrow">The AI command center[^<]*/) || [])[0]);
  ok('it is neutral', /eyebrow">The AI command center for NIL</.test(TEXT));

  // No copy anywhere that frames the product as agents-only.
  const agentOnly = [
    /platform for sports agents/i, /for NIL agents/i, /\$99\/month for agents/i,
    /Everything you need to run your NIL business, for one flat rate/i,
  ].filter((re) => re.test(TEXT));
  ok('no agents-only framing left', agentOnly.length === 0, agentOnly.map(String));

  console.log('  · nav');
  const links = /<div class="links">([\s\S]*?)<\/div>/.exec(TEXT)[1];
  for (const [label, href] of [['For agents', '#for-agents'], ['For athletes', '#for-athletes'], ['For teams', '#for-teams']]) {
    ok('nav has ' + label, new RegExp('href="' + href + '">' + label + '<').test(links), links);
  }
  ok('and keeps Features and Pricing', /#features">Features</.test(links) && /#pricing">Pricing</.test(links));

  console.log('  · the three audience cards');
  // VISIBLE, not TEXT: this slice anchors on the tinynote following the card block,
  // and an explanatory HTML comment between them breaks the adjacency.
  const cards = /<div class="audcards">([\s\S]*?)<\/div>\s*<div class="tinynote">/.exec(VISIBLE);
  ok('the card block exists', !!cards);
  const cardHtml = cards[1];
  ok('three cards, one per audience', (cardHtml.match(/class="audcard"/g) || []).length === 3,
    (cardHtml.match(/class="audcard"/g) || []).length);
  ok('agents at $99', /id="for-agents"[\s\S]*?\$99<span>\/month<\/span>/.test(cardHtml));
  ok('athletes are free', /id="for-athletes"[\s\S]*?Free<span>no card required<\/span>/.test(cardHtml));
  ok('and no price is claimed for them anywhere in the card',
    !/id="for-athletes"[\s\S]*?\$\d/.test(cardHtml));
  ok('teams say team pricing, not a number',
    /id="for-teams"[\s\S]*?Team pricing/.test(cardHtml) && !/id="for-teams"[\s\S]*?\$\d/.test(cardHtml));
  ok('and teams link to a contact, not to checkout', /id="for-teams" href="#contact-teams"/.test(cardHtml));
  // The note sits under all three cards, one free and one with no price, so an
  // unscoped cancel-anytime was answering only the agent's question.
  const note = /<div class="tinynote">([^<]*)</.exec(VISIBLE)[1];
  ok('the note names the plan it applies to', /agent plan/.test(note), note);
  ok('and no longer makes a blanket claim', !/^Cancel anytime/.test(note.trim()), note);
  ok('each card carries a one-line description',
    (cardHtml.match(/class="what"/g) || []).length === 3);
  // /athlete-signup is the INVITE page: it requires ?token= and dead-ends without
  // one. /athletes is the self-serve portal. Assert the whole landing page, not
  // just this card, so the pricing section cannot regress separately.
  ok('the athlete card points at the self-serve portal', /id="for-athletes" href="\/athletes"/.test(cardHtml));
  ok('and NOTHING on the landing page links to the invite-only page',
    !/href="\/athlete-signup"/.test(TEXT));
  ok('the invite page really does require a token (why the link had to move)',
    /No invite token found/.test(fs.readFileSync(R + 'public/athlete-signup.html', 'utf8')));
  ok('and /athletes is a real route', /app\.get\('\/athletes'/.test(SRV));

  console.log('  · pricing covers all three');
  const pricing = TEXT.slice(TEXT.indexOf('<section id="pricing"'), TEXT.indexOf('</section>', TEXT.indexOf('<section id="pricing"')));
  ok('three pricing cards', (pricing.match(/class="pcard[ "]/g) || []).length === 3,
    (pricing.match(/class="pcard[ "]/g) || []).length);
  ok('agent $99', /\$99<span>\/month<\/span>/.test(pricing));
  ok('athlete free', /Free<span>no card required<\/span>/.test(pricing));
  // The page must not price something the server gives away. BILLING_ENABLED
  // defaults off, and verify-email short-circuits to free access above the Stripe
  // block, so a price on this page would be a claim the product contradicts.
  ok('BILLING_ENABLED still defaults off in the server',
    /const BILLING_ENABLED = process\.env\.BILLING_ENABLED === 'true'/.test(SRV));
  ok('and the athlete flow still hands out free access',
    /if \(!BILLING_ENABLED\)[\s\S]{0,240}_issueJwtAndRedirect\('free'\)/.test(SRV));
  ok('so no athlete price appears anywhere on the page',
    !/\$25/.test(VISIBLE), (VISIBLE.match(/.{30}\$25.{30}/) || [])[0]);
  ok('and the athlete page it links to agrees it is free',
    /no card required/i.test(fs.readFileSync(R + 'public/athletes.html', 'utf8')));
  ok('teams worded, with a contact route', /Team pricing/.test(pricing) && /#contact-teams/.test(pricing));
}

console.log('\n-- 2. THE HEADLINE NAMES WHAT WE DO --');
{
  ok('the category headline is gone', !/NIL is a business\.<br>/.test(TEXT));
  ok('it names finding the business', /Find the local business\./.test(TEXT));
  ok('AND the person who can say yes', /And the person who can say yes\./.test(TEXT));
  ok('the accent split is kept, same as before', /<span class="a">And the person who can say yes\.<\/span>/.test(TEXT));
  // The auth screen carried the same category line; leaving it would contradict the
  // hero one scroll away.
  ok('the sub copy leads with the differentiator', /Any tool can list brands\./.test(TEXT));

  console.log('  · and it does not promise more than the ladder delivers');
  const sub = /<p class="sub">([\s\S]*?)<\/p>/.exec(TEXT)[1];
  // The ladder's bottom tier is a main line and a name to ask for. The old line
  // promised a direct email and a phone on every lookup, which described the best
  // case as the case.
  ok('it no longer guarantees an email and a phone',
    !/with a direct email, a phone number/.test(sub), sub);
  ok('it says it tells you how to reach them', /tells you how to reach them/.test(sub), sub);
  ok('and that it is honest when there is no direct line',
    /honest when there is no direct line/.test(sub), sub);
  // The claim has to be true of the product, not just nice to read: the fallback
  // tier really is a shared line, and the ladder really does refuse to invent an
  // address.
  ok('the app really does ship a fallback tier rather than a guess',
    /Fallback/.test(IDX) && /Generic inbox \(no named contact\)/.test(
      fs.readFileSync(R + 'server/services/contactDiscovery.js', 'utf8')));
  ok('and the section below still states the no-guess rule',
    /Never a guessed email address/.test(TEXT));
}

console.log('\n-- 3. THE CONTACT LADDER SECTION --');
{
  const sec = TEXT.slice(TEXT.indexOf('<span class="eyebrow">Contact Ladder</span>'));
  const block = sec.slice(0, sec.indexOf('<span class="eyebrow">Programs</span>'));
  ok('it exists', block.length > 400, block.length);
  ok('same feature format as Deal Scan', /class="ftext"/.test(block) && /class="fimg"/.test(block));
  ok('in the same browser chrome', /class="browser"/.test(block) && /class="url"/.test(block));
  ok('finds a named person, not a front desk', /A name, not a front desk/.test(block));
  ok('ranked above the general line', /ranked above the general line/i.test(block));
  ok('direct email, phone and Instagram', /Direct email, direct phone, and Instagram/.test(block));
  ok('honest confidence labels', /Confident, Likely or Fallback/.test(block));
  ok('and never a guessed email', /Never a guessed email address/.test(block));
  ok('the confidence words match the app\'s own labels',
    ['Confident', 'Likely', 'Fallback'].every((w) => new RegExp('_DS_CONF_STYLE[\\s\\S]{0,300}' + w).test(IDX)));
  ok('the card shows all three labels', /Name: Confident/.test(block) && /Name: Likely/.test(block) && /Fallback/.test(block));
  ok('and demonstrates the no-guess rule in the card itself',
    /No email found, so none is shown/.test(block));
}

console.log('\n-- 4. THE PROGRAMS SECTION --');
{
  const sec = TEXT.slice(TEXT.indexOf('<span class="eyebrow">Programs</span>'));
  const block = sec.slice(0, sec.indexOf('<span class="eyebrow">AI Outreach</span>'));
  ok('it exists', block.length > 400, block.length);
  ok('names the people who decide roster spots', /The people who decide roster spots/.test(block));
  ok('lists the roles', /Head coaches, coordinators, general managers/.test(block));
  ok('names, titles, emails and phones', /Names, titles, emails and phone numbers/.test(block));
  ok('and a source link on every record', /A source link on every record/.test(block));
}

console.log('\n-- 5. THE ASSISTANT IS MENTIONED, BRIEFLY --');
{
  const band = TEXT.slice(TEXT.indexOf('<section class="asstband">'));
  const block = band.slice(0, band.indexOf('</section>'));
  ok('there is a band', block.length > 200, block.length);
  ok('it says the assistant knows the product', /knows how NILDash works/.test(block));
  ok('and can run scans, add athletes, draft outreach',
    /run a deal scan/i.test(block) && /add an athlete/i.test(block) && /draft outreach/i.test(block));
  ok('it is brief: no feature-sized screenshot slot', !/class="fimg"/.test(block));
  // The confirm tier is a real property of the product and worth stating.
  ok('and it says destructive actions ask first', /asks you first/.test(block));
}

console.log('\n-- 6. THE STATS ARE OURS --');
{
  // A fixed window: the first </div></div> after the strip opens is INSIDE the
  // first stat, so slicing to it measured one third of the row and called it three.
  const stripAt = TEXT.indexOf('<div class="strip">');
  const strip = TEXT.slice(stripAt, TEXT.indexOf('</section>', stripAt) === -1
    ? stripAt + 700 : Math.min(stripAt + 700, TEXT.length));
  ok('the category number is gone', !/2\.3B/.test(TEXT));
  ok('and the vague ones with it', !/AI-powered/.test(strip) && !/All-in-one/.test(strip), strip);
  ok('three stats', (strip.match(/class="stat"/g) || []).length === 3);
  ok('all three are countable facts',
    /119/.test(strip) && /126/.test(strip) && />7</.test(strip), strip);
}

console.log('\n-- EVERY IN-PAGE LINK GOES SOMEWHERE --');
{
  const ids = new Set([...MKT.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]));
  const hrefs = [...TEXT.matchAll(/href="#([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  ok('there are anchors to check', hrefs.length >= 6, hrefs.length);
  const dead = [...new Set(hrefs)].filter((h) => h !== 'top' && !ids.has(h));
  ok('no anchor points at a section that does not exist', dead.length === 0, dead);
  ok('the teams contact section exists', ids.has('contact-teams'));
  ok('and gives a real way to reach us', /mailto:contact@mynildash\.com/.test(TEXT));
}

console.log('\n-- THE SIGNIN SECTION SPEAKS TO ALL THREE --');
{
  const at = TEXT.indexOf('<section id="signin">');
  const sec = TEXT.slice(at, TEXT.indexOf('</section>', at));
  ok('the section exists', at !== -1 && sec.length > 200, sec.length);
  ok('it no longer says it is built for agents alone', !/Built for sports agents/.test(sec), sec.slice(0, 200));
  ok('and that line is gone from the whole rendered page', !/Built for sports agents/.test(VISIBLE));
  ok('three cards, one per audience', (sec.match(/class="ac"/g) || []).length === 3,
    (sec.match(/class="ac"/g) || []).length);
  ok('agents open the auth panel', /class="ac" href="#" onclick="mktOpenAuth\('agent'\);return false"/.test(sec));
  ok('athletes go to the self-serve portal', /class="ac" href="\/athletes"/.test(sec));
  ok('teams go to the contact section', /class="ac" href="#contact-teams"/.test(sec));
  ok('each card names its audience', /class="t">Agent</.test(sec)
    && /class="t">Athlete</.test(sec) && /class="t">Team or league</.test(sec));
  // The prices here must agree with the cards in the hero, or the page argues with
  // itself one scroll apart.
  ok('the agent price matches the hero', /\$99\/month/.test(sec));
  ok('the athlete row says free, with no price', /Free, no card required/.test(sec) && !/\$25/.test(sec));
  ok('and teams quote no number at all', !/#contact-teams[\s\S]*?\$\d/.test(sec));
  // Distinct monograms: Agent and Athlete both start with A, so a single letter
  // would have printed the same mark twice.
  const icos = [...sec.matchAll(/class="ico">([^<]+)</g)].map((m) => m[1]);
  ok('three distinct monograms', icos.length === 3 && new Set(icos).size === 3, icos);
  // The stylesheet lives in <head>, ABOVE the #mktLanding block, so MKT does not
  // contain it -- this has to read the whole file.
  ok('and the tile is sized for two letters', /\.ac \.ico\{[^}]*font-size:13px/.test(IDX));
}

console.log('\n-- ONE PUBLIC CONTACT ADDRESS --');
{
  const WANT = 'contact@mynildash.com';
  // The marketing block: footer, teams contact, anywhere else.
  const mktMailtos = [...VISIBLE.matchAll(/mailto:([^"?&]+)/g)].map((m) => m[1]);
  ok('the marketing block has contact links', mktMailtos.length >= 2, mktMailtos);
  ok('every one is the single public address',
    mktMailtos.every((a) => a === WANT), mktMailtos);
  ok('the footer Contact link is it', /mailto:contact@mynildash\.com">Contact</.test(VISIBLE));
  ok('the teams section is it too, subject line intact',
    /mailto:contact@mynildash\.com\?subject=Team%20pricing/.test(VISIBLE));
  ok('and the address is shown as text, not just linked',
    />contact@mynildash\.com</.test(VISIBLE));
  ok('no retired address survives in the marketing block',
    !/support@mynildash|hello@mynildash/.test(VISIBLE),
    (VISIBLE.match(/\w+@mynildash\.com/g) || []));

  // The auth screen sits below the marketing block and carries its own contact link.
  const ai = IDXC.indexOf('id="authScreen"');
  const auth = IDXC.slice(ai, IDXC.indexOf('id="appScreen"', ai));
  ok('the auth screen contact link is the same address',
    !/mailto:(?!contact@mynildash\.com)/.test(auth),
    (auth.match(/mailto:[^"?&]+/g) || []));

  // Every public page, so a second address cannot reappear on one nobody re-reads.
  // privacy.html is the KNOWN exception: it names a personal address as the privacy
  // contact, and changing where privacy requests are legally routed is not a copy
  // edit. Listed here so the exception stays visible instead of silent.
  const pages = fs.readdirSync(R + 'public').filter((f) => /\.html$/.test(f));
  const offenders = [];
  for (const p of pages) {
    if (p === 'privacy.html') continue;
    const body = nocomment(fs.readFileSync(R + 'public/' + p, 'utf8'));
    for (const m of body.matchAll(/mailto:([^"?&'\s]+)/g)) {
      // Skip templated hrefs built from data (mailto:' + c.email + ', ${agentEmail}).
      if (/[$'`+{]/.test(m[1])) continue;
      if (m[1] !== WANT) offenders.push(p + ' -> ' + m[1]);
    }
  }
  ok('no public page links a different contact address', offenders.length === 0, offenders);
  ok('privacy.html is still the one known exception',
    /jmcompton04@gmail\.com/.test(fs.readFileSync(R + 'public/privacy.html', 'utf8')));
}

console.log('\n-- THE AUTH SCREEN DOES NOT CONTRADICT THE PAGE BEHIND IT --');
{
  // One click from Get started, so it is held to the same standard as the hero.
  // IDXC, not TEXT: this lives below the marketing block, and the comments
  // explaining what was removed must not answer the "is it gone" assertions.
  const as = IDXC.indexOf('<div class="auth-left">');
  const left = IDXC.slice(as, IDXC.indexOf('<!-- RIGHT', as));
  ok('the panel is readable', as !== -1 && left.length > 400, left.length);

  ok('the category headline is gone', !/NIL IS A/i.test(left));
  ok('the industry stat is gone', !/\$2\.3B/.test(left));
  ok('the vague stats went with it',
    !/AI-Powered/.test(left) && !/All-in-One/.test(left));
  ok('and the only-platform claim', !/only platform/i.test(left));
  ok('and the unverifiable trust line', !/Trusted by sports agents/i.test(left));

  // It says what the hero says, read from the hero rather than retyped.
  const h1 = /<h1 class="h1">([\s\S]*?)<\/h1>/.exec(TEXT)[1];
  const sub = /<p class="sub">([\s\S]*?)<\/p>/.exec(TEXT)[1];
  const ah1 = /<h1 class="auth-headline">([\s\S]*?)<\/h1>/.exec(left)[1];
  const asub = /<p class="auth-tagline">([\s\S]*?)<\/p>/.exec(left)[1];
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  ok('the headline matches the hero word for word', strip(ah1) === strip(h1), [strip(ah1), strip(h1)]);
  ok('and the sub does too', strip(asub) === strip(sub), [strip(asub), strip(sub)]);
  ok('the accent split is kept, in this screen palette',
    /<span class="a">And the person who can say yes\.<\/span>/.test(ah1)
    && /\.auth-headline \.a\{color:#16a34a\}/.test(IDX));

  // The numbers are ours, and still checked against the code that produces them.
  const stats = [...left.matchAll(/auth-stat-val">([^<]*)<[\s\S]*?auth-stat-label">([^<]*)</g)]
    .map((m) => [m[1].trim(), m[2].trim()]);
  ok('three stats', stats.length === 3, stats);
  ok('all three are countable', stats.every((s) => /^\d+$/.test(s[0])), stats.map((s) => s[0]));
  const srcCount = /const _CONTACT_SOURCES = \[([^\]]+)\]/.exec(AI)[1]
    .split(',').map((x) => x.trim()).filter(Boolean).length;
  ok('the source count is the real one', stats.some((s) => s[0] === String(srcCount)
    && /Sources per contact lookup/.test(s[1])), [stats, srcCount]);
  ok('the program counts match the landing strip',
    stats.some((s) => s[0] === '119' && /Football/.test(s[1]))
    && stats.some((s) => s[0] === '126' && /basketball/i.test(s[1])), stats);
  ok('and they are the same numbers the landing shows',
    /<div class="n">119<\/div>/.test(TEXT) && /<div class="n">126<\/div>/.test(TEXT));

  // The headline is a sentence now; the old size ran it off the panel.
  ok('the headline is sized for a sentence',
    /\.auth-headline\{[^}]*font-size:clamp\(30px,3\.1vw,42px\)/.test(IDX));
}

console.log('\n-- A RETURNING ACCOUNT HAS A WAY BACK IN --');
{
  const at = TEXT.indexOf('<section id="signin">');
  const sec = TEXT.slice(at, TEXT.indexOf('</section>', at));
  ok('the landing offers an existing-account route', /class="haveacct"/.test(sec));
  ok('athletes get the real athlete login', /href="\/athlete-login\.html"/.test(sec));
  ok('agents get the panel that carries the sign-in form',
    /haveacct[\s\S]*?mktOpenAuth\('agent'\)/.test(sec));

  // The auth-screen chooser. Its athlete row must NOT point at the in-page panel:
  // that posts to /api/auth/login (USERS table), and no live signup path writes a
  // users row for an athlete -- they all authenticate off the ATHLETES table.
  const cs = IDXC.indexOf('<div id="authRoleChooser">');
  const ce = IDXC.indexOf('auth-footer-links', cs);
  const chooser = IDXC.slice(cs, ce);
  ok('the chooser block is readable', cs !== -1 && ce > cs && chooser.length > 400, chooser.length);
  // The boundary matters: class="signin-card also prefix-matches signin-card-icon,
  // -body, -title, -desc and -arrow, which counted 13 "cards" in two.
  ok('it no longer offers agents alone', (chooser.match(/class="signin-card[ "]/g) || []).length === 2,
    (chooser.match(/class="signin-card[ "]/g) || []).length);
  ok('and the athlete row goes to /athlete-login.html',
    /class="signin-card" href="\/athlete-login\.html"/.test(chooser));
  ok('NOT to the dead in-page panel', !/chooseAuthRole\('athlete'\)/.test(chooser));
  ok('the subtitle stopped saying agent account', !/Sign in to your agent account/.test(chooser));

  // Why: prove the dead path is really dead, so this cannot be "helpfully" rewired.
  const callers = fs.readdirSync(R + 'public').filter((f) => /\.(html|js)$/.test(f))
    .filter((f) => /athlete-portal\/accept/.test(nocomment(fs.readFileSync(R + 'public/' + f, 'utf8'))));
  ok('nothing in public/ calls the route that writes an athlete users row',
    callers.length === 0, callers);
  ok('and the live athlete login reads the athletes table',
    /app\.post\('\/api\/athlete\/login'[\s\S]{0,900}FROM athletes a/.test(SRV));
  ok('which is what /athlete-login.html posts to',
    /\/api\/athlete\/login/.test(fs.readFileSync(R + 'public/athlete-login.html', 'utf8')));
  ok('the dead panel is labelled so it stays dead', /LEGACY, INTENTIONALLY UNREACHABLE/.test(IDX));

  // The shared class now styles a <button> and an <a>; without explicit type they
  // inherit different UA typography and the cards differ in height.
  ok('the card class pins its own typography',
    /\.signin-card\{[^}]*font-size:13px;line-height:1\.45/.test(IDX));
}

console.log('\n-- EVERY MODEL-SPENDING ROUTE IS BEHIND THE PAYWALL --');
{
  // The invariant, not a list of known routes: anything carrying aiLimiter spends
  // tokens, so it must be gated. Three ways that is legitimately satisfied --
  // an explicit requireAgentSubscription, a prefix gated by app.use, or
  // verifyAthleteToken (the athlete portal is free by design, BILLING_ENABLED off).
  const gatedPrefixes = [...SRV.matchAll(/app\.use\('(\/api\/[a-z-]+)', requireAgentSubscription\)/g)]
    .map((m) => m[1]);
  ok('the app.use gate list is readable', gatedPrefixes.length >= 4, gatedPrefixes);

  const routes = [...SRV.matchAll(/app\.(?:get|post|put|patch|use)\('(\/api\/[^']*)'([^\n]*aiLimiter[^\n]*)/g)]
    .map((m) => ({ path: m[1], mw: m[2] }));
  ok('there are model-spending routes to check', routes.length >= 30, routes.length);

  // A named auth wrapper counts as gated ONLY if it is proved to gate below.
  // /api/assistant now mounts on assistantAuth, which branches to
  // requireAgentSubscription or requireAthleteSubscription depending on the
  // credential -- so the literal-middleware match no longer sees it.
  const ungated = routes.filter((r) =>
    !/requireAgentSubscription|requireAthleteSubscription|assistantAuth/.test(r.mw)
    && !/verifyAthleteToken/.test(r.mw)
    && !gatedPrefixes.some((p) => r.path === p || r.path.startsWith(p + '/')));
  ok('no model-spending route is reachable without a subscription', ungated.length === 0,
    ungated.map((r) => r.path));

  // The wrapper is only acceptable because BOTH of its branches gate. Asserted
  // rather than assumed, or "gated by a named function" would become a hole.
  const aa = SRV.slice(SRV.indexOf('function assistantAuth('), SRV.indexOf('app.use(\'/api/assistant\''));
  ok('assistantAuth exists and is readable', aa.length > 200, aa.length);
  ok('  its agent branch gates on the agent subscription', /return requireAgentSubscription\(req, res, next\)/.test(aa));
  ok('  its athlete branch gates on the athlete subscription', /return requireAthleteSubscription\(req, res, next\)/.test(aa));
  ok('  and a caller with neither credential gets 401',
    /return res\.status\(401\)\.json\(\{ error: 'Not authenticated' \}\);/.test(aa));
  ok('  the athlete branch requires a SIGNED token, not a header claim',
    /verifyAthleteToken\(req, res,/.test(aa));

  // The three this change closed, named so a regression says which one broke.
  // The assistant now serves two kinds of caller, so it mounts on assistantAuth
  // rather than requireAuth+requireAgentSubscription directly. The block above
  // asserts BOTH of that wrapper's branches gate; this asserts the mount uses it.
  ok('the assistant is gated', /app\.use\('\/api\/assistant', assistantAuth, aiLimiter, assistantRoutes\)/.test(SRV));
  ok('pdf analyze is gated', /app\.post\('\/api\/pdf\/analyze', requireAuth, requireAgentSubscription/.test(SRV));
  ok('the daily brief is gated', /app\.post\('\/api\/agent\/daily-brief', requireAuth, requireAgentSubscription/.test(SRV));
  // Order matters: requireAgentSubscription defers to requireAuth when there is no
  // session, so putting it first would let an anonymous request through.
  ok('and auth always runs before the subscription check',
    !/requireAgentSubscription,\s*requireAuth/.test(SRV));

  // The deferred webhook defect is written down where whoever fixes it will look.
  // THE COMMENT BLOCK, not 1600 characters of whatever follows. The real gap was
  // 1366, so a couple of added lines would have broken this for no reason -- and
  // a window that wide could just as easily match an unrelated mention further
  // down. Read the contiguous run of // lines that IS the note, and assert on it.
  const noteAt = SRV.indexOf('KNOWN DEFECT');
  ok('the trialing-vs-active defect is recorded in the source', noteAt > -1, noteAt);
  const lines = SRV.slice(SRV.lastIndexOf('\n', noteAt) + 1).split('\n');
  const note = [];
  for (const L of lines) { if (!/^\s*\/\//.test(L)) break; note.push(L); }
  const NOTE = note.join('\n');
  ok('  the note is a real block, not a stray mention', note.length >= 3, note.length);
  // WHAT THE NOTE ITSELF SAYS. The old window matched
  // "subscription_status = 'trialing'" up to 1600 characters away -- which is the
  // CODE below the comment, not the comment. So an assertion named "the defect is
  // recorded" was really only proving the buggy line still exists, and would have
  // passed with the note deleted entirely.
  ok('  it names the wrong value being written', /'trialing'/.test(NOTE), NOTE.slice(0, 160));
  ok('  and says it is reporting, not access', /Not an access bug/.test(NOTE), NOTE.slice(0, 160));
  ok('  and points at the fix', /The fix is/.test(NOTE), NOTE.slice(0, 160));
  // Separately: it sits ON the line it describes. A note filed somewhere else is
  // how a known defect gets fixed twice or not at all.
  const codeAfter = SRV.slice(noteAt + NOTE.length, noteAt + NOTE.length + 400);
  ok('  and the line it describes is directly beneath it',
    /subscription_status/.test(codeAfter) && /'trialing'/.test(codeAfter),
    codeAfter.replace(/\s+/g, ' ').slice(0, 200));
}

console.log('\n-- 7. THE ASSISTANT NEVER RENDERS ON A PUBLIC PAGE --');
{
  ok('a rule hides it outside the portal',
    /body:not\(\.app-active\) #nil-assistant\{display:none !important;\}/.test(CL));
  // app-active is the app shell's own marker, added on boot and removed on the way
  // out, which is why it is the right hook.
  ok('bootApp adds the marker', /document\.body\.classList\.add\('app-active'\)/.test(IDX));
  ok('and returning to the marketing page removes it',
    /showMarketingLanding\(\)[\s\S]{0,400}classList\.remove\('app-active'\)/.test(IDX));
  ok('signing out returns to the marketing page WITHOUT a reload, which is the bug',
    /async function doLogout\(\)[\s\S]{0,260}showMarketingLanding\(\)/.test(IDX)
    && !/async function doLogout\(\)[\s\S]{0,260}location\.reload/.test(IDX));
  ok('and the assistant still mounts only after auth', /if \(window\.nilAssistant\) window\.nilAssistant\.init\(/.test(IDX));
  ok('no other public html loads assistant.js',
    !fs.readdirSync(R + 'public').filter((x) => x.endsWith('.html') && x !== 'index.html')
      .some((x) => /assistant\.js/.test(fs.readFileSync(R + 'public/' + x, 'utf8'))),
    fs.readdirSync(R + 'public').filter((x) => x.endsWith('.html') && x !== 'index.html'
      && /assistant\.js/.test(fs.readFileSync(R + 'public/' + x, 'utf8'))));
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
