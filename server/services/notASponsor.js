'use strict';
// ── ONLY A BUSINESS THAT COULD BUY AN ENDORSEMENT IS A PROSPECT ──────────────
//
// "On3 NIL Valuation" was queued as a DM to Shannon Terry, On3's founder. On3
// is a media and valuation site: it writes about NIL, it does not buy it. The
// national lane's source (deal_comps, extracted from NIL news) is full of these
// -- valuation sites, recruiting services, athletic programs ("Texas A&M
// Aggies", "Oregon Ducks"), and events ("College Football 2026 Cover Star").
//
// This is the second half of "not a sponsor"; services/collectives is the
// first. detect() asks the collective detector, then these rules, and every
// gate that blocks a collective blocks these too: compliance.classifyBusiness
// reports a hit in the 'not-a-sponsor' category (blocked at any age), so the
// nightly card gate, the send gate, the team scan and scripts/block-audit.js
// enforce it, and the discovery writers (placesMarket, Deal Scan, the market
// pool, the national lane) drop it before it can be a candidate.
//
// THREE KINDS OF RULE, from certain to contextual
//   1. A NAMED organisation (server/data/notSponsors.json): On3, 247Sports,
//      Opendorse, ESPN, the NCAA. The exact name always; a longer name that
//      contains one ("ESPN Zone Grill") only when it is not a consumer business.
//   2. A PHRASE that only such an organisation uses: "NIL valuation",
//      "recruiting service", "athletic department", "cover star".
//   3. WORDS that are usually but not always this: a media word (news, radio,
//      podcast, network, magazine), "recruiting", a school ("University of X",
//      "X College", "X Athletics"), or a team ("<place> <mascot>"). These
//      count only when the business is NOT a known consumer business -- a
//      "Good News Cafe" or a "Tigers Den" restaurant is kept.
const fs = require('fs');
const path = require('path');
const COL = require('./collectives');
const { fold } = COL;

