#!/usr/bin/env node
// scripts/ladder-sample.js
//
// WHAT THE CONTACT LADDER ACTUALLY RETURNS, measured on real businesses.
//
// Runs each business in scripts/sample-businesses.txt through the SAME deep path
// the AI Outreach button uses -- ai.getBrandContacts with ai.deepContactCtx, then
// buildContactLadder -- and prints one row per business plus a summary. Nothing in
// server/ is modified or monkey-patched; this only calls the shipped functions and
// reads the log lines they already emit.
//
// Usage:
//   DATABASE_URL=... ANTHROPIC_API_KEY=... node scripts/ladder-sample.js --city Fayetteville --state AR
//   On Railway:  railway run node scripts/ladder-sample.js --city Fayetteville --state AR
//
//   --file <path>     business list, one per line   (default scripts/sample-businesses.txt)
//   --city <name>     REQUIRED
//   --state <XX>      REQUIRED
//   --limit <n>       how many to run               (default 20)
//   --budget <usd>    hard spend cap                (default 5.00)
//   --dry-run         print the plan and the cost estimate, call nothing
//   --json            emit the rows as JSON instead of a table
//   --in-tok <n>      input tokens assumed per web search, for the cost model
//                     (default 6000 -- see COST below)
//
// COST. Measured where it can be, estimated where it cannot, and the two are
// never added up silently:
//
//   MEASURED   web searches, from `searches=` on each [brand-contacts] source line.
//              Billed at $10 per 1,000 searches on the Claude API.
//   MEASURED   output tokens, from `outTokens=` on the same lines. The contact
//              fan-out runs on Claude Haiku 4.5: $1.00/M in, $5.00/M out.
//   ESTIMATED  input tokens. Search results are billed as input and the per-source
//              log does not carry an input count, so this assumes --in-tok per
//              search plus a ~700-token prompt. It is the only guessed number and
//              it is reported on its own line.
//
// A business costs 3 to 7 source calls, not one: the fan-out runs in waves of 3
// over 7 sources and stops early only when it finds a Tier 1 decision maker. At 2
// searches per source that is 6 to 14 searches per business -- $0.06 to $0.14 in
// search fees alone before a single token.
//
// Two costs here are NOT Anthropic's and are not in the total: one Google Places
// lookup per business, and one Hunter domain search per business that has a
// website. The Instagram lookup is a plain fetch of the site and is free.
//
// SIDE EFFECT, stated plainly: this is read-only with respect to product CODE, but
// the shipped lookup writes what it finds to brand_evidence_cache, exactly as a
// real AI Outreach click does. That is what makes a second run of the same list
// cost nothing. Cached businesses are marked `cache` in the SPEND column and are
// excluded from the spend total.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Pricing, from the Claude API pricing page ────────────────────────────────
const WEB_SEARCH_USD_PER_1K = 10.0;      // $10 per 1,000 searches
const HAIKU_IN_USD_PER_MTOK = 1.0;       // Claude Haiku 4.5
const HAIKU_OUT_USD_PER_MTOK = 5.0;
const PROMPT_TOKENS_PER_SOURCE = 700;    // source lead + shared JSON contract

// ── Pure helpers. Exported and unit-tested; no I/O, no network. ──────────────

// Is this a general inbox rather than a person's mailbox? The ladder has already
// made that call -- it puts a generic inbox in Tier 3 titled "General inbox" and
// never on a named row -- so this reads the ladder rather than re-deciding.
function namedRows(ladder) {
  const out = [];
  for (const t of (ladder && ladder.tiers) || []) {
    if (t.tier === 3) continue;                 // Tier 3 is business channels, never a person
    for (const r of t.rows || []) if (r && r.name) out.push({ ...r, tier: t.tier });
  }
  return out;
}

// The row the modal leads with: the most senior reachable named person.
function topContact(ladder) {
  const rows = namedRows(ladder);
  return rows.length ? rows[0] : null;
}

// A DIRECT channel is anything more specific than the shared main line. The
// ladder computes exactly this and calls it `channel`; 'mainline' means the only
// way to this person is to ring the front desk and ask for them by name, which
// the brief says does not count.
function hasDirectChannel(row) {
  return !!(row && row.channel && row.channel !== 'mainline');
}

