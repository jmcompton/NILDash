'use strict';
// ── IS THIS ADDRESS THE NAMED PERSON'S? (services/sendGate) ─────────────────
//
// The send gate asked one question of an address: does its local part contain
// the person's first or last name of three letters or more? Real owners'
// mailboxes failed it, and stop-unverified stopped them on production:
//
//   rob@drrobertshire.com    Robert Shire   a nickname
//   jj@ripple-retreat.com    JJ Holley      a two-letter first name
//   dj@ostromservices.com    D.J. Ostrom    initials as a first name
//   s@victoryma.com          Ralph S.       a single letter (still blocked, below)
//
// An address now matches the named person when its local part (letters only,
// "+tag" dropped) is one of:
//   - their first or last name, or contains one of three letters or more
//     (the old rule, unchanged);
//   - their initials: first and last (rs), or every word (rjs, djo);
//   - first initial + last name (rshire), first name + last initial (roberts);
//   - a common nickname of the first name (rob, bob, bobby for Robert; and
//     the other way, robert for a card that says Bob), alone or with the last
//     name or its initial (bobshire, bobs).
//
// A SINGLE LETTER (s@) IS NOT A NAME. It matches only when it is the first
// initial AND the address is on the person's own small business: a domain
// that is the business on the card (not a personal mailbox, not a chain's
// corporate site), a local business, and a title that says they own it.
// Anything missing is a block: when unsure, block.
//
// This decides only whose address it is. The gate still needs a "valid"
// verification in the last 30 days, and shared and department inboxes
// (info@, contact@, hello@, sales@, legal@ ...) are refused before this runs.

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const letters = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

// ── NICKNAMES ───────────────────────────────────────────────────────────────
// Each line is a full name, then the short forms it goes by. A full name
// matches its short forms and a short form matches its full name ("Bob" on the
// card, robert@), but two short forms of one name do not match each other
// ("Bert" is not bob@). A short form can belong to more than one full name
// (al: Albert, Alan, Alfred, Alexander).
const FAMILIES = `
robert rob bob bobby robbie robby bert
william will bill billy willy willie liam
michael mike mikey mick mickey
james jim jimmy jamie jimi
john jon johnny jack jackie
jonathan jon jonny
richard rich rick ricky dick richie
thomas tom tommy
charles charlie chuck chas chaz
christopher chris kris topher
joseph joe joey jo
daniel dan danny
david dave davey
matthew matt matty
anthony tony
andrew andy drew
edward ed eddie ted teddy ned
edwin ed eddie
theodore ted teddy theo
steven steve stevie
stephen steve stevie
kenneth ken kenny
ronald ron ronnie
donald don donnie
timothy tim timmy
gregory greg
jeffrey jeff
geoffrey jeff geoff
douglas doug
lawrence larry laurie
gerald gerry jerry
jerome jerry
jeremy jerry
joshua josh
jacob jake jay
benjamin ben benny benji
samuel sam sammy
nicholas nick nicky nico
patrick pat patty paddy
peter pete
philip phil
phillip phil
raymond ray
russell russ rusty
stanley stan
vincent vince vin vinny
walter walt wally
zachary zach zack zak
alexander alex al xander
albert al bert bertie
alan al
allen al
alfred al alf alfie fred freddie
frederick fred freddie freddy rick
francis frank frankie fran
franklin frank frankie
henry hank harry hal
harold harry hal
eugene gene
gabriel gabe
kevin kev
leonard len lenny leo
louis lou louie
lewis lou louie
manuel manny
martin marty
maxwell max
maximilian max
mitchell mitch
nathaniel nate nathan nat
oliver ollie
randall randy
randolph randy
reginald reggie reg
rodney rod
rudolph rudy
salvatore sal
sidney sid
tobias toby
wesley wes
woodrow woody
abraham abe
clifford cliff
curtis curt
ernest ernie
gilbert gil
herbert herb bert
isaac ike izzy
norman norm
sheldon shel
simon si
ezekiel zeke
arthur art artie
elizabeth liz lizzie beth betsy betty libby eliza ellie
katherine kate katie kathy kat
catherine cathy cate kate katie
kathleen kathy kate katie
margaret maggie meg peggy marge margie
jennifer jen jenny jenn
jessica jess jessie
susan sue susie suzy
suzanne sue susie suzy
patricia pat patty trish tricia
rebecca becky becca
cynthia cindy
deborah deb debbie debra
dorothy dot dottie
eleanor ellie nell nellie
jacqueline jackie jacqui
judith judy
amanda mandy
melissa mel missy
melanie mel
sandra sandy
stephanie steph stevie
valerie val
victoria vicky tori
barbara barb barbie
beverly bev
constance connie
diana di
florence flo
abigail abby gail
virginia ginny
gwendolyn gwen
janet jan
janice jan
kristen kris kristy
kristina kris tina
christina chris tina chrissy
christine chris chrissy
alexis lexi alex
alexandra alex lexi sandra sandy
lorraine lori
madeline maddie
madison maddie
marjorie marge margie
mildred millie
mary molly
nicole nikki nicky
pamela pam
penelope penny
rosemary rosie
rose rosie
sarah sally
sara sally
michelle shelly
theresa tess terry
teresa tess terry
terrence terry
gertrude trudy
winifred winnie
samantha sam sammy
alison ali allie
allison ali allie
alice ali allie
`.trim().split('\n').map((l) => l.trim().split(/\s+/).filter(Boolean)).filter((f) => f.length > 1);

