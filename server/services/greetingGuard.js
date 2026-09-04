'use strict';
// A GENERATED EMAIL MAY ONLY GREET A NAME THAT WAS DISCOVERED.
//
// Every prompt in this codebase tells the model not to invent a recipient. Both of
// them: pitchGeneration sets the greeting to "Hi," when there is no verified
// contact, and draftPrewarm says "Do NOT invent a name" in capitals. Neither was
// ENFORCED. full_email_body was taken verbatim from the model, and checkDraft
// looked at banned phrases, business naming and sentence count -- never at who the
// email was addressed to.
//
// So an email opened "Dawn," for a business whose contact panel said "No named
// contact found". Nothing had discovered Dawn. The model produced a plausible name
// for a chiropractor, most likely off the enrichment description, and every layer
// downstream passed it through because none of them was looking.
//
// That is the worst failure this product can have. An agent sends a cold email to a
// real local business addressed to someone who may not work there, under their
// athlete's name. A wrong greeting is worse than no greeting, and worse than no
// email at all.
//
// This is the enforcement. It runs AFTER generation, on the text that will actually
// be sent, and it does not ask -- it rewrites. A greeting naming anyone who is not
// a verified contact becomes "Hi,".

// Salutation words that may precede a name. Matched case-insensitively.
const SALUTATIONS = ['hi', 'hello', 'hey', 'dear', 'good morning', 'good afternoon', 'good evening', 'greetings'];
// Honorifics stripped before comparing, so a verified "Dawn Whitfield" still matches
// a greeting of "Dr. Dawn".
const HONORIFICS = /^(dr|mr|mrs|ms|miss|prof|professor|doctor|coach)\.?\s+/i;
// The same words on their own. A greeting addressed to a bare title -- "Dr.," --
// names nobody, and it is what you get when a name is split on whitespace and the
// first token happens to be the honorific.
const HONORIFIC_ONLY = /^(dr|mr|mrs|ms|miss|prof|professor|doctor|coach)\.?$/i;

function isHonorificOnly(s) {
  return HONORIFIC_ONLY.test(String(s || '').trim());
}

function _norm(s) {
  return String(s || '').trim().toLowerCase().replace(/[‘’ʼ]/g, "'");
}

// Every form of a verified contact's name that a greeting could legitimately use:
// the full name, the first name, the last name, and the same without an honorific.
function allowedGreetingNames(contacts) {
  const out = new Set();
  const add = (v) => { const s = _norm(v); if (s) out.add(s); };
  for (const c of (Array.isArray(contacts) ? contacts : [])) {
    const raw = c && typeof c === 'object' ? c.name : c;
    const full = String(raw || '').trim();
    if (!full) continue;
    const bare = full.replace(HONORIFICS, '').trim();
    for (const n of [full, bare]) {
      add(n);
      const parts = n.split(/\s+/).filter(Boolean);
      // A bare honorific is never a name. Adding parts[0] of "Dr. Dawn Mercer" put
      // "dr." in the allowed set, so a greeting of "Dr.," -- which names nobody --
      // was accepted as if it addressed her.
      const nameParts = parts.filter((x) => !isHonorificOnly(x));
      if (nameParts.length > 1) { add(nameParts[0]); add(nameParts[nameParts.length - 1]); }
      else if (nameParts.length === 1) add(nameParts[0]);
    }
  }
  return out;
}

// Who does this line address? Returns null when the line is not a greeting at all,
// and '' when it is a greeting addressed to nobody ("Hi,"), which is always fine.
function addresseeOf(line) {
  let s = String(line == null ? '' : line).trim();
  if (!s) return null;
  // A greeting line is short. A first sentence of prose is not a greeting, and
  // must never be rewritten.
  if (s.length > 40) return null;
  const hadComma = /[,:]\s*$/.test(s);
  s = s.replace(/[,:]\s*$/, '').trim();
  const lower = _norm(s);
  let rest = null;
  for (const sal of SALUTATIONS) {
    if (lower === sal) return '';                       // "Hi," / "Hello"
    if (lower.startsWith(sal + ' ')) { rest = s.slice(sal.length).trim(); break; }
  }
  if (rest === null) {
    // A line that is ONLY an honorific is a greeting fragment whatever its
    // punctuation. No sentence of prose is the single word "Dr."
    if (isHonorificOnly(s)) return s;
    // No salutation word. Only treat it as a greeting when it is a bare name
    // followed by a comma -- "Dawn," -- which is exactly the observed failure.
    if (!hadComma) return null;
    if (!/^[A-Z][A-Za-z'’.\-]*(\s+[A-Z][A-Za-z'’.\-]*){0,2}$/.test(s)) return null;
    rest = s;
  }
  return rest.replace(HONORIFICS, '').trim();
}