// One measured business. `res` is the getBrandContacts return, `ladder` the
// buildContactLadder return, `meta` the metered facts about the call itself.
function classify(brand, res, ladder, meta) {
  const r = res || {};
  const rows = namedRows(ladder);
  const top = rows.length ? rows[0] : null;

  // A personal email is one attached to a NAMED person. The general inbox lives
  // in Tier 3 with no name and is never counted here, per the brief.
  const emailRows = rows.filter((x) => x.email);
  const personalEmail = emailRows.length > 0;
  // Hunter fills an address by matching a surname against a domain pattern. That
  // is a real lead but it is not a published address, and folding the two together
  // would overstate the bar. Counted, and counted separately.
  const personalEmailPublished = emailRows.some((x) => x.emailKind === 'published');

  // "Only a general inbox": a published shop mailbox is the single email route.
  const genericInbox = r.genericInbox || null;
  const generalInboxOnly = !!genericInbox && !personalEmail && !r.personalInbox;

  const phone = !!(ladder && ladder.mainLine) || rows.some((x) => x.phone);
  const direct = rows.filter(hasDirectChannel);

  // Which of the seven sources produced each person. Hunter and Places are not
  // sources in the fan-out sense but they do produce contacts, so they are named
  // too rather than being lumped in with the searches that did the work.
  const bySource = {};
  for (const c of (r.contacts || [])) {
    if (!c || !c.name) continue;
    const s = c.source || 'unknown';
    (bySource[s] = bySource[s] || []).push(c.name);
  }

  return {
    brand,
    named: rows.length > 0,
    namedCount: rows.length,
    topName: top ? top.name : null,
    topTitle: top ? (top.title || null) : null,
    topConfidence: top ? top.confidence : (ladder && ladder.tiers.length ? ladder.tiers[0].rows[0].confidence : null),
    topChannel: top ? top.channel : null,
    personalEmail,
    personalEmailPublished,
    personalEmailAddr: emailRows.length ? emailRows[0].email : null,
    generalInboxOnly,
    genericInbox,
    instagram: r.instagram || null,
    phone,
    mainLine: (ladder && ladder.mainLine && ladder.mainLine.phone) || null,
    directChannel: direct.length > 0,
    namedPlusDirect: rows.length > 0 && direct.length > 0,
    // Named people found but reachable by nothing at all. Shown so the research is
    // not silently discarded, and so "named" is never confused with "actionable".
    unreachable: (ladder && ladder.unreachable) || [],
    staffHeldBack: (ladder && ladder.staffHeldBack) || 0,
    topTier: (ladder && ladder.topTier) || null,
    bySource,
    ...meta,
  };
}

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }

function summarize(rows) {
  const n = rows.length;
  const c = (f) => rows.filter(f).length;
  const metric = (label, count) => ({ label, count, pct: pct(count, n), of: n });
  return {
    n,
    metrics: [
      metric('Named person found', c((r) => r.named)),
      metric('Personal email found', c((r) => r.personalEmail)),
      metric('  of those, published (not a Hunter pattern)', c((r) => r.personalEmailPublished)),
      metric('General inbox only', c((r) => r.generalInboxOnly)),
      metric('Instagram found', c((r) => !!r.instagram)),
      metric('Phone found', c((r) => r.phone)),
      metric('NAMED PERSON + at least one direct channel', c((r) => r.namedPlusDirect)),
    ],
    // Which of the seven are earning their place. A source that never produces a
    // person on any business is paying for searches and returning nothing.
    sources: sourceTable(rows),
  };
}

function sourceTable(rows) {
  const agg = {};
  for (const r of rows) {
    for (const [src, names] of Object.entries(r.bySource || {})) {
      const a = agg[src] || (agg[src] = { source: src, businesses: 0, people: 0 });
      a.businesses++; a.people += names.length;
    }
  }
  return Object.values(agg).sort((a, b) => b.people - a.people || b.businesses - a.businesses);
}

// Dollars for one business, from what was metered. Returns the components so the
// estimated part is never hidden inside a single number.
function costOf(meter, inTokPerSearch) {
  const searches = meter.searches || 0;
  const outTok = meter.outTokens || 0;
  const sources = meter.sources || 0;
  const inTok = searches * inTokPerSearch + sources * PROMPT_TOKENS_PER_SOURCE;
  const search = (searches / 1000) * WEB_SEARCH_USD_PER_1K;
  const output = (outTok / 1e6) * HAIKU_OUT_USD_PER_MTOK;
  const input = (inTok / 1e6) * HAIKU_IN_USD_PER_MTOK;
  return { search, output, input, inTok, total: search + output + input };
}

