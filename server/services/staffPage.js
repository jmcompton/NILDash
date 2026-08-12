'use strict';
// Football staff page fetch + parse.
//
// WHY THIS EXISTS. Searching for staff produced different answers on different runs:
// the same program came back Tier A off the school's own site one run and Tier C off
// a recruiting-site commits page the next. A database agents are meant to trust
// cannot be built on a non-deterministic lookup.
//
// Every FBS school publishes ONE football staff page at a stable URL. Fetching that
// page directly is deterministic (same page, same parse), complete (every staff
// member, not five roles), and cheap (one HTTP GET instead of seventeen searches).
// Everything on that page is football and current BY DEFINITION, so it is Tier A
// with no sport gate needed.
//
// The URL is discovered ONCE via search and then persisted in program_source. It is
// never searched for again. Search is reduced to filling roles the page does not
// list.
//
// Parsing is deterministic first: real athletics sites (nearly all Sidearm Sports)
// render staff as table rows or staff cards, and names, titles, mailto: and tel:
// links come straight out of the markup. A model extraction runs ONLY when the
// deterministic pass finds too little, and even then it reads a FIXED fetched page
// rather than a fresh search, so the same page yields the same answer.

const crypto = require('crypto');

const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 3_000_000;
const UA = 'Mozilla/5.0 (compatible; NILDashBot/1.0; +https://nildash.com)';

async function fetchStaffPage(url) {
  const t0 = Date.now();
  if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, reason: 'bad_url', ms: 0 };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, reason: 'http_' + resp.status, status: resp.status, ms: Date.now() - t0 };
    let html = await resp.text();
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
    // status is returned on success too: the URL sweep logs it per candidate, and a
    // 2xx that is not 200 is worth seeing rather than assuming.
    return { ok: true, html, status: resp.status, finalUrl: resp.url || url, bytes: html.length, ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, reason: (e && e.name === 'AbortError') ? 'timeout' : ('error_' + (e.message || 'fetch')), ms: Date.now() - t0 };
  }
}

