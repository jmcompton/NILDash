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

// A contact is good enough to greet by name only when it carries BOTH a name and a
// personal email -- the same rule pitchGeneration already used to decide whether to
// put a name in the prompt. Stated once, here, so the prompt and the enforcement
// cannot drift apart.
function greetableContacts(contacts) {
  return (Array.isArray(contacts) ? contacts : []).filter((c) => c && c.name && c.email);
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

module.exports = { enforceGreeting, enforceGreetingHtml, allowedGreetingNames, addresseeOf, greetableContacts, salutationName, isHonorificOnly };