// What one business is expected to cost before it has been run. Used for the
// pre-flight estimate and to decide whether the NEXT business fits the budget.
function projectPerBusiness(inTokPerSearch, sourcesLow, sourcesHigh, searchesPerSource) {
  const at = (sources) => costOf({
    sources, searches: sources * searchesPerSource,
    outTokens: sources * 900,                     // CONTACT_SEARCH_MAX_TOKENS, the ceiling
  }, inTokPerSearch);
  return { low: at(sourcesLow).total, high: at(sourcesHigh).total };
}

// ── Log capture ──────────────────────────────────────────────────────────────
// The shipped fan-out already logs everything needed to meter a run. Rather than
// wrap the Anthropic client -- which would mean re-implementing the call and
// measuring something that is not the production path -- this reads those lines.
const RE_SOURCE = /\[brand-contacts\] source=(\S+) ms=(\d+) found=(\d+) tier1=(\S+) searches=(\d+) outTokens=(\d+)/;
const RE_SERVED = /\[dealScan\] contacts brand=(.*?) found=\d+ named=\d+ withEmail=\d+ withPhone=\d+ source=(\S+)$/;

function newMeter() { return { sources: 0, searches: 0, outTokens: 0, served: null, perSource: [] }; }

function feedMeter(meter, line) {
  const m = RE_SOURCE.exec(line);
  if (m) {
    meter.sources++;
    meter.searches += parseInt(m[5], 10) || 0;
    meter.outTokens += parseInt(m[6], 10) || 0;
    meter.perSource.push({ source: m[1], ms: +m[2], found: +m[3], tier1: m[4] === 'yes', searches: +m[5] });
    return;
  }
  const s = RE_SERVED.exec(line);
  if (s) meter.served = s[2];        // 'web' | 'cache' | 'TIMEOUT' | 'ERROR'
}

// ── Formatting ───────────────────────────────────────────────────────────────
function yn(v) { return v ? 'yes' : 'no'; }
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

const COLS = [
  ['BUSINESS', 26, (r) => trunc(r.brand, 26)],
  ['NAMED', 5, (r) => yn(r.named)],
  ['WHO', 20, (r) => trunc(r.topName || '-', 20)],
  ['TITLE', 20, (r) => trunc(r.topTitle || '-', 20)],
  ['EMAIL', 5, (r) => (r.personalEmail ? (r.personalEmailPublished ? 'yes' : 'patt') : 'no')],
  ['INBOX', 5, (r) => yn(r.generalInboxOnly)],
  ['IG', 4, (r) => yn(!!r.instagram)],
  ['PHONE', 5, (r) => yn(r.phone)],
  ['CONF', 9, (r) => trunc(r.topConfidence || '-', 9)],
  ['CHANNEL', 9, (r) => trunc(r.topChannel || '-', 9)],
  ['SOURCES', 22, (r) => trunc(Object.keys(r.bySource || {}).join(',') || '-', 22)],
  ['SPEND', 7, (r) => (r.served === 'cache' ? 'cache' : '$' + (r.cost ? r.cost.total : 0).toFixed(3))],
];

function renderTable(rows) {
  const out = [];
  out.push(COLS.map(([h, w]) => pad(h, w)).join(' '));
  out.push(COLS.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const r of rows) out.push(COLS.map(([, w, f]) => pad(f(r), w)).join(' '));
  return out.join('\n');
}