function _decode(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"').replace(/&#8217;/g, "'").replace(/&[a-z]+;/gi, ' ');
}
function _text(html) { return _decode(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

// Words that mark a job title. Needed because a title like "Head Coach" is two
// capitalized words and therefore also looks like a person's name; without this the
// title column was being rejected as a duplicate name and every title came back null.
const TITLE_HINT = /coach|director|manager|coordinator|analyst|assistant|associate|officer|president|personnel|recruiting|operations|chief|executive|specialist|trainer|scout|nutrition|strength|equipment|video|creative|administrat/i;

// Does this look like a person's name rather than a column header or a label?
const NOT_A_NAME = /^(name|full name|title|position|position title|email|e-?mail|email address|phone|phone number|telephone|staff|coach(es)?|full bio|bio|directory|contact|contact info|office|department|sport|photo|image|view|more|back to top)$/i;
function looksLikeName(s) {
  const v = String(s || '').trim();
  if (!v || v.length < 4 || v.length > 60) return false;
  if (NOT_A_NAME.test(v)) return false;
  if (/\d|@|https?:/.test(v)) return false;
  // A row whose name field reads like a JOB TITLE is a parse failure, not a person:
  // Georgia rendered "Sr. Assistant Athletic Trainer: Football" into the name column.
  // Real names do not contain role words or title punctuation.
  if (TITLE_HINT.test(v)) return false;
  if (/[:;/|,]/.test(v)) return false;
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  // Mostly letters, and at least two capitalized words.
  const caps = words.filter((w) => /^[A-Z][A-Za-z'.\-]*$/.test(w)).length;
  return caps >= 2;
}
function looksLikeTitle(s) {
  const v = String(s || '').trim();
  if (!v || v.length < 3 || v.length > 120) return false;
  if (NOT_A_NAME.test(v)) return false;
  if (JUNK_TEXT.test(v)) return false;
  if (/@|https?:/.test(v)) return false;
  return true;
}

// Chrome that a link renderer wraps around a real name. Alabama's directory renders
// every person as "Full Bio for Greg Byrne", and storing that label as the name is
// what produced 381 rows with no titles and no roles. The name is in there; take it.
function stripNameLabel(s) {
  let v = String(s || '').trim();
  v = v.replace(/\(\s*opens? in a new (?:window|tab)\s*\)/gi, ' ');
  v = v.replace(/opens? in a new (?:window|tab)/gi, ' ');
  v = v.replace(/^\s*(?:full\s+bio|bio|profile|player\s+bio|view\s+profile|view\s+bio|read\s+more)\s+(?:for|about|on)\s+/i, '');
  v = v.replace(/^\s*(?:email|e-?mail|contact|call|phone|photo\s+of|picture\s+of|image\s+of)\s+/i, '');
  v = v.replace(/['’]s\s+(?:bio|profile|page)\s*$/i, '');
  v = v.replace(/\s*[-|]\s*(?:full\s+bio|bio|profile)\s*$/i, '');
  return v.replace(/\s+/g, ' ').trim();
}

// Carousel controls, nav chrome and link boilerplate. These parse as two capitalized
// words and would otherwise be stored as people: "All Rotators Playing" is a slider
// control on the Alabama page, not a member of staff.
const JUNK_TEXT = /^(?:all\s+rotators|rotators?\b|slide\s*\d|previous|next|play|pause|stop|skip\s+to|main\s+content|search|menu|toggle|loading|view\s+all|show\s+all|see\s+all|filter|sort\s+by|back\s+to|read\s+more|learn\s+more|sign\s+up|subscribe|follow\s+us|share|print|download|opens?\s+in)\b|opens?\s+in\s+a\s+new\s+(?:window|tab)|\bfull\s+bio\b|\ball\s+rotators\b/i;

// Department nouns. A short line built only of these is a SECTION HEADER, not a
// person: "Football Support Staff", "Sports Medicine", "Business Office".
const SECTION_WORD = /\b(football|basketball|baseball|softball|soccer|volleyball|tennis|golf|track|field|cross\s+country|swim(ming)?|diving|gymnastics|rowing|wrestling|medicine|nutrition|performance|operations|administration|office|services|department|marketing|communications|compliance|facilities|development|ticket(ing)?|academics?|equipment|video|creative|training|support|staff|personnel|recruiting|strength|conditioning|athletics?|business|human\s+resources|technology|events|hall\s+of\s+fame|leadership|coaches|sports)\b/i;

// Tidy a heading before it is stored or matched. Matching is case-insensitive
// already, so this is not about case: it strips the decoration that athletics sites
// hang off headings, such as "FOOTBALL OPERATIONS (12)" or "Football Staff:".
function normalizeSection(text) {
  return String(text || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*\d+\s*\)\s*$/, '')
    .replace(/^[\s\-|:,.]+|[\s\-|:,.]+$/g, '')
    .trim();
}

function looksLikeSectionHeader(text) {
  const v = normalizeSection(text);
  if (!v || v.length < 3 || v.length > 60) return false;
  if (/@|https?:|\d{3}/.test(v)) return false;
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;
  return SECTION_WORD.test(v);
}
function _normPhone(p) {
  const d = String(p || '').replace(/[^\d]/g, '');
  if (d.length < 10 || d.length > 15) return null;
  return String(p).trim();
}

// Find the true end of a nested element. A non-greedy `<div ...>[\s\S]*?</div>`
// stops at the FIRST closing tag, which for a Sidearm person card is the inner
// name wrapper. Everything after it, including the title and the mailto, is cut
// off, and the page parses as names with no titles. Maryland reported 334 names
// and 0 titles for exactly this reason.
const MAX_BLOCK_CHARS = 20000;
function _sliceBalanced(src, openStart, tag) {
  const token = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
  token.lastIndex = openStart;
  let depth = 0, m;
  while ((m = token.exec(src))) {
    if (m.index - openStart > MAX_BLOCK_CHARS) break; // malformed markup, do not run away
    if (m[0][1] === '/') {
      depth--;
      if (depth <= 0) return { start: openStart, end: m.index + m[0].length };
    } else depth++;
  }
  return null; // unclosed: skip rather than swallow the rest of the document
}

// Text lines from nested markup. Closing tags become line breaks, so a card whose
// name, title and email sit in sibling elements yields three clean parts instead of
// one run-on string. This is what makes a person card readable without knowing the
// site's exact class names, which vary between Sidearm themes.
function _textLines(html) {
  return _decode(String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|span|a|h[1-6]|td|th|tr|strong|em|label)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Read one staff block. Returns a person or null: null means "not a person", which
// the caller may then reinterpret as a section header.
function _personFromBlock(b, pageUrl) {
  const email = ((b.match(/mailto:([^"'?>\s]+)/i) || [])[1] || '').trim().toLowerCase() || null;
  // Prefer the DISPLAYED number over the tel: href, which is usually bare digits.
  const telA = b.match(/<a[^>]*href=["']tel:([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const telRaw = telA ? (_text(telA[2]) || telA[1]) : (((b.match(/tel:([^"'?>\s]+)/i) || [])[1] || '').trim() || null);

  // Cell-based (tables) first. Then LINE-based, which handles nested card markup
  // where an element-matching regex groups the name and title into one string.
  // The old inline-element pass is kept last, for blocks the line split flattens.
  let parts = [...b.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => _text(m[1])).filter(Boolean);
  if (parts.length < 2) {
    const lines = _textLines(b);
    if (lines.length >= 2) parts = lines;
  }
  if (parts.length < 2) {
    parts = [...b.matchAll(/<(?:h[1-6]|a|span|p|div|strong)[^>]*>([\s\S]{0,300}?)<\/(?:h[1-6]|a|span|p|div|strong)>/gi)]
      .map((m) => _text(m[1])).filter(Boolean);
  }
  if (!parts.length) return null;

  // Strip link chrome BEFORE testing, so "Full Bio for Greg Byrne" yields the person
  // rather than being discarded or stored as the label.
  let nameIdx = -1, name = null;
  for (let i = 0; i < parts.length; i++) {
    const cand = stripNameLabel(parts[i]);
    if (!cand || JUNK_TEXT.test(cand)) continue;
    if (looksLikeName(cand)) { nameIdx = i; name = cand; break; }
  }
  if (nameIdx === -1) return null;

  // Title = the next distinct string that reads like a job title. A hinted match
  // wins, because "Head Coach" would otherwise be discarded for looking like a name.
  const after = parts.slice(nameIdx + 1)
    .filter((p) => p !== name && stripNameLabel(p) !== name && looksLikeTitle(p));
  let title = after.find((p) => TITLE_HINT.test(p)) || after.find((p) => !looksLikeName(p)) || after[0] || null;

  // Last resort: some card themes put the title only in the link's accessible name,
  // as aria-label="James E. Smith - Head Football Coach". That is published markup,
  // not a guess, so it is worth reading before giving up on the title.
  if (!title) {
    for (const m of b.matchAll(/aria-label="([^"]{3,120})"/gi)) {
      const seg = m[1].split(/\s+[-|,]\s+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
      const cand = seg.find((s) => s !== name && TITLE_HINT.test(s) && looksLikeTitle(s));
      if (cand) { title = cand; break; }
    }
  }

  return {
    name, title: title || null,
    email: (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ? email : null,
    phone: _normPhone(telRaw),
    sourceUrl: pageUrl || null,
  };
}

// Deterministic parse. Walks the page IN DOCUMENT ORDER so that a section header
// applies to the rows beneath it: a department-wide directory lists football staff
// under "Football Support Staff" and the swim coach under "Swimming", and without
// order there is no way to tell them apart.
function parseStaffHtml(html, pageUrl) {
  const src = String(html || '');
  const clean = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  const blocks = [];
  const add = (m) => blocks.push({ start: m.index, end: m.index + m[0].length, html: m[0], kind: 'block' });
  for (const m of clean.matchAll(/<tr[\s\S]{0,6000}?<\/tr>/gi)) add(m);

  // li and div NEST, so their extent has to be found by counting depth rather than
  // by a non-greedy match. Nested openings inside a block already taken are skipped,
  // so one card yields one person rather than one per inner wrapper.
  const collectNested = (openRe, tag) => {
    const taken = [];
    for (const m of clean.matchAll(openRe)) {
      if (taken.some((t) => m.index >= t.start && m.index < t.end)) continue;
      const span = _sliceBalanced(clean, m.index, tag);
      if (!span) continue;
      taken.push(span);
      blocks.push({ start: span.start, end: span.end, html: clean.slice(span.start, span.end), kind: 'block' });
    }
  };
  collectNested(/<li[^>]*(?:staff|person|card|directory)[^>]*>/gi, 'li');
  // s-person-card is the Sidearm card root. person-card already matches it as a
  // substring, but naming it makes the intent findable when this needs revisiting.
  collectNested(/<div[^>]*(?:s-person-card|staff-member|staff_member|person-card|directory-item)[^>]*>/gi, 'div');

  // Headings that sit BETWEEN blocks are section headers. One inside a staff card is
  // that person's own markup and must not reset the section.
  const heads = [];
  const addHead = (m, text) => {
    const t = normalizeSection(text);
    if (looksLikeSectionHeader(t)) heads.push({ start: m.index, end: m.index + m[0].length, header: t, kind: 'header' });
  };
  for (const m of clean.matchAll(/<h[1-6][^>]*>([\s\S]{0,200}?)<\/h[1-6]>/gi)) addHead(m, _text(m[1]));
  for (const m of clean.matchAll(/<caption[^>]*>([\s\S]{0,200}?)<\/caption>/gi)) addHead(m, _text(m[1]));
  // Not every site uses a heading tag. Sidearm and its themes frequently render a
  // department label as a styled div or span whose class names it, and a football
  // section that is never DETECTED is indistinguishable from one that does not exist.
  for (const m of clean.matchAll(/<(?:div|p|span|td|th|button|a)[^>]*(?:class|id)=["'][^"']*(?:section|category|group|heading|header|department|sport-title|group-title)[^"']*["'][^>]*>([\s\S]{0,200}?)<\/(?:div|p|span|td|th|button|a)>/gi)) {
    addHead(m, _text(m[1]));
  }
  const inside = (i) => blocks.some((b) => i > b.start && i < b.end);
  const items = [...blocks, ...heads.filter((h) => !inside(h.start))].sort((a, b) => a.start - b.start);

  const out = [];
  const seen = new Set();
  const sectionsSeen = [];
  let section = null;
  let droppedJunk = 0;
  for (const it of items) {
    if (it.kind === 'header') {
      section = it.header;
      if (!sectionsSeen.includes(section)) sectionsSeen.push(section);
      continue;
    }
    const person = _personFromBlock(it.html, pageUrl);
    if (!person) {
      // A row that is not a person but reads like a department label IS the section
      // header. Auburn renders "Football Support Staff" as a table row, and the old
      // parser stored it as a nameless record instead of using it.
      const t = normalizeSection(_text(it.html));
      if (!/mailto:/i.test(it.html) && looksLikeSectionHeader(t)) {
        section = t;
        if (!sectionsSeen.includes(section)) sectionsSeen.push(section);
      } else if (t) droppedJunk++;
      continue;
    }
    const key = person.name.toLowerCase().replace(/[^a-z]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    person.section = section;
    out.push(person);
  }
  out._sections = sectionsSeen;
  out._droppedJunk = droppedJunk;
  return out;
}

// A department-wide directory is not a football staff page, but the football staff
// IS in it, under its own sections. Keep only rows under a football section, plus
// anyone whose own title names football regardless of where they sit.
const FOOTBALL_SECTION = /\bfootball\b/i;

function filterToFootballSections(staff) {
  const list = Array.isArray(staff) ? staff : [];
  // TWO different lists, and conflating them is how a page reports "no football
  // section" while its section list plainly shows Football. detected = every heading
  // found anywhere on the page, including a nav link or a filter button. withPeople =
  // headings that actually have staff rows beneath them. Only the second can be
  // filtered on, but the first is what a human reads in the log.
  const detected = Array.isArray(staff._sections) ? staff._sections : [];
  const sections = [...new Set(list.map((s) => s.section).filter(Boolean))];
  const footballSections = sections.filter((s) => FOOTBALL_SECTION.test(s));
  const footballDetected = detected.filter((s) => FOOTBALL_SECTION.test(s));
  // No sections at all, or none of them football: this is already a football page
  // (Florida, Georgia) and filtering it would be wrong.
  if (!sections.length || !footballSections.length) {
    return {
      staff: list, filtered: false, dropped: 0, sections, footballSections,
      detected, footballDetected,
      // The South Carolina case: a Football heading exists on the page but no parsed
      // row sits under it, so there is nothing to filter TO.
      footballHeadingWithNoRows: footballDetected.length > 0 && footballSections.length === 0,
    };
  }
  const kept = list.filter((s) =>
    (s.section && FOOTBALL_SECTION.test(s.section)) ||
    (s.title && FOOTBALL_SECTION.test(s.title)));
  // Never filter down to nothing. If the football sections turn out to be almost
  // empty, the section markup was misread and the unfiltered list is the safer answer.
  if (kept.length < 3) {
    return { staff: list, filtered: false, dropped: 0, sections, footballSections, detected, footballDetected, tooFew: kept.length };
  }
  return { staff: kept, filtered: true, dropped: list.length - kept.length, sections, footballSections, detected, footballDetected };
}

// QUALITY, NOT COUNT. "Biggest page wins" accepted Alabama's 381-row navigation dump
// over its real 19-row coaching staff. A page is only a football staff page if its
// rows carry titles, are not link chrome, and cover the roles that matter.
const MIN_TITLE_RATE = 0.60;   // at least 60% of rows have a non-empty title
const MAX_JUNK_RATE = 0.20;    // fewer than 20% of names are junk
const MIN_KEY_ROLES = 3;       // at least 3 of the 5 key roles present

// Why did the title column not come through? A page can parse 40 names with 0
// titles for several different reasons, and they need different fixes: the title
// may sit outside the block the name was found in, the block may hold only one
// cell, or the title may be in an attribute rather than text. Guessing between
// those wastes a change; this prints the raw markup of the first few blocks and the
// exact strings the parser pulled out of them, so the answer is readable.
function inspectRows(html, pageUrl, limit) {
  const src = String(html || '');
  const clean = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const blocks = [];
  for (const m of clean.matchAll(/<tr[\s\S]{0,6000}?<\/tr>/gi)) blocks.push(m[0]);
  for (const m of clean.matchAll(/<li[^>]*(?:staff|person|card|directory)[^>]*>[\s\S]{0,6000}?<\/li>/gi)) blocks.push(m[0]);
  for (const m of clean.matchAll(/<div[^>]*(?:staff-member|staff_member|person-card|directory-item)[^>]*>[\s\S]{0,6000}?<\/div>/gi)) blocks.push(m[0]);

  const out = [];
  for (const b of blocks.slice(0, limit || 3)) {
    const cells = [...b.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => _text(m[1]));
    const inline = [...b.matchAll(/<(?:h[1-6]|a|span|p|div|strong)[^>]*>([\s\S]{0,300}?)<\/(?:h[1-6]|a|span|p|div|strong)>/gi)]
      .map((m) => _text(m[1]));
    const parsed = _personFromBlock(b, pageUrl);
    out.push({
      rawHtml: b.replace(/\s+/g, ' ').slice(0, 700),
      cellCount: cells.length,
      cells: cells.filter(Boolean).slice(0, 10),
      inlineCount: inline.length,
      inline: inline.filter(Boolean).slice(0, 10),
      // Attribute values are where a missing title most often hides: title=, aria-label=,
      // data-title=. If the text has no title but an attribute does, that is the answer.
      attrs: (b.match(/(?:title|aria-label|data-title|alt)="([^"]{3,80})"/gi) || []).slice(0, 6),
      parsedName: parsed ? parsed.name : null,
      parsedTitle: parsed ? parsed.title : null,
    });
  }
  return { blocks: blocks.length, samples: out };
}

function scoreStaffPage(staff, keyRolePatterns) {
  const list = Array.isArray(staff) ? staff : [];
  const rows = list.length;
  const pct = (x) => `${Math.round(x * 100)}%`;
  if (!rows) {
    return { rows: 0, titleRate: 0, junkRate: 1, keyRoles: 0, accepted: false, reasons: ['no rows parsed'] };
  }
  const withTitle = list.filter((s) => s.title && String(s.title).trim()).length;
  const junk = list.filter((s) => {
    const n = String(s.name || '');
    return !n || JUNK_TEXT.test(n) || !looksLikeName(n);
  }).length;
  const titleRate = withTitle / rows;
  const junkRate = junk / rows;
  const pats = Array.isArray(keyRolePatterns) ? keyRolePatterns : [];
  const keyRoles = pats.filter((re) => list.some((s) => s.title && re.test(s.title))).length;

  const reasons = [];
  if (titleRate < MIN_TITLE_RATE) reasons.push(`only ${pct(titleRate)} of rows have a title, need ${pct(MIN_TITLE_RATE)}`);
  if (junkRate >= MAX_JUNK_RATE) reasons.push(`${pct(junkRate)} of names are junk, must be under ${pct(MAX_JUNK_RATE)}`);
  if (pats.length && keyRoles < MIN_KEY_ROLES) reasons.push(`only ${keyRoles} of ${pats.length} key roles present, need ${MIN_KEY_ROLES}`);
  return { rows, titleRate, junkRate, keyRoles, accepted: reasons.length === 0, reasons };
}

// Model fallback, used ONLY when the deterministic pass is too thin. It reads the
// FETCHED page text, not a fresh search, so the input is fixed and the output is
// stable for a given page. Never invents: the instruction is extraction only.
async function extractStaffWithModel(html, pageUrl, ai) {
  const text = _text(html).slice(0, 40000);
  if (!text) return [];
  const sys = 'You extract a staff list from the text of ONE web page. Output ONLY JSON. Copy names and titles exactly as they appear. Never invent a person, a title, an email, or a phone number, and never construct an email address.';
  const prompt = `This is the text of the football staff page at ${pageUrl}. Extract EVERY staff member listed.
Respond with ONLY: {"staff":[{"name":"","title":"","email":null,"phone":null}]}
Rules:
- Copy the name and title exactly as printed. Include every person, not just senior ones.
- email and phone ONLY if printed on this page for that person, else null. Never build an address from a name.
- Skip navigation, headers, and anything that is not a person.

PAGE TEXT:
${text}`;
  try {
    // Capped for the same reason discoverStaffUrl is: oneShot retries up to four
    // times and each attempt inherits the SDK's ten-minute default, so an unbounded
    // call here can stall a bulk run just as surely as a hung search.
    const call = ai.oneShot(prompt, sys, 3000, ai.MODEL_FAST);
    const raw = ai.withTimeout
      ? await ai.withTimeout(call, MODEL_EXTRACT_TIMEOUT_MS, `staff extraction for ${pageUrl}`)
      : await call;
    const s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return [];
    const o = JSON.parse(s.slice(a, b + 1));
    const list = Array.isArray(o.staff) ? o.staff : [];
    return list.map((p) => ({
      name: String((p && p.name) || '').trim(),
      title: p && p.title ? String(p.title).trim() : null,
      email: (p && p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(p.email).trim())) ? String(p.email).trim().toLowerCase() : null,
      phone: _normPhone(p && p.phone),
      sourceUrl: pageUrl || null,
    })).filter((p) => p.name);
  } catch (e) {
    console.warn('[staffPage] model extraction failed:', e.message);
    return [];
  }
}

const MIN_DETERMINISTIC = 5; // below this the page probably did not parse structurally
const MODEL_EXTRACT_TIMEOUT_MS = 30000; // hard cap on the model fallback

// Fetch + parse one staff page. Returns { ok, staff, via, ms, hash }.
async function loadStaff(url, ai) {
  const got = await fetchStaffPage(url);
  if (!got.ok) {
    console.warn(`[staffPage] fetch FAILED ${url} reason=${got.reason} ms=${got.ms}`);
    return { ok: false, reason: got.reason, staff: [], via: 'none', ms: got.ms };
  }
  let staff = parseStaffHtml(got.html, got.finalUrl);
  let via = 'parser';
  if (staff.length < MIN_DETERMINISTIC && ai) {
    const modelStaff = await extractStaffWithModel(got.html, got.finalUrl, ai);
    if (modelStaff.length > staff.length) { staff = modelStaff; via = 'model'; }
  }
  // A department-wide directory gets cut to its football sections here, so every
  // caller sees football staff and nothing else.
  const sections = Array.isArray(staff._sections) ? staff._sections : [];
  const filt = filterToFootballSections(staff);
  staff = filt.staff;
  if (filt.filtered) {
    console.log(`[staffPage] ${got.finalUrl} DEPARTMENT-WIDE page cut to football sections ` +
      `[${filt.footballSections.join(', ')}], dropped ${filt.dropped} of ${filt.dropped + staff.length} rows`);
  } else if (filt.tooFew != null) {
    console.warn(`[staffPage] ${got.finalUrl} football sections matched only ${filt.tooFew} rows, keeping the full list instead`);
  } else if (staff.length > 40) {
    // A big page that was NOT filtered has several possible causes that look
    // identical in a row count, so print the evidence IN FULL and never truncate it:
    // a truncated list cannot answer the question it exists to answer. The two
    // section lists are reported separately, because a heading with no rows under it
    // is a different problem from a heading that does not exist.
    const withRows = filt.sections || [];
    if (filt.footballHeadingWithNoRows) {
      console.warn(`[staffPage] ${got.finalUrl} NOT FILTERED: a football heading EXISTS on this page ` +
        `[${filt.footballDetected.join(', ')}] but no parsed staff row sits under it, so there is nothing to filter to. ` +
        `That heading is probably navigation rather than a section label.`);
      console.warn(`  headings detected on the page (${filt.detected.length}):`);
      for (const s of filt.detected) console.warn(`    detected: ${s}`);
      console.warn(`  headings that actually have staff under them (${withRows.length}):`);
      for (const s of withRows) console.warn(`    with rows: ${s}`);
    } else if (!withRows.length) {
      console.warn(`[staffPage] ${got.finalUrl} NOT FILTERED: ${staff.length} rows and NO section headings have staff under them. ` +
        `If this page is department-wide, its headings use markup the parser does not recognise.`);
      if (filt.detected && filt.detected.length) {
        console.warn(`  ${filt.detected.length} heading(s) were detected but none had rows beneath them:`);
        for (const s of filt.detected) console.warn(`    detected: ${s}`);
      }
    } else {
      console.warn(`[staffPage] ${got.finalUrl} NOT FILTERED: ${withRows.length} section(s) have staff under them, none naming football. Full list:`);
      for (const s of withRows) console.warn(`    with rows: ${s}`);
    }
  }
  const hash = hashStaff(staff);
  if (got.finalUrl && got.finalUrl !== url) {
    console.log(`[staffPage] REDIRECT ${url} -> ${got.finalUrl} (the resolved URL is what gets persisted)`);
  }
  console.log(`[staffPage] ${url} bytes=${got.bytes} staff=${staff.length} via=${via} withEmail=${staff.filter((s) => s.email).length} withPhone=${staff.filter((s) => s.phone).length} ms=${got.ms} hash=${hash.slice(0, 8)}`);
  return { ok: true, staff, via, ms: got.ms, hash, finalUrl: got.finalUrl };
}

// South Carolina's directory slug is /staff-directory/football-803-777-4271/ : the
// football office number is literally in the URL. Sidearm builds these slugs from the
// directory title, so any school that titles the section with its phone number gets a
// real, free phone line out of it. Returns a formatted number or null.
function phoneFromUrl(url) {
  const path = (() => { try { return new URL(String(url)).pathname; } catch (_) { return String(url || ''); } })();
  // Look for 10 digits split by hyphens, not part of a longer digit run (a year or id).
  const m = path.match(/(?:^|[^\d])(\d{3})-(\d{3})-(\d{4})(?:[^\d]|$)/);
  if (!m) return null;
  const area = m[1];
  if (area[0] === '0' || area[0] === '1') return null; // not a valid US area code
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Diagnostic: what is ACTUALLY in this page? Answers the questions that decide
// whether a thin parse is pagination, lazy loading, or a parser miss, without
// guessing. Reports counts only; it never changes behavior.
function inspectHtml(html, url) {
  const src = String(html || '');
  const clean = src.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const count = (re) => (src.match(re) || []).length;
  const scripts = [...src.matchAll(/<script[\s\S]*?<\/script>/gi)].map((m) => m[0]);
  return {
    url,
    bytes: src.length,
    textBytes: _text(clean).length,
    trBlocks: (clean.match(/<tr[\s\S]{0,6000}?<\/tr>/gi) || []).length,
    staffLi: (clean.match(/<li[^>]*(?:staff|person|card|directory)[^>]*>/gi) || []).length,
    staffDiv: (clean.match(/<div[^>]*(?:staff-member|staff_member|person-card|directory-item)[^>]*>/gi) || []).length,
    mailto: count(/mailto:/gi),
    tel: count(/tel:/gi),
    // Phone-shaped text anywhere on the page, even without a tel: link. If this is
    // high while tel is 0, the numbers are plain text and the parser must read text.
    phoneLikeText: (_text(clean).match(/\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/g) || []).length,
    // Pagination / lazy-load signals.
    pagination: {
      pageParam: /[?&]page=/i.test(src),
      paginationMarkup: /pagination|paginate|page-numbers|data-page=/i.test(src),
      loadMore: /load[ _-]?more|show[ _-]?more|view[ _-]?all/i.test(_text(clean)),
      // rel=next is the clean signal, but most athletics paginators just style a
      // link with class="next" or label it "Next". Miss those and a paginated page
      // reads as a parser problem, which is exactly the wrong conclusion.
      nextLink: /rel=["']next["']|class=["'][^"']*\bnext\b[^"']*["']|>\s*next\s*(?:page)?\s*(?:&[a-z]+;|»|>)?\s*</i.test(src),
    },
    // Client-rendered signals: little text but lots of script, or a data blob.
    clientRendered: {
      scriptTags: scripts.length,
      scriptBytes: scripts.reduce((n, x) => n + x.length, 0),
      nextData: /__NEXT_DATA__/.test(src),
      ldJson: /application\/ld\+json/i.test(src),
      inlineStaffJson: /"staff"\s*:|"members"\s*:|"personnel"\s*:/i.test(src),
      sidearmApi: /services\/adaptive_components|sidearm.*\.json|\/api\//i.test(src),
    },
    phoneInUrlSlug: phoneFromUrl(url),
    // First contexts, so a human can see the actual markup shape.
    // Bounded, not fixed: a match near the top of the file has fewer than 80 leading
    // chars, and a fixed .{80} would silently report nothing at all there.
    sampleMailto: (src.match(/.{0,80}mailto:[^"'\s>]+.{0,40}/i) || [''])[0].replace(/\s+/g, ' ').trim(),
    sampleTel: (src.match(/.{0,80}tel:[^"'\s>]+.{0,40}/i) || [''])[0].replace(/\s+/g, ' ').trim(),
    samplePhoneText: (_text(clean).match(/.{0,60}\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}.{0,30}/) || [''])[0].trim(),
  };
}

function hashStaff(staff) {
  const norm = (staff || []).map((s) => `${(s.name || '').toLowerCase()}|${(s.title || '').toLowerCase()}`).sort().join('\n');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

// The staff-change alert. Diffing two parses of the same page is what turns this
// from a static table into a feed of who arrived, who left, and who was promoted.
function diffStaff(oldStaff, newStaff) {
  const key = (s) => (s.name || '').toLowerCase().replace(/[^a-z]/g, '');
  const oldBy = new Map((oldStaff || []).map((s) => [key(s), s]));
  const newBy = new Map((newStaff || []).map((s) => [key(s), s]));
  const added = [], removed = [], changed = [];
  for (const [k, s] of newBy) if (!oldBy.has(k)) added.push(s);
  for (const [k, s] of oldBy) if (!newBy.has(k)) removed.push(s);
  for (const [k, s] of newBy) {
    const o = oldBy.get(k);
    if (o && (o.title || '') !== (s.title || '')) changed.push({ name: s.name, from: o.title, to: s.title });
  }
  return { added, removed, changed };
}

module.exports = {
  fetchStaffPage, parseStaffHtml, extractStaffWithModel, loadStaff, hashStaff, diffStaff,
  looksLikeName, looksLikeTitle, TITLE_HINT, phoneFromUrl, inspectHtml,
  stripNameLabel, looksLikeSectionHeader, normalizeSection, filterToFootballSections, scoreStaffPage, inspectRows,
  JUNK_TEXT, FOOTBALL_SECTION, MIN_TITLE_RATE, MAX_JUNK_RATE, MIN_KEY_ROLES,
};
