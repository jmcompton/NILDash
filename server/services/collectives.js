'use strict';
// ── A COLLECTIVE IS NOT A SPONSOR ───────────────────────────────────────────
//
// An NIL collective PAYS athletes; it does not sponsor them. Pitching one a
// sponsorship is a category error, and it happened: collectives were live
// cards for Marcus Johnson and Messiah Mickens.
//
// This is the detector. It is not a separate system: compliance.
// classifyBusiness calls it and reports a hit in the 'collective' category
// (blocked at any age), so every existing gate enforces it -- discovery, the
// nightly card gate (outreachQueue.restrictedFor), the send gate, the team
// scan (teamScan.blockedFor) and scripts/block-audit.js.
//
// THREE WAYS A NAME IS A COLLECTIVE
//   1. A named collective from server/data/nilCollectives.json ("Yea Alabama",
//      "1870 Society"): names that do not say what they are. Add one there.
//   2. A phrase that only a collective uses: "NIL fund", "NIL collective",
//      "athlete fund", "players fund", "student athlete fund".
//   3. The word "collective" -- BUT a Coffee Collective or a Hair Collective is
//      a real local business. So the word counts only when the category is NOT
//      a normal consumer business: nonprofit, sports organisation, unknown, or
//      missing. A known consumer category (restaurant, cafe, gym, salon,
//      retail...) keeps it.
// And one without the word: a NONPROFIT / FOUNDATION whose name ties it to a
// school, team or athletes ("... Athletics Foundation", "Tiger Boosters").
//
// needsCategory: true when the only evidence is the word "collective" and no
// category was supplied. A caller that can still learn the category (the card
// gate, before its Places lookup) may defer; with no category at the end, it
// is a collective.
const fs = require('fs');
const path = require('path');

let _names = null;
function knownNames() {
  if (_names) return _names;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nilCollectives.json'), 'utf8'));
    _names = (j.names || []).map(fold).filter(Boolean);
  } catch (e) {
    console.error('[collectives] could not read the named list, generic rules only:', e.message);
    _names = [];
  }
  return _names;
}
function _setNamesForTests(list) { _names = list ? list.map(fold) : null; }

function fold(s) {
  return String(s || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/&/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const has = (hay, phrase) => new RegExp('(^| )' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(hay);

const PHRASES = ['nil fund', 'nil collective', 'nil club', 'athlete fund', 'athletes fund', "athlete's fund", "athletes' fund",
  'players fund', "players' fund", "player's fund", 'student athlete fund', 'student athletes fund'];
// A normal consumer business: the categories a local sponsor actually is.
const CONSUMER = new Set(['restaurant', 'coffee', 'bar', 'food', 'gym', 'wellness', 'salon', 'medspa', 'health', 'apparel', 'retail',
  'supplement', 'auto', 'dealership', 'realestate', 'insurance', 'bank', 'services', 'pet', 'entertainment', 'education']);
const NONPROFIT = /\b(non ?-?profit|nonprofit|charit|foundation|association|organi[sz]ation|society|fund|booster|alumni|sports club|athletic club|sports organi|club)\b/;
const TIED = /\b(athletic|athletics|athlete|athletes|sports|nil|booster|boosters|alumni|university|college|team)\b/;

// evidence: { category, types[], primaryType, primaryTypeDisplayName }
// -> null, or { why, kind: 'named'|'phrase'|'word'|'nonprofit', needsCategory }
function detect(name, evidence) {
  const n = fold(name);
  if (!n) return null;
  const e = evidence || {};
  const BC = require('./businessCategory');
  const described = [e.primaryTypeDisplayName, e.primaryType, e.category].filter(Boolean).map((x) => String(x).replace(/_/g, ' ')).join(' ').toLowerCase();
  const typeCats = (Array.isArray(e.types) ? e.types : []).map((t) => BC.normalise(t)).filter(Boolean);
  const kind = BC.normalise(e.primaryType) || BC.normalise(e.primaryTypeDisplayName) || BC.normalise(e.category) || typeCats[0] || null;
  const consumer = kind && CONSUMER.has(kind) && !NONPROFIT.test(described);
  const anyCategory = !!(described || typeCats.length);

  // A NAMED collective: the exact name always is one. A longer name that
  // contains it ("Volunteer Club Bar & Grill") is kept when Google says it is
  // a consumer business -- the same guard as the word "collective".
  for (const k of knownNames()) {
    if (!has(n, k)) continue;
    if (n !== k && n !== 'the ' + k && consumer) continue;
    return { kind: 'named', why: `a known NIL collective ("${k}")`, needsCategory: false };
  }
  for (const p of PHRASES) if (has(n, p)) return { kind: 'phrase', why: `the name contains "${p}", which only a collective uses`, needsCategory: false };

  if (has(n, 'collective') || has(n, 'collectives')) {
    if (consumer) return null;   // a Coffee Collective, a Hair Collective
    return {
      kind: 'word',
      why: anyCategory ? `the name says "collective" and it is not a consumer business (${described || typeCats.join(', ') || 'uncategorised'})`
        : 'the name says "collective" and there is no category to show it is a consumer business',
      needsCategory: !anyCategory,
    };
  }
  if (NONPROFIT.test(described) && TIED.test(n)) {
    return { kind: 'nonprofit', why: `a nonprofit/foundation (${described}) whose name ties it to a school, team or athletes`, needsCategory: false };
  }
  return null;
}

module.exports = { detect, fold, knownNames, PHRASES, CONSUMER, _setNamesForTests };