function renderSummary(sum, spend, opts) {
  const L = [];
  L.push('');
  L.push('SUMMARY  (' + sum.n + ' businesses, ' + opts.city + ', ' + opts.state + ')');
  L.push('-'.repeat(64));
  for (const m of sum.metrics) {
    L.push(pad(m.label, 46) + pad(String(m.count) + '/' + m.of, 9) + String(m.pct) + '%');
  }
  L.push('');
  L.push('  "Personal email" never counts a general inbox.');
  L.push('  "Direct channel" never counts a name reachable only via the main line.');
  L.push('');
  L.push('SOURCE YIELD  (which of the seven earned their place)');
  L.push('-'.repeat(64));
  if (!sum.sources.length) L.push('  no named contacts from any source');
  for (const s of sum.sources) {
    L.push('  ' + pad(s.source, 14) + pad(s.people + (s.people === 1 ? ' person' : ' people'), 12)
      + 'on ' + s.businesses + ' of ' + sum.n + ' businesses');
  }
  L.push('');
  L.push('SPEND');
  L.push('-'.repeat(64));
  L.push('  web searches      ' + pad(String(spend.searches), 10) + '$' + spend.search.toFixed(3)
    + '   measured, $' + WEB_SEARCH_USD_PER_1K.toFixed(2) + '/1k');
  L.push('  output tokens     ' + pad(String(spend.outTokens), 10) + '$' + spend.output.toFixed(3)
    + '   measured, Haiku 4.5 $' + HAIKU_OUT_USD_PER_MTOK.toFixed(2) + '/M');
  L.push('  input tokens      ' + pad('~' + spend.inTok, 10) + '$' + spend.input.toFixed(3)
    + '   ESTIMATED at ' + opts.inTok + ' tok/search');
  L.push('  ' + '-'.repeat(50));
  L.push('  TOTAL                         $' + spend.total.toFixed(2)
    + (spend.cached ? '   (' + spend.cached + ' served from cache, $0)' : ''));
  L.push('');
  L.push('  Not included, not billed by Anthropic: ' + spend.priced + ' Google Places lookups,');
  L.push('  ' + spend.hunter + ' Hunter domain searches (1 credit each).');
  return L.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    file: path.join(__dirname, 'sample-businesses.txt'),
    city: null, state: null, limit: 20, budget: 5.0,
    dryRun: false, json: false, inTok: 6000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--city') o.city = argv[++i];
    else if (a === '--state') o.state = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10);
    else if (a === '--budget') o.budget = parseFloat(argv[++i]);
    else if (a === '--in-tok') o.inTok = parseInt(argv[++i], 10);
    else { console.error('unknown argument: ' + a); process.exit(2); }
  }
  return o;
}