// The rule. body is plain text; contacts are the VERIFIED contacts, i.e. the ones
// good enough to greet by name. Returns { body, changed, removedName }.
function enforceGreeting(body, contacts) {
  const text = String(body == null ? '' : body);
  if (!text.trim()) return { body: text, changed: false, removedName: null };
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;      // skip leading blanks
  if (i >= lines.length) return { body: text, changed: false, removedName: null };

  const who = addresseeOf(lines[i]);
  if (who === null || who === '') return { body: text, changed: false, removedName: null };

  // A title with no name is always wrong, whoever is on file. "Dr.," is not a
  // greeting, it is the wreckage of one.
  const allowed = allowedGreetingNames(contacts);
  if (!isHonorificOnly(who) && allowed.has(_norm(who))) return { body: text, changed: false, removedName: null };

  lines[i] = 'Hi,';
  return { body: lines.join('\n'), changed: true, removedName: who };
}

// Same rule for a body already rendered to HTML. Only the first text-bearing block
// is considered, for the same reason: a greeting is the first line or it is not a
// greeting.
function enforceGreetingHtml(html, contacts) {
  const s = String(html == null ? '' : html);
  if (!s.trim()) return { html: s, changed: false, removedName: null };
  // First chunk of text before a tag boundary, which is where a greeting lives.
  const m = s.match(/^([\s\S]*?)(<(?:div|p|br)\b[^>]*>)([\s\S]*)$/i);
  const head = m ? m[1] : s;
  const stripped = head.replace(/<[^>]*>/g, '').trim();
  const who = addresseeOf(stripped);
  if (who === null || who === '') {
    // The greeting may be inside the FIRST block rather than before it.
    const first = s.match(/<(div|p)\b[^>]*>([\s\S]*?)<\/\1>/i);
    if (!first) return { html: s, changed: false, removedName: null };
    const inner = first[2].replace(/<[^>]*>/g, '').trim();
    const who2 = addresseeOf(inner);
    if (who2 === null || who2 === '') return { html: s, changed: false, removedName: null };
    const allowed2 = allowedGreetingNames(contacts);
    if (!isHonorificOnly(who2) && allowed2.has(_norm(who2))) return { html: s, changed: false, removedName: null };
    return {
      html: s.replace(first[0], first[0].replace(first[2], 'Hi,')),
      changed: true, removedName: who2,
    };
  }
  const allowed = allowedGreetingNames(contacts);
  if (!isHonorificOnly(who) && allowed.has(_norm(who))) return { html: s, changed: false, removedName: null };
  return { html: s.replace(head, head.replace(stripped, 'Hi,')), changed: true, removedName: who };
}

// ── Is this contact good enough to greet by first name? ─────────────────────
//
// THE BUG THIS EXISTS TO CLOSE. The rule used to be `c.name && c.email`. That is
// exactly the shape a low-confidence source produces: a name it associated with
// a domain, and an address it associated with the name, neither of them evidence
// that the person holds a job at this business. Hunter did this -- it created a
// contact titled "Company contact (not confirmed owner)" carrying both fields,
// the guard approved it, and shipped code produced `greeting kept: true "Dana,"`.
// The title said in words that we did not know who she was, and nothing read it.
//
// Hunter is gone, but the hole is not Hunter-shaped. Any source that supplies a
// name beside an unconfirmed address trips it identically, so the fix is on the
// guard, not on the source.
//
// A name plus an address is now necessary and NOT sufficient. There must also be
// a real role title, and nothing may contradict it.

// Titles that mean a real person in a real job. Deliberately broad: local
// businesses put the decision maker under every one of these words, and a
// department a person was actually named under ("Brand Partnerships") is a real
// answer to "who is this", unlike a placeholder.
const ROLE_TITLE = new RegExp('\\b(' + [
  'owner', 'co-?owner', 'proprietor', 'founder', 'co-?founder', 'partner',
  'president', 'vice[- ]president', 'vp', 'principal', 'principal broker',
  'ceo', 'cfo', 'coo', 'cmo', 'cto', 'chief[a-z ]*officer',
  'managing (partner|director|member)', 'director', 'manager', 'general manager', 'gm',
  'head (of|chef)', 'supervisor', 'lead', 'coordinator', 'administrator',
  'bookkeeper', 'accountant', 'controller', 'buyer', 'operator', 'franchisee',
  'marketing', 'partnerships?', 'sponsorships?', 'sales', 'operations',
  'communications', 'community', 'brand',
  'chef', 'dentist', 'doctor', 'physician', 'surgeon', 'attorney', 'lawyer',
  'agent', 'broker', 'realtor', 'stylist', 'barber', 'trainer', 'instructor',
  'pharmacist', 'veterinarian', 'optometrist', 'chiropractor', 'therapist',
].join('|') + ')\\b', 'i');

