'use strict';
// ── A ROSTER CSV, READ INTO ROWS THE ATHLETE FORM WOULD ACCEPT ───────────────
//
// Parsing only. No database, no network, no decisions about which agent this
// is for. scripts/import-roster.js drives it from the command line today; a CSV
// upload button can call parseRoster() with the file's text and get the same
// rows, the same notes and the same skip reasons.
//
// THE FILE IS WHAT AN AGENT KEEPS IN A SPREADSHEET, not what a form validates.
// Every cell here has been seen in a real roster: "15,000+" for a count, two
// handles or two counts in one cell joined by "/", a handle typed without its
// "@" or with a space in it, "Hockey" for ice hockey, "Basketball and Softball"
// for an athlete who plays both. Each of those has one rule below, and a row
// that needed one records a note saying what was done to it, so the dry run
// can show the agent rather than silently pick.

// ── CSV ──────────────────────────────────────────────────────────────────────
// Quoted fields, commas and newlines inside quotes, doubled quotes, CRLF, a
// UTF-8 byte order mark, and a trailing newline. Nothing else; a roster is not
// a spreadsheet export from the far end of the spec.
function parseCsv(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // A blank line is not a row.
  return rows.filter((r) => r.some((f) => String(f).trim() !== ''));
}

// ── COLUMNS ──────────────────────────────────────────────────────────────────
// The header is matched loosely, so "School/Affiliation", "School" and "Team"
// all land in the same place. A column the file does not have is simply
// absent; only first, last and sport are required.
const COLUMNS = {
  first:           [/^first(\s*name)?$/i],
  last:            [/^last(\s*name)?$/i],
  name:            [/^(full\s*)?name$/i, /^athlete$/i],
  sport:           [/^sports?$/i],
  affiliation:     [/school|affiliation|team|university|college|program/i],
  city:            [/^(home\s*)?city$/i, /^market$/i, /^city\s*,?\s*(state|st)$/i],
  total:           [/^total/i],
  instagramHandle: [/^(ig|insta|instagram)\s*(handle|user(name)?|@)?$/i],
  instagram:       [/^(ig|insta|instagram)\s*(followers?|count)$/i],
  tiktokHandle:    [/^(tt|tiktok)\s*(handle|user(name)?|@)?$/i],
  tiktok:          [/^(tt|tiktok)\s*(followers?|count)$/i],
  position:        [/^pos(ition)?$/i],
  year:            [/^(class|year|eligibility)$/i],
  email:           [/^e-?mail$/i],
};
function mapHeader(cells) {
  const map = {};
  cells.forEach((raw, idx) => {
    const h = String(raw || '').trim();
    if (!h) return;
    for (const [key, res] of Object.entries(COLUMNS)) {
      if (map[key] !== undefined) continue;
      if (res.some((re) => re.test(h))) { map[key] = idx; return; }
    }
  });
  return map;
}