// name -> the names it can stand for: a full name's short forms, a short
// form's full names.
const NICK = new Map();
const link = (a, b) => { if (!NICK.has(a)) NICK.set(a, new Set()); NICK.get(a).add(b); };
for (const [full, ...short] of FAMILIES) for (const n of short) { if (n !== full) { link(full, n); link(n, full); } }
function nicknamesOf(first) {
  const s = NICK.get(letters(first));
  return s ? [...s] : [];
}

// ── THE NAME, IN PARTS ──────────────────────────────────────────────────────
const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|rev|jr|sr|ii|iii|iv|md|dds|dmd|dvm|phd|esq|cpa)\.?$/i;
function partsOf(name) {
  const words = String(name || '').replace(/\([^)]*\)/g, ' ').split(/[\s,]+/).filter(Boolean)
    .filter((w) => !HONORIFIC.test(w)).map(letters).filter(Boolean);
  if (!words.length) return null;
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : '';
  return { words, first, last, f: first[0], l: last ? last[0] : '' };
}

// The local part as compared: before any +tag, letters only.
function localOf(email) {
  const e = lc(email);
  const at = e.lastIndexOf('@');
  if (at < 1) return '';
  return letters(e.slice(0, at).split('+')[0]);
}
const domainOf = (email) => { const e = lc(email); return e.slice(e.lastIndexOf('@') + 1); };

// ── THE PERSON'S OWN SMALL BUSINESS (only for a single-letter address) ──────
// ctx: { brand, title, lane, sizeBand }. -> { ok, why }
const OWNER_TITLE = /\b(owner|co-?owner|founder|co-?founder|proprietor|president|principal|ceo|managing (member|partner))\b/i;
function ownSmallBusiness(email, ctx = {}) {
  const domain = domainOf(email);
  const ET = require('./emailTier');
  if (ET.isFreeMail(email)) return { ok: false, why: `${domain} is a personal mailbox provider, not their business` };
  if (!String(ctx.brand || '').trim()) return { ok: false, why: 'there is no business on the card to hold the domain to' };
  const dm = require('./siteEmail').domainMatchesBusiness(ctx.brand, domain);
  if (!dm || !dm.plausible || !dm.matchedOn) return { ok: false, why: `${domain} could not be matched to ${ctx.brand}` };
  const corp = require('./emailFinder').corporateDomain(domain, ctx.brand, null);
  if (corp) return { ok: false, why: corp };
  const small = ['local', 'hometown'].includes(lc(ctx.lane)) || ['local', 'small'].includes(lc(ctx.sizeBand));
  if (!small) return { ok: false, why: `${ctx.brand} is not on the card as a local business` };
  if (!OWNER_TITLE.test(String(ctx.title || ''))) return { ok: false, why: `their title (${ctx.title || 'none on the card'}) does not say they own ${ctx.brand}` };
  return { ok: true, why: null };
}

// ── THE MATCH. Pure. ────────────────────────────────────────────────────────
// -> { ok: true, how } | { ok: false, why }
function match(email, name, ctx = {}) {
  const local = localOf(email);
  const p = partsOf(name);
  if (!local || !p) return { ok: false, why: 'there is no address or no name to compare' };
  const { first, last, f, l, words } = p;
  const nicks = nicknamesOf(first);
  const who = String(name).trim();

  if (local.length === 1) {
    if (local !== f) return { ok: false, why: `${local}@ is a single letter, and not ${who}'s first initial` };
    const own = ownSmallBusiness(email, ctx);
    if (!own.ok) return { ok: false, why: `${local}@ is a single letter, and it could not be confirmed as ${who}'s own small business (${own.why})` };
    return { ok: true, how: 'first initial, on their own small business' };
  }

  const exact = [];
  const add = (form, how) => { if (form && form.length >= 2) exact.push([form, how]); };
  add(first, 'first name');
  add(last, 'last name');
  if (last) {
    add(f + l, 'initials');
    add(f + last, 'first initial and last name');
    add(first + l, 'first name and last initial');
  }
  if (words.length >= 3) add(words.map((w) => w[0]).join(''), 'initials');
  // A first name that is itself initials (D.J., JJ) with the last initial.
  if (last && first.length <= 3) add(first + l, 'initials');
  for (const n of nicks) {
    add(n, 'nickname');
    if (last) { add(n + last, 'nickname and last name'); add(n + l, 'nickname and last initial'); }
  }
  const hit = exact.find(([form]) => form === local);
  if (hit) return { ok: true, how: hit[1] };

  // The old rule: the first or last name, three letters or more, inside it.
  const inside = [first, last].find((t) => t && t.length >= 3 && local.includes(t));
  if (inside) return { ok: true, how: inside === first ? 'carries the first name' : 'carries the last name' };

  return { ok: false, why: `${lc(email)} is not ${who}'s address (it is not their name, initials or a nickname)` };
}

// Whether the single-letter case needs the card's business details at all.
function needsContext(email) { return localOf(email).length === 1; }

module.exports = { match, ownSmallBusiness, nicknamesOf, partsOf, localOf, needsContext, FAMILIES, OWNER_TITLE };