// Titles that mean we do NOT know who this is. CHECKED FIRST, and that ordering
// is the whole fix: "Company contact (not confirmed owner)" CONTAINS the word
// owner, so a whitelist consulted first would pass the exact string that caused
// fbf5865. A placeholder that happens to name a role is still a placeholder.
const NON_ROLE_TITLE = new RegExp('(' + [
  'not confirmed', 'unconfirmed', 'not verified', 'unverified', 'possible', 'may not',
  'company contact', 'business contact', 'primary contact', 'listed contact',
  'general (inbox|contact)', 'named mailbox', 'main line', 'business line',
  'contact form', 'no contact', 'no named', 'staff', 'employee', 'team member',
  'placeholder', 'unknown',
  // A ROTA, NOT A JOB. "Manager on duty" names whoever is working this shift, so
  // it is a description of a slot rather than of a person -- greeting it by first
  // name asserts that this individual holds a standing role they may not have.
  // It used to be refused only incidentally, by the evidence rule that required a
  // published address; once a chamber listing alone can earn a greeting, the
  // title has to refuse it on its own.
  'on duty',
].join('|') + ')', 'i');

// contactDiscovery does `strNull(c.title) || 'Marketing / Partnerships'`, so a
// contact the model returned with NO title is stored looking exactly like one it
// gave a department for. That default is a fabricated title and is treated as
// absent -- matched whole, so a person whose real title happens to read that way
// is the only false positive, and losing a first name is the safe direction.
const FABRICATED_DEFAULT_TITLE = /^\s*marketing\s*\/\s*partnerships\s*$/i;

// Is the title itself evidence of a real job here?
function hasRoleTitle(title) {
  const t = String(title || '').trim();
  if (!t) return false;                          // absent -> never greet
  if (FABRICATED_DEFAULT_TITLE.test(t)) return false;
  if (NON_ROLE_TITLE.test(t)) return false;      // placeholder -> never greet, even if it says "owner"
  return ROLE_TITLE.test(t);
}

// The discovery prompt is allowed to INFER an address it never found -- "infer
// its standard general inbox (info@theirdomain.com) and lower the confidence" --
// and scores it on its own scale: 0.85 a real address on their site, 0.6 a real
// shared inbox, 0.4 an inferred format, 0.2 a guess. An inferred address is not a
// confirmed way to reach a named person, so it does not earn a first name.
const MIN_EMAIL_CONFIDENCE = 0.6;

// ── WHICH SOURCES ARE A PUBLISHED STATEMENT ABOUT WHO RUNS THIS BUSINESS ────
//
// The bar was "two sources agree, or the business's own site, or we hold their
// published address". That is a bar almost nothing local clears: the ladder
// finds Laura Pineo through a chamber listing, with a business line and a
// general inbox, and every one of those three tests fails -- so the pitch opened
// "Hi," to a card with her name printed on it.
//
// The bar is now PROVENANCE: did a source we recognise publish this person's
// name against this business. A chamber listing, a Facebook page, a state
// filing, a LinkedIn or Maps profile are all somebody publishing "this person
// runs this business". That is what an agent doing this by hand would rely on,
// and writing "Hi Laura," to info@ when the chamber says Laura owns the place is
// not a claim we cannot stand behind.
//
// THREE SOURCES ARE DELIBERATELY NOT ON THIS LIST, and each one is a wrong
// greeting that actually shipped:
//
//   news        an Adweek editor was named ONCE, in an article, as the "owner"
//               of a bakery. A story that mentions a business is not the
//               business telling us who runs it.
//   hunter      a paid domain lookup that matches an address to a person BY
//               SURNAME. It is a guess at how to reach someone, never evidence
//               that they work there. This is the fbf5865 regression.
//   instagram   a name read out of a bio. Already usually carries
//               affiliationScope 'unclear'; listed here so it cannot arrive by
//               another route.
//
// An unrecognised source is a model guess with no provenance, which is the one
// case the original bug was about, and it still gets "Hi,".
const GREETABLE_SOURCES = new Set(['site', 'chamber', 'facebook', 'registry', 'linkedin', 'maps']);

function _sourcesOf(c) {
  return Array.isArray(c.sources) && c.sources.length ? c.sources : (c.source ? [c.source] : []);
}

function greetableFromSource(c) {
  const CR = require('./contactRank');
  return _sourcesOf(c).some((s) => GREETABLE_SOURCES.has(CR.normalizeSource(s)));
}