function readList(file, limit) {
  if (!fs.existsSync(file)) {
    console.error('No business list at ' + file);
    console.error('Create it with one business name per line, or pass --file.');
    process.exit(2);
  }
  const all = fs.readFileSync(file, 'utf8').split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  return { all, run: all.slice(0, limit) };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.city || !opts.state) {
    console.error('--city and --state are required. Example:');
    console.error('  node scripts/ladder-sample.js --city Fayetteville --state AR');
    process.exit(2);
  }
  const { all, run } = readList(opts.file, opts.limit);
  const region = opts.city + ', ' + opts.state;

  // Pre-flight. The fan-out is 7 sources in waves of 3 and stops early only on a
  // Tier 1 hit, so the floor is 3 sources and the ceiling is 7.
  const projected = projectPerBusiness(opts.inTok, 3, 7, 2);
  console.log('LADDER SAMPLE');
  console.log('  list      ' + opts.file + '  (' + all.length + ' lines, running ' + run.length + ')');
  console.log('  market    ' + region);
  console.log('  path      ai.getBrandContacts + ai.deepContactCtx, then buildContactLadder');
  console.log('            the same call AI Outreach makes. Not the cheap card pass.');
  console.log('  estimate  $' + (projected.low * run.length).toFixed(2)
    + ' to $' + (projected.high * run.length).toFixed(2) + ' for ' + run.length + ' businesses'
    + '  ($' + projected.low.toFixed(3) + ' to $' + projected.high.toFixed(3) + ' each)');
  console.log('            3 to 7 source calls each, 2 web searches per source at $'
    + WEB_SEARCH_USD_PER_1K.toFixed(2) + '/1k, plus Haiku 4.5 tokens.');
  console.log('  budget    $' + opts.budget.toFixed(2) + ' hard cap, checked before each business');
  console.log('');

  if (opts.dryRun) {
    console.log('DRY RUN. Nothing was called. Businesses that would run:');
    run.forEach((b, i) => console.log('  ' + String(i + 1).padStart(2) + '. ' + b));
    if (all.length > run.length) {
      console.log('  (' + (all.length - run.length) + ' more in the file, above --limit ' + opts.limit + ')');
    }
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (the lookup reads and writes brand_evidence_cache).');
    console.error('On Railway: railway run node scripts/ladder-sample.js --city ... --state ...');
    process.exit(2);
  }

  // Required lazily so --dry-run and the unit tests never need pg or an API key.
  const ai = require('../server/ai');
  const { buildContactLadder } = require('../server/services/contactLadder');

  const rows = [];
  const spend = { search: 0, output: 0, input: 0, total: 0, searches: 0, outTokens: 0, inTok: 0, cached: 0, priced: 0, hunter: 0 };
  const skipped = [];

  for (let i = 0; i < run.length; i++) {
    const brand = run[i];

    // BUDGET, checked BEFORE spending. The cap is on what has already been spent
    // plus what the next business could cost at its ceiling, so the run stops
    // short of the cap rather than discovering it has passed it.
    if (spend.total + projected.high > opts.budget) {
      skipped.push(...run.slice(i));
      break;
    }

    const meter = newMeter();
    const realLog = console.log;
    console.log = (...args) => { try { feedMeter(meter, args.join(' ')); } catch (_) {} };
    let res = null, err = null;
    const t0 = Date.now();
    try {
      res = await ai.getBrandContacts(brand, null, region, ai.deepContactCtx({ market: null }));
    } catch (e) {
      err = e;
    } finally {
      console.log = realLog;
    }
    const ms = Date.now() - t0;

    if (err) {
      console.log(pad(String(i + 1) + '.', 4) + pad(trunc(brand, 26), 27) + 'FAILED: ' + err.message);
      rows.push(classify(brand, {}, buildContactLadder({}, {}), { ms, served: 'ERROR', error: err.message, cost: costOf({}, opts.inTok) }));
      continue;
    }

    const ladder = buildContactLadder(res, {
      rankOf: ai.contactAuthorityRank, rootDomain: ai.rootDomain,
      category: null, brand,
    });
    const cost = meter.served === 'cache' ? costOf({}, opts.inTok) : costOf(meter, opts.inTok);
    const row = classify(brand, res, ladder, {
      ms, served: meter.served, cost, perSource: meter.perSource,
      sourcesRun: meter.sources, searches: meter.searches,
    });
    rows.push(row);

    if (meter.served === 'cache') spend.cached++;
    else {
      spend.search += cost.search; spend.output += cost.output; spend.input += cost.input;
      spend.total += cost.total; spend.searches += meter.searches;
      spend.outTokens += meter.outTokens; spend.inTok += cost.inTok;
    }
    spend.priced++;
    if (res.website) spend.hunter++;

    // Live progress. A twenty-business run takes minutes; silence would read as a hang.
    console.log(pad(String(i + 1) + '.', 4) + pad(trunc(brand, 26), 27)
      + pad(row.named ? row.topName : 'no named contact', 22)
      + pad(meter.served === 'cache' ? 'cache' : meter.sources + ' src / ' + meter.searches + ' searches', 22)
      + pad(Math.round(ms / 100) / 10 + 's', 7)
      + (meter.served === 'cache' ? '' : '$' + cost.total.toFixed(3)));
  }

  console.log('');
  if (opts.json) {
    console.log(JSON.stringify({ region, rows, summary: summarize(rows), spend }, null, 2));
  } else {
    console.log(renderTable(rows));
    console.log(renderSummary(summarize(rows), spend, opts));
    const unreachable = rows.filter((r) => r.unreachable.length);
    if (unreachable.length) {
      console.log('');
      console.log('NAMED BUT UNREACHABLE  (found, no channel at all, so not on the ladder)');
      console.log('-'.repeat(64));
      for (const r of unreachable) console.log('  ' + pad(trunc(r.brand, 26), 28) + r.unreachable.join(', '));
    }
  }
  // NEVER a silent cap. A short run that does not say it was short reads as a
  // complete measurement of the whole list.
  if (skipped.length) {
    console.log('');
    console.log('STOPPED ON BUDGET after ' + rows.length + ' of ' + run.length + '. $'
      + spend.total.toFixed(2) + ' spent, cap $' + opts.budget.toFixed(2) + '.');
    console.log('Not run: ' + skipped.join(', '));
    console.log('Raise it with --budget, or re-run: the ' + rows.length + ' already done are cached and free.');
  }
}

module.exports = {
  classify, summarize, sourceTable, costOf, projectPerBusiness,
  namedRows, topContact, hasDirectChannel, feedMeter, newMeter, pct,
  renderTable, renderSummary,
  WEB_SEARCH_USD_PER_1K, HAIKU_IN_USD_PER_MTOK, HAIKU_OUT_USD_PER_MTOK,
};

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('[ladder-sample] ' + e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