let _names = null;
function knownNames() {
  if (_names) return _names;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'notSponsors.json'), 'utf8'));
    _names = (j.names || []).map(fold).filter(Boolean);
  } catch (e) {
    console.error('[notASponsor] could not read the named list, phrase and word rules only:', e.message);
    _names = [];
  }
  return _names;
}
const has = (hay, phrase) => new RegExp('(^| )' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(hay);

const PHRASES = ['nil valuation', 'nil valuations', 'nil rankings', 'nil ranking', 'valuation', 'valuations',
  'recruiting service', 'recruiting services', 'recruiting network', 'scouting service', 'scouting report',
  'athletic department', 'athletics department', 'department of athletics', 'athletic association',
  'sports information', 'cover star', 'cover athlete', 'player rankings', 'recruiting rankings',
  'nil marketplace', 'nil platform', 'nil agency', 'nil deal tracker', 'nil news', 'transfer portal'];
const MEDIA = ['news', 'magazine', 'podcast', 'radio', 'sports network', 'news network', 'media group', 'sports media', 'broadcasting', 'tv',
  'television', 'gazette', 'tribune', 'sports talk'];
const SCHOOL = /(^|\s)(university of|college of)\s|\s(university|college|athletics|athletic department)$/;
const MASCOTS = new Set(['aggies', 'ducks', 'tigers', 'bulldogs', 'wildcats', 'gators', 'seminoles', 'hurricanes',
  'longhorns', 'sooners', 'buckeyes', 'wolverines', 'spartans', 'hawkeyes', 'badgers', 'gophers', 'cornhuskers',
  'huskers', 'hoosiers', 'boilermakers', 'illini', 'terrapins', 'terps', 'knights', 'bruins', 'trojans', 'huskies',
  'beavers', 'cougars', 'utes', 'buffaloes', 'cardinal', 'bears', 'razorbacks', 'rebels', 'volunteers', 'vols',
  'commodores', 'gamecocks', 'jayhawks', 'cyclones', 'mountaineers', 'cowboys', 'bearcats', 'mustangs', 'owls',
  'panthers', 'cardinals', 'wolfpack', 'cavaliers', 'hokies', 'eagles', 'pirates', 'blazers', 'roadrunners',
  'miners', 'lobos', 'rams', 'falcons', 'broncos', 'aztecs', 'warriors', 'bulls', 'monarchs', 'dukes',
  'chanticleers', 'flames', 'hilltoppers', 'jaguars', 'wolves', 'warhawks', 'bobcats', 'zips', 'rockets',
  'chippewas', 'redhawks', 'minutemen', 'midshipmen', 'spiders', 'gaels', 'zags', 'friars', 'hoyas', 'musketeers',
  'bluejays', 'hawks', 'sun devils', 'mavericks', 'titans', 'anteaters', 'gauchos', 'matadors', 'tritons',
  'highlanders', 'lumberjacks', 'thunderbirds', 'vandals', 'grizzlies', 'crimson tide', 'fighting irish',
  'tar heels', 'blue devils', 'horned frogs', 'red raiders', 'demon deacons', 'yellow jackets', 'thundering herd',
  'mean green', 'golden flashes', 'ragin cajuns', 'red storm', 'nittany lions', 'detroit lions']);
// A normal consumer business: the categories a local sponsor actually is.
const CONSUMER = COL.CONSUMER;
const NONCONSUMER_DESC = /\b(news|media|publisher|broadcast|radio|television|university|college|school|athletic|sports organi|sports club|association|foundation|non ?-?profit)\b/;

// evidence: { category, types[], primaryType, primaryTypeDisplayName }
// -> null, or { key: 'collective'|'not-a-sponsor', kind, why, needsCategory }
function detect(name, evidence) {
  const col = COL.detect(name, evidence);
  if (col) return { key: 'collective', ...col };
  const n = fold(name);
  if (!n) return null;
  const e = evidence || {};
  const BC = require('./businessCategory');
  const described = [e.primaryTypeDisplayName, e.primaryType, e.category].filter(Boolean).map((x) => String(x).replace(/_/g, ' ')).join(' ').toLowerCase();
  const typeCats = (Array.isArray(e.types) ? e.types : []).map((t) => BC.normalise(t)).filter(Boolean);
  const kind = BC.normalise(e.primaryType) || BC.normalise(e.primaryTypeDisplayName) || BC.normalise(e.category) || typeCats[0] || null;
  const consumer = !!(kind && CONSUMER.has(kind) && !NONCONSUMER_DESC.test(described));
  const out = (k, why) => ({ key: 'not-a-sponsor', kind: k, why, needsCategory: false });

  for (const k of knownNames()) {
    if (!has(n, k)) continue;
    if (n !== k && n !== 'the ' + k && consumer) continue;
    return out('named', `"${k}" is a media, valuation, recruiting or NIL-platform organisation, not a business that buys endorsements`);
  }
  for (const p of PHRASES) if (has(n, p)) return out('phrase', `the name says "${p}", which is not a business that buys endorsements`);
  if (consumer) return null;
  // The name itself can say what the business is ("Good News Cafe", "Blue
  // Devils Barber"): a row with no category is still kept when its own name
  // names a consumer kind.
  const byName = BC.normalise(name);
  if (byName && CONSUMER.has(byName)) return null;

  const words = n.split(' ');
  const media = MEDIA.find((w) => has(n, w));
  if (media) return out('media', `the name says "${media}" and it is not a consumer business: media covers athletes, it does not sponsor them`);
  if (has(n, 'recruiting')) return out('recruiting', 'a recruiting service, not a business that buys endorsements');
  if (SCHOOL.test(n)) return out('school', 'a school or athletic program, not a business that buys endorsements');
  const last = words[words.length - 1], last2 = words.slice(-2).join(' ');
  if (words.length >= 2 && words.length <= 5 && (MASCOTS.has(last) || MASCOTS.has(last2))) {
    return out('team', `reads as a team ("${name}"), not a business that buys endorsements`);
  }
  return null;
}

module.exports = { detect, knownNames, PHRASES, MEDIA, MASCOTS };