// A source we RECOGNISE and have decided is not good enough to open a letter
// with, and nothing better named them as well. This is the refusal that has to
// outrank the published-address route below: David Griner's Adweek address is a
// real published address, and he still does not run the bakery.
function weakSourceOnly(c) {
  const CR = require('./contactRank');
  const known = _sourcesOf(c).map((s) => CR.normalizeSource(s)).filter((s) => s !== null);
  return known.length > 0 && !known.some((s) => GREETABLE_SOURCES.has(s));
}

// ── THE SECOND ROUTE, WHICH IS OLDER THAN THE FIRST AND STAYS ───────────────
//
// "We hold a published address for them" -- publishing the address is itself
// publishing the name. This is what carries a contact whose provenance we cannot
// read: a legacy row written before `sources` was populated, and every row on
// the AI Outreach path, whose source vocabulary does not overlap the fan-out's.
//
// Removing it in favour of the source list alone would have been a TIGHTENING
// dressed up as a loosening -- 29 assertions in greetguard.js are exactly this
// shape, a real role title and a published address with no source recorded.
//
// A Hunter-derived or pattern-guessed address is not this: emailKind says where
// the address came from, and only 'published' (or a legacy row with no kind at
// all) counts.
function hasPublishedAddress(c) {
  return !!c.email && (!c.emailKind || c.emailKind === 'published');
}

function greetableContacts(contacts) {
  return (Array.isArray(contacts) ? contacts : []).filter((c) => {
    if (!c || !c.name) return false;
    const CR = require('./contactRank');
    // The source told us it could not tie this person to this business. That is
    // the same claim the placeholder title makes, in a structured field.
    if (c.affiliationScope === 'unclear') return false;
    // ── THE TITLE STILL HAS TO MEAN A REAL JOB HERE ───────────────────────
    // Loosening the SOURCE bar does not loosen the TITLE bar. A placeholder
    // ("Company contact (not confirmed owner)"), a landlord, a former owner or a
    // registered agent is not somebody to open a letter to, whoever published it.
    if (CR.authorityOf(c.title).rank >= CR.RANK.PLACEHOLDER) return false;
    // A TITLE THAT HEDGES ITSELF. "Owner (per news report)" is a report about an
    // owner, not a statement by the business -- this is the half of the David
    // Griner case that survives independently of the source list, and it is kept
    // for exactly that reason.
    if (CR.hedgeOf(c.title) !== CR.HEDGE.NONE) return false;
    // ── A SOURCE WE RECOGNISE AND DO NOT TRUST FOR THIS ───────────────────
    // Checked BEFORE the positive tests, and that ordering is load-bearing: a
    // news mention or a Hunter surname match can arrive WITH a real published
    // address, and the address must not buy a first name that the source cannot
    // support. This is the half of the David Griner case that does not depend on
    // his title hedging itself.
    if (weakSourceOnly(c)) return false;
    // ── POSITIVE EVIDENCE, BY EITHER ROUTE ────────────────────────────────
    // Somebody we recognise published this name against this business, OR we
    // hold their published address. See GREETABLE_SOURCES and
    // hasPublishedAddress for what each of those means and does not mean.
    if (!greetableFromSource(c) && !hasPublishedAddress(c)) return false;
    // The model invented this contact rather than finding it. Kept as its own
    // line even though 'ai_inference' normalises to nothing and would already
    // fail the source test -- it is the original bug and it says so out loud.
    if (c.source === 'ai_inference') return false;
    if (c.confidence_score !== undefined && c.confidence_score !== null
        && Number(c.confidence_score) < MIN_EMAIL_CONFIDENCE) return false;
    return hasRoleTitle(c.title);
  });
}

// HOW TO ADDRESS THIS PERSON, for the prompt.
//
// pitchGeneration used `name.split(' ')[0]`, which for "Dr. Dawn Mercer" is "Dr." --
// so the prompt instructed the model, in words, to write `Greeting: "Dr.,"`. The
// model obeyed. Same rule as askName() in contactLadder.js: keep an honorific and
// pair it with the surname, otherwise use the first name.
function salutationName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length > 1 && isHonorificOnly(parts[0])) {
    const h = parts[0].replace(/\.?$/, '.');
    return h.charAt(0).toUpperCase() + h.slice(1) + ' ' + parts[parts.length - 1];
  }
  return parts[0];
}

module.exports = {
  enforceGreeting, enforceGreetingHtml, allowedGreetingNames, addresseeOf,
  greetableContacts, salutationName, isHonorificOnly, hasRoleTitle,
  GREETABLE_SOURCES, greetableFromSource, weakSourceOnly, hasPublishedAddress,
};
