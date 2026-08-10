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
  if (/@|https?:/.test(v)) return false;
  return true;
}
function _normPhone(p) {
  const d = String(p || '').replace(/[^\d]/g, '');
  if (d.length < 10 || d.length > 15) return null;
  return String(p).trim();
}

// Deterministic parse. Splits the page into staff blocks (table rows, staff list
// items, cards) and reads name / title / mailto / tel out of each.
function parseStaffHtml(html, pageUrl) {
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
  const seen = new Set();
  for (const b of blocks) {
    const email = ((b.match(/mailto:([^"'?>\s]+)/i) || [])[1] || '').trim().toLowerCase() || null;
    // Prefer the DISPLAYED number over the tel: href, which is usually bare digits.
    const telA = b.match(/<a[^>]*href=["']tel:([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const telRaw = telA ? (_text(telA[2]) || telA[1]) : (((b.match(/tel:([^"'?>\s]+)/i) || [])[1] || '').trim() || null);

    // Cell-based (tables) first, then generic inline elements for card markup.
    let parts = [...b.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => _text(m[1])).filter(Boolean);
    if (parts.length < 2) {
      parts = [...b.matchAll(/<(?:h[1-6]|a|span|p|div|strong)[^>]*>([\s\S]{0,300}?)<\/(?:h[1-6]|a|span|p|div|strong)>/gi)]
        .map((m) => _text(m[1])).filter(Boolean);
    }
    if (!parts.length) continue;

    const nameIdx = parts.findIndex(looksLikeName);
    if (nameIdx === -1) continue;
    const name = parts[nameIdx];
    // Title = the next distinct string that reads like a job title. A hinted match
    // wins, because "Head Coach" would otherwise be discarded for looking like a name.
    const after = parts.slice(nameIdx + 1).filter((p) => p !== name && looksLikeTitle(p));
    const title = after.find((p) => TITLE_HINT.test(p)) || after.find((p) => !looksLikeName(p)) || after[0] || null;

    const key = name.toLowerCase().replace(/[^a-z]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      name, title,
      email: (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ? email : null,
      phone: _normPhone(telRaw),
      sourceUrl: pageUrl || null,
    });
  }
  return out;
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
    const raw = await ai.oneShot(prompt, sys, 3000, ai.MODEL_FAST);
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
};