// ── CELLS ────────────────────────────────────────────────────────────────────
// "15,000+" is fifteen thousand and the plus is the agent rounding down. "1.2k"
// and "1.2M" are read too, because the same agent's next file will have them.
function parseCount(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^~?\+?\$?([\d][\d,]*(?:\.\d+)?)\s*([km])?\+?$/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (m[2] === 'k') n *= 1000;
  if (m[2] === 'm') n *= 1000000;
  n = Math.round(n);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "a/b" is two values; the first is the primary. A "/" inside an actual handle
// does not occur -- Instagram and TikTok do not allow it -- so the split is safe.
function splitPair(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return [];
  return s.split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
}

// A handle is the account name: no "@", no URL, no spaces (the platform does
// not allow them, so a space is a typo and is removed), lower case, and only
// the characters the platforms accept. A bare number is a count that landed in
// the wrong column, not a handle.
function cleanHandle(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return { handle: null, note: null };
  const original = s;
  s = s.replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\/@?/i, '').replace(/[/?#].*$/, '');
  s = s.replace(/^@+/, '');
  if (/^\d[\d,.]*\+?$/.test(s)) return { handle: null, note: `"${original}" is a number, not a handle` };
  const hadSpace = /\s/.test(s);
  s = s.replace(/\s+/g, '');
  s = s.toLowerCase();
  const bad = /[^a-z0-9._]/.test(s);
  s = s.replace(/[^a-z0-9._]/g, '');
  if (!s) return { handle: null, note: `"${original}" is not a handle` };
  const notes = [];
  if (!/^@/.test(original.trim()) && !/^https?:/i.test(original.trim())) notes.push('added @');
  if (hadSpace) notes.push('removed a space');
  if (bad) notes.push('dropped characters the platform does not allow');
  return { handle: s, note: notes.length ? `${original} -> @${s} (${notes.join(', ')})` : null };
}

// ── SPORT ────────────────────────────────────────────────────────────────────
// The values the Add Client form's sport select uses, so an imported athlete
// looks exactly like one typed in. Variations map onto them; "Hockey" and
// "Ice hockey" are one sport; the first of "Basketball and Softball" is taken
// and the second is kept as a note the dry run prints.
const SPORT_VALUES = [
  'baseball', 'basketball', 'cheer', 'cross country', 'dance', 'field hockey', 'football', 'golf',
  'gymnastics', 'ice hockey', 'lacrosse', 'mens golf', 'mens ice hockey', 'rowing', 'skiing', 'soccer',
  'softball', 'swimming', 'tennis', 'track', 'triathlon', 'volleyball', 'water polo', 'womens basketball',
  'womens golf', 'womens ice hockey', 'womens soccer', 'wrestling',
];
const SPORT_ALIASES = {
  'hockey': 'ice hockey', 'ice hockey': 'ice hockey', 'puck': 'ice hockey',
  "men's hockey": 'mens ice hockey', "men's ice hockey": 'mens ice hockey', 'mens hockey': 'mens ice hockey',
  "women's hockey": 'womens ice hockey', "women's ice hockey": 'womens ice hockey', 'womens hockey': 'womens ice hockey',
  'field hockey': 'field hockey',
  "men's basketball": 'basketball', 'mens basketball': 'basketball', 'mbb': 'basketball', 'hoops': 'basketball', 'bball': 'basketball',
  "women's basketball": 'womens basketball', 'womens basketball': 'womens basketball', 'wbb': 'womens basketball',
  "men's golf": 'mens golf', 'mens golf': 'mens golf', "women's golf": 'womens golf', 'womens golf': 'womens golf',
  "men's soccer": 'soccer', 'mens soccer': 'soccer', "women's soccer": 'womens soccer', 'womens soccer': 'womens soccer', 'futbol': 'soccer',
  'track and field': 'track', 'track & field': 'track', 'track': 'track', 'xc': 'cross country', 'cross-country': 'cross country',
  'swim': 'swimming', 'swimming and diving': 'swimming', 'swimming & diving': 'swimming', 'diving': 'swimming',
  'cheerleading': 'cheer', 'gym': 'gymnastics', 'lax': 'lacrosse', "men's lacrosse": 'lacrosse', "women's lacrosse": 'lacrosse',
  'crew': 'rowing', 'american football': 'football', 'water polo': 'water polo', 'waterpolo': 'water polo',
  'ski': 'skiing', 'alpine skiing': 'skiing', 'nordic skiing': 'skiing', 'alpine': 'skiing', 'nordic': 'skiing', 'snowboarding': 'skiing',
  'tri': 'triathlon', 'ironman': 'triathlon', 'dance team': 'dance', 'dancer': 'dance', 'ballet': 'dance',
  'fastpitch': 'softball', "women's volleyball": 'volleyball', 'womens volleyball': 'volleyball', "men's volleyball": 'volleyball', 'beach volleyball': 'volleyball',
};
function _sportKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
}
// One sport string (no "and" in it) -> a form value or null.
function _oneSport(raw) {
  const key = _sportKey(raw);
  if (!key) return null;
  if (SPORT_ALIASES[key]) return SPORT_ALIASES[key];
  if (SPORT_VALUES.includes(key)) return key;
  // "womens" typed with the apostrophe, or "Ice Hockey (D1)".
  const bare = key.replace(/'/g, '').replace(/\s*\(.*\)\s*$/, '').trim();
  if (SPORT_ALIASES[bare]) return SPORT_ALIASES[bare];
  if (SPORT_VALUES.includes(bare)) return bare;
  // A longer phrase containing exactly one known sport word: "D1 Softball".
  const hits = SPORT_VALUES.filter((v) => new RegExp('\\b' + v.replace(/ /g, '\\s+') + '\\b').test(bare));
  if (hits.length === 1) return hits[0];
  const alias = Object.keys(SPORT_ALIASES).filter((k) => new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(bare));
  if (alias.length) return SPORT_ALIASES[alias.sort((a, b) => b.length - a.length)[0]];
  return null;
}
// A cell can name two sports: "Basketball and Softball", "Soccer/Track",
// "Golf, Tennis". The first is the athlete's sport here; the second is noted.
function normalizeSport(raw) {
  const s = String(raw || '').trim();
  if (!s) return { sport: null, secondSport: null, note: 'no sport' };
  const parts = s.split(/\s*(?:\band\b|&|\/|,|\+)\s*/i).map((x) => x.trim()).filter(Boolean);
  const first = _oneSport(parts[0]);
  if (!first) return { sport: null, secondSport: null, note: `"${s}" is not a sport the form knows` };
  const second = parts.length > 1 ? (_oneSport(parts.slice(1).join(' ')) || parts.slice(1).join(' ')) : null;
  const notes = [];
  if (_sportKey(parts[0]) !== first) notes.push(`"${parts[0]}" read as ${first}`);
  if (second) notes.push(`plays ${second} too; ${first} is the sport on the record`);
  return { sport: first, secondSport: second, note: notes.length ? notes.join('; ') : null };
}

// ── THE AFFILIATION ──────────────────────────────────────────────────────────
// Three kinds of thing land in the School/Affiliation column: a school, a pro
// team, or a description that is neither ("Professional Golfer", "Team USA",
// "PEAK Recovery"). A school gives the local lane a town by the school's
// geocode; a team gives one through the pro lookup; the third kind gives
// nothing and must not be guessed -- the caller supplies a city or skips.
//
// This only says what the text LOOKS like. Whether a school resolves, or a
// team's city is found, is the importer's job, because both need a lookup.
const SCHOOL_RE = /\b(university|college|state|academy|institute|polytechnic|school|tech|community|seminary|a&m|a & m|umaine|umass|uconn|ucla|usc|unc|lsu|byu|tcu|smu|vcu|unlv|utep|utsa|uab|ucf|usf|fiu|fau)\b|\bu\.?\s*(of|at)\b|^u[a-z]{1,6}(\s|$)|\b[a-z]+ u$/i;
const NOT_A_TEAM_RE = /\b(professional|pro|golfer|tennis player|boxer|fighter|skater|surfer|climber|runner|swimmer|gymnast|wrestler|rider|driver|team usa|usa (?:team|hockey|basketball|soccer|swimming|gymnastics|track)|national team|olympi[ac]n?s?|paralympi[ac]n?s?|free agent|unaffiliated|unattached|independent|self[- ]?represented|recovery|training|performance|fitness|gym|academy of|influencer|creator|retired|n\/?a|none|tbd|unknown)\b/i;
function classifyAffiliation(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'none';
  if (SCHOOL_RE.test(s)) return 'school';
  if (NOT_A_TEAM_RE.test(s)) return 'none';
  // "FC", "SC", "United", "City" and a city + nickname all read as a team; so
  // does anything else that is not obviously a description. The pro lookup
  // decides whether it is real.
  return 'team';
}

// ── --cities "First Last=City, ST; First Last=City, ST" ──────────────────────
// Also accepts a JSON object {"First Last": "City, ST"}.
function parseCities(raw) {
  const s = String(raw || '').trim();
  const out = {};
  if (!s) return out;
  if (s[0] === '{') {
    try { const o = JSON.parse(s); for (const [k, v] of Object.entries(o)) if (v) out[nameKey(k)] = String(v).trim(); return out; } catch (_) { /* fall through */ }
  }
  for (const part of s.split(/\s*;\s*/)) {
    const m = part.match(/^([^=:]+?)\s*[=:]\s*(.+)$/);
    if (m) out[nameKey(m[1])] = m[2].trim();
  }
  return out;
}

// One key for "Cooper Farrall", "cooper  farrall", "Farrall, Cooper" is not
// attempted: the roster and the account both hold "First Last" order.
function nameKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[’'`.\-]/g, '').replace(/\s+/g, ' ');
}
function sameName(a, b) { return !!nameKey(a) && nameKey(a) === nameKey(b); }

// ── THE ROWS ─────────────────────────────────────────────────────────────────
// parseRoster(text, { cities }) -> { columns, rows }
// Each row: what the record would hold, plus `notes` (what was cleaned) and
// `problems` (why it cannot be created from the file alone). A row with a
// problem is still returned, so the dry run can list it with the reason.
function parseRoster(text, opts = {}) {
  return parseTable(parseCsv(text), opts);
}

// The importable fields, for a column-mapping step: key, what to call it,
// and whether a file must have it. Order is display order.
const FIELDS = [
  { key: 'first', label: 'First name', required: 'name' },
  { key: 'last', label: 'Last name', required: 'name' },
  { key: 'name', label: 'Full name (instead of first + last)', required: 'name' },
  { key: 'sport', label: 'Sport', required: true },
  { key: 'affiliation', label: 'School / team', required: false },
  { key: 'city', label: 'City (for a pro or an athlete with no school)', required: false },
  { key: 'instagramHandle', label: 'Instagram handle', required: false },
  { key: 'instagram', label: 'Instagram followers', required: false },
  { key: 'tiktokHandle', label: 'TikTok handle', required: false },
  { key: 'tiktok', label: 'TikTok followers', required: false },
  { key: 'total', label: 'Total followers', required: false },
  { key: 'position', label: 'Position', required: false },
  { key: 'year', label: 'Class year', required: false },
  { key: 'email', label: 'Email', required: false },
];

// A blank file with the headers the importer reads best, plus one example row.
function templateCsv() {
  const head = ['First', 'Last', 'Sport', 'School/Affiliation', 'City', 'Total followers', 'Instagram handle', 'Instagram followers', 'TikTok handle', 'TikTok followers'];
  const ex = ['Jordan', 'Reyes', 'Basketball', 'Samford University', '', '12,400', '@jordanreyes', '9,800', '@jordan.reyes', '2,600'];
  const ex2 = ['Taylor', 'Kim', 'Golf', 'Professional Golfer', 'Scottsdale, AZ', '4,100', 'taylorkimgolf', '4,100', '', ''];
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  return head.join(',') + '\n' + ex.map(q).join(',') + '\n' + ex2.map(q).join(',') + '\n';
}

// A table (header row first) -> rows. opts.columns replaces the auto-match
// when the agent corrected it; opts.overrides is { [line]: { first, last,
// sport, affiliation, city } } for cells fixed in a preview, applied before
// any rule runs so a fixed row is read exactly as a typed one would be.
function parseTable(table, opts = {}) {
  const cities = opts.cities || {};
  const overrides = opts.overrides || {};
  if (!table || !table.length) return { columns: {}, rows: [] };
  const columns = opts.columns && Object.keys(opts.columns).length ? opts.columns : mapHeader(table[0]);
  const cellRaw = (r, key) => (columns[key] === undefined || columns[key] === null || columns[key] === '' ? '' : String(r[columns[key]] === undefined ? '' : r[columns[key]]).trim());
  const rows = [];
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const ov = overrides[i + 1] || overrides[String(i + 1)] || {};
    const cell = (rw, key) => (ov[key] !== undefined && ov[key] !== null ? String(ov[key]).trim() : cellRaw(rw, key));
    const notes = [], problems = [];
    let first = cell(r, 'first'), last = cell(r, 'last');
    if (!first && !last && cell(r, 'name')) {
      const parts = cell(r, 'name').split(/\s+/);
      first = parts.shift(); last = parts.join(' ');
    }
    first = first.replace(/\s+/g, ' '); last = last.replace(/\s+/g, ' ');
    if (ov.first !== undefined || ov.last !== undefined || ov.sport !== undefined || ov.affiliation !== undefined || ov.city !== undefined) notes.push('edited in the preview');
    const name = [first, last].filter(Boolean).join(' ');
    if (!first || !last) problems.push('needs a first and a last name');

    const sp = normalizeSport(cell(r, 'sport'));
    if (!sp.sport) problems.push(sp.note); else if (sp.note) notes.push(sp.note);

    const affiliation = cell(r, 'affiliation').replace(/\s+/g, ' ');
    const kind = classifyAffiliation(affiliation);

    const igH = splitPair(cell(r, 'instagramHandle')).map(cleanHandle);
    const igN = splitPair(cell(r, 'instagram')).map(parseCount);
    const ttH = splitPair(cell(r, 'tiktokHandle')).map(cleanHandle);
    const ttN = splitPair(cell(r, 'tiktok')).map(parseCount);
    for (const h of [...igH, ...ttH]) if (h.note) notes.push(h.note);
    if (igH.length > 1) notes.push(`second Instagram @${igH[1].handle || '?'} kept as an alternate`);
    if (ttH.length > 1) notes.push(`second TikTok @${ttH[1].handle || '?'} kept as an alternate`);
    if (igN.length > 1) notes.push(`Instagram count ${igN[0] || '?'} is the primary; ${igN[1] || '?'} kept as the alternate's`);
    if (ttN.length > 1) notes.push(`TikTok count ${ttN[0] || '?'} is the primary; ${ttN[1] || '?'} kept as the alternate's`);
    const rawIg = cell(r, 'instagram'), rawTt = cell(r, 'tiktok');
    if (rawIg && igN[0] === null) notes.push(`Instagram count "${rawIg}" is not a number and was left blank`);
    if (rawTt && ttN[0] === null) notes.push(`TikTok count "${rawTt}" is not a number and was left blank`);

    const total = parseCount(cell(r, 'total'));
    const cityCell = cell(r, 'city');
    const city = cityCell || cities[nameKey(name)] || '';
    if (cityCell) notes.push(`city from the file: ${cityCell}`);
    else if (city) notes.push(`city from --cities: ${city}`);

    rows.push({
      line: i + 1, first, last, name,
      sport: sp.sport, sportRaw: cell(r, 'sport'), secondSport: sp.secondSport,
      affiliation, affiliationKind: kind, city,
      position: cell(r, 'position'), year: cell(r, 'year'), email: cell(r, 'email'),
      totalFollowers: total,
      instagramHandle: (igH[0] && igH[0].handle) || '',
      instagramHandleAlt: (igH[1] && igH[1].handle) || '',
      instagram: igN[0] || 0, instagramAlt: igN[1] || 0,
      tiktokHandle: (ttH[0] && ttH[0].handle) || '',
      tiktokHandleAlt: (ttH[1] && ttH[1].handle) || '',
      tiktok: ttN[0] || 0, tiktokAlt: ttN[1] || 0,
      notes, problems,
    });
  }
  return { columns, rows };
}

const today = () => new Date().toISOString().slice(0, 10);

// ── WHERE THE LOCAL LANE WOULD WORK ─────────────────────────────────────────
// Decides college / pro / skip for one parsed row. `ai` and `lookup` are
// injected so the test can run this without the network.
async function placeRow(row, ctx) {
  const out = { ...row, athleteType: null, school: '', team: '', market: null, marketNote: null, lookup: null, skip: null };
  if (row.problems.length) { out.skip = row.problems.join('; '); return out; }
  if (ctx.existing.some((n) => sameName(n, row.name))) { out.skip = `already on the roster as "${ctx.existingName(row.name)}"`; return out; }

  const kind = row.affiliationKind;
  if (kind === 'school') {
    out.athleteType = 'college'; out.school = row.affiliation;
    const loc = ctx.schoolLocation ? ctx.schoolLocation(row.affiliation) : null;
    if (loc && loc.city) { out.market = `${loc.city}, ${loc.state || ''}`.replace(/, $/, ''); out.marketNote = 'school on file'; }
    else { out.market = null; out.marketNote = 'school not in the map; geocoded to its town on the first run'; }
    if (row.city) out.notes.push('city ignored: a college athlete\'s market is the school\'s town');
    return out;
  }

  // A pro, placed by a city we were given, or by the lookup.
  if (row.city) {
    out.athleteType = 'pro'; out.team = kind === 'team' ? row.affiliation : '';
    out.market = row.city; out.marketNote = 'city as given';
    if (kind === 'none' && row.affiliation) out.notes.push(`"${row.affiliation}" kept in notes; no team`);
    return out;
  }
  if (kind === 'none') {
    out.skip = row.affiliation
      ? `"${row.affiliation}" is not a school or a team, so there is no town to work in. Pass --cities "${row.name}=City, ST" or add a City column.`
      : `no school, team or city. Pass --cities "${row.name}=City, ST" or add a City column.`;
    return out;
  }
  // kind === 'team'
  if (!ctx.proLookup) {
    out.skip = `"${row.affiliation}" looks like a pro team but the lookup is off (--no-lookup). Pass --cities "${row.name}=City, ST".`;
    return out;
  }
  let res = null;
  try { res = await ctx.proLookup({ name: row.name, sport: row.sport, athleteType: 'pro', team: row.affiliation, position: row.position || null }); }
  catch (e) { out.skip = `pro lookup failed for "${row.affiliation}": ${e.message}. Pass --cities "${row.name}=City, ST".`; return out; }
  const cands = (res && Array.isArray(res.candidates)) ? res.candidates : [];
  const best = cands.find((c) => c && c.best) || cands[0] || null;
  const score = best ? ctx.nameScore(row.name, best.name) : 0;
  if (!best || score < 25) {
    out.skip = `pro lookup found no "${row.name}" on "${row.affiliation}"${res && res.message ? ' (' + res.message + ')' : ''}. Pass --cities "${row.name}=City, ST".`;
    return out;
  }
  if (!best.city) {
    out.skip = `pro lookup found ${best.name} on ${best.team || row.affiliation} but no home city. Pass --cities "${row.name}=City, ST".`;
    return out;
  }
  out.athleteType = 'pro';
  out.team = best.team || row.affiliation;
  out.market = best.city; out.marketNote = `from the pro lookup (${best.sourceLabel || 'web search'}, confidence ${best.confidence || '?'})`;
  out.lookup = { position: best.position || '', knownFor: best.knownFor || '', hometown: best.hometown || '', notes: best.notes || '', tags: best.interestTags || [], league: best.league || '', source: best.sourceUrl || '' };
  if (nameKey(out.team) !== nameKey(row.affiliation)) out.notes.push(`lookup names the team "${out.team}" (file says "${row.affiliation}")`);
  if (!row.position && best.position) out.notes.push(`position ${best.position} from the lookup`);
  return out;
}

// ── THE RECORD, AS THE FORM WOULD SAVE IT ───────────────────────────────────
// Mirrors POST /api/athletes field for field, plus the import's own fields
// (the alternate handles and counts, the total, where it came from).
function recordFor(p, agentId, id, opts = {}) {
  const isPro = p.athleteType === 'pro';
  const lk = p.lookup || {};
  const notes = [];
  if (!isPro && p.secondSport) notes.push(`Also plays ${p.secondSport}.`);
  if (isPro && p.secondSport) notes.push(`Also plays ${p.secondSport}.`);
  if (isPro && !p.team && p.affiliation) notes.push(p.affiliation + '.');
  if (lk.notes) notes.push(lk.notes);
  if (p.totalFollowers) notes.push(`Total followers on the roster sheet: ${p.totalFollowers.toLocaleString()}.`);
  return {
    id, agentId, name: p.name, sport: p.sport,
    position: p.position || lk.position || '',
    athleteType: isPro ? 'pro' : 'college',
    school: isPro ? '' : p.school,
    schoolTier: isPro ? 'p4-mid' : (opts.tier || 'mid-mid'),
    city: isPro ? String(p.market || '').trim().slice(0, 120) : '',
    team: isPro ? String(p.team || '').trim().slice(0, 120) : '',
    instagram: p.instagram || 0,
    tiktok: p.tiktok || 0,
    engagement: null, engagementSource: null, engagementAsOf: null,
    notes: notes.join(' '),
    year: isPro ? '' : (p.year || ''),
    stats: isPro ? (lk.knownFor || '') : '',
    transferReason: '', gpa: '',
    email: (p.email && p.email.includes('@')) ? p.email : '',
    legal_name: '',
    hometown: lk.hometown || '',
    dob: null,
    over18: null,
    schoolRestrictions: [],
    tags: Array.isArray(lk.tags) ? lk.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
    productWants: '',
    instagramHandle: p.instagramHandle || '',
    tiktokHandle: p.tiktokHandle || '',
    // The second handle or count in a "a/b" cell. Nothing reads these yet;
    // they are kept so the sheet's information is not thrown away.
    instagramHandleAlt: p.instagramHandleAlt || '',
    tiktokHandleAlt: p.tiktokHandleAlt || '',
    instagramAlt: p.instagramAlt || 0,
    tiktokAlt: p.tiktokAlt || 0,
    totalFollowers: p.totalFollowers || 0,
    brandRestrictions: [],
    igStatsSource: (p.instagram ? 'manual' : null),
    igStatsFetchedAt: (p.instagram ? new Date().toISOString() : null),
    // Counts typed by the agent, dated today (services/reachProvenance).
    reachSource: (p.instagram || p.tiktok) ? 'agent' : null,
    reachAsOf: (p.instagram || p.tiktok) ? today() : null,
    importedFrom: 'csv', importedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

// Which fixable thing a skipped row needs, for a preview that lets the agent
// fix it in place. null when the skip is not something a cell edit resolves
// (a duplicate).
function fixNeeded(row, placed) {
  const skip = String((placed && placed.skip) || '');
  if (/already on the roster|listed twice/.test(skip)) return null;
  const needs = [];
  if ((row.problems || []).some((p) => /first and a last name/.test(p))) needs.push('name');
  if ((row.problems || []).some((p) => /not a sport|no sport/.test(p))) needs.push('sport');
  if (/--cities|City column|no home city|lookup/.test(skip)) needs.push('city');
  return needs.length ? needs : ['city'];
}

module.exports = {
  placeRow, recordFor, parseTable, fixNeeded, FIELDS, templateCsv,
  parseCsv, parseRoster, mapHeader, parseCount, splitPair, cleanHandle,
  normalizeSport, classifyAffiliation, parseCities, nameKey, sameName,
  SPORT_VALUES, SPORT_ALIASES,
};
