// server/services/university/RosterSourceDiscovery.js
// Multi-tier source discovery for university roster pages.
//
// DESIGN:
//   Never rely on a single source. Builds a prioritized list of URLs
//   to attempt for any university + sport combination.
//
// TIER 1 (trust weight 90): Official university athletics sites
// TIER 2 (trust weight 65): Conference sites, profile aggregators
// TIER 3 (trust weight 40): Supporting public pages
//
// URL construction uses known patterns (Sidearm Sports CMS covers ~80%
// of NCAA programs). Unknown schools fall back to generic patterns.

'use strict';

// ── Athletic site domain registry ─────────────────────────────────────────
// Maps lowercase school name variations → athletics domain
const SCHOOL_DOMAINS = {
  'samford university':        { domain: 'samfordsports.com',     conf: 'SoCon' },
  'samford':                   { domain: 'samfordsports.com',     conf: 'SoCon' },
  'alabama':                   { domain: 'rolltide.com',          conf: 'SEC'   },
  'university of alabama':     { domain: 'rolltide.com',          conf: 'SEC'   },
  'auburn':                    { domain: 'auburntigers.com',      conf: 'SEC'   },
  'auburn university':         { domain: 'auburntigers.com',      conf: 'SEC'   },
  'uab':                       { domain: 'uabsports.com',         conf: 'AAC'   },
  'jacksonville state':        { domain: 'jsugamecocksports.com', conf: 'CUSA'  },
  'troy university':           { domain: 'troytrojans.com',       conf: 'Sun Belt' },
  'troy':                      { domain: 'troytrojans.com',       conf: 'Sun Belt' },
  'south alabama':             { domain: 'usajaguars.com',        conf: 'Sun Belt' },
  'georgia':                   { domain: 'georgiadogs.com',       conf: 'SEC'   },
  'university of georgia':     { domain: 'georgiadogs.com',       conf: 'SEC'   },
  'georgia tech':              { domain: 'ramblinwreck.com',      conf: 'ACC'   },
  'florida':                   { domain: 'floridagators.com',     conf: 'SEC'   },
  'university of florida':     { domain: 'floridagators.com',     conf: 'SEC'   },
  'florida state':             { domain: 'seminoles.com',         conf: 'ACC'   },
  'tennessee':                 { domain: 'utsports.com',          conf: 'SEC'   },
  'university of tennessee':   { domain: 'utsports.com',          conf: 'SEC'   },
  'ohio state':                { domain: 'ohiostatebuckeyes.com', conf: 'Big Ten' },
  'michigan':                  { domain: 'mgoblue.com',           conf: 'Big Ten' },
  'michigan state':            { domain: 'msuspartans.com',       conf: 'Big Ten' },
  'penn state':                { domain: 'gopsusports.com',       conf: 'Big Ten' },
  'notre dame':                { domain: 'und.com',               conf: 'Ind/ACC' },
  'clemson':                   { domain: 'clemsontigers.com',     conf: 'ACC'   },
  'north carolina':            { domain: 'goheels.com',           conf: 'ACC'   },
  'unc':                       { domain: 'goheels.com',           conf: 'ACC'   },
  'duke':                      { domain: 'goduke.com',            conf: 'ACC'   },
  'kentucky':                  { domain: 'ukathletics.com',       conf: 'SEC'   },
  'lsu':                       { domain: 'lsusports.net',         conf: 'SEC'   },
  'mississippi state':         { domain: 'hailstate.com',         conf: 'SEC'   },
  'ole miss':                  { domain: 'olemisssports.com',     conf: 'SEC'   },
  'south carolina':            { domain: 'gamecocksonline.com',   conf: 'SEC'   },
  'vanderbilt':                { domain: 'vucommodores.com',      conf: 'SEC'   },
  'arkansas':                  { domain: 'arkansasrazorbacks.com',conf: 'SEC'   },
  'texas a&m':                 { domain: 'aggiesports.com',       conf: 'SEC'   },
  'texas':                     { domain: 'texassports.com',       conf: 'Big 12'},
  'oklahoma':                  { domain: 'soonersports.com',      conf: 'Big 12'},
  'kansas':                    { domain: 'kuathletics.com',       conf: 'Big 12'},
  'iowa':                      { domain: 'hawkeyesports.com',     conf: 'Big Ten'},
  'wisconsin':                 { domain: 'uwbadgers.com',         conf: 'Big Ten'},
  'northwestern':              { domain: 'nusports.com',          conf: 'Big Ten'},
  'indiana':                   { domain: 'iuhoosiers.com',        conf: 'Big Ten'},
  'purdue':                    { domain: 'purduesports.com',      conf: 'Big Ten'},
  'minnesota':                 { domain: 'gophersports.com',      conf: 'Big Ten'},
  'nebraska':                  { domain: 'huskers.com',           conf: 'Big Ten'},
  'maryland':                  { domain: 'umterps.com',           conf: 'Big Ten'},
  'rutgers':                   { domain: 'scarletknights.com',    conf: 'Big Ten'},
  'byu':                       { domain: 'byucougars.com',        conf: 'Big 12'},
  'utah':                      { domain: 'utahutes.com',          conf: 'Big 12'},
  'colorado':                  { domain: 'cubuffs.com',           conf: 'Big 12'},
  'boise state':               { domain: 'broncosports.com',      conf: 'MW'    },
  'fresno state':              { domain: 'gobulldogs.com',        conf: 'MW'    },
  'appalachian state':         { domain: 'appstatesports.com',    conf: 'Sun Belt'},
  'appalachian state university': { domain: 'appstatesports.com', conf: 'Sun Belt'},
  'western kentucky':          { domain: 'wkusports.com',         conf: 'CUSA'  },
  'liberty':                   { domain: 'libertyflames.com',     conf: 'CUSA'  },
  'kennesaw state':            { domain: 'ksuowls.com',           conf: 'ASUN'  },
  'mercer':                    { domain: 'mercerbears.com',       conf: 'SoCon' },
  'furman':                    { domain: 'furmanpaladins.com',    conf: 'SoCon' },
  'wofford':                   { domain: 'woffordterriers.com',   conf: 'SoCon' },
  'chattanooga':               { domain: 'gomocs.com',            conf: 'SoCon' },
  'the citadel':               { domain: 'citadelsports.com',     conf: 'SoCon' },
  'etsu':                      { domain: 'etsubucs.com',          conf: 'SoCon' },
  'east tennessee state':      { domain: 'etsubucs.com',          conf: 'SoCon' },
  'vmI':                       { domain: 'vmisports.com',         conf: 'SoCon' },
  'western carolina':          { domain: 'catamountsports.com',   conf: 'SoCon' },
};

// ── Sport URL slug map ────────────────────────────────────────────────────
const SPORT_SLUGS = {
  'football':              ['football'],
  'basketball':            ['mens-basketball', 'basketball'],
  "men's basketball":      ['mens-basketball', 'basketball'],
  "women's basketball":    ['womens-basketball'],
  'baseball':              ['baseball'],
  'softball':              ['softball'],
  "women's soccer":        ['womens-soccer', 'soccer'],
  "men's soccer":          ['mens-soccer', 'soccer'],
  'soccer':                ['soccer', 'womens-soccer'],
  'volleyball':            ['volleyball', 'womens-volleyball'],
  "women's volleyball":    ['womens-volleyball', 'volleyball'],
  'track & field':         ['track-and-field', 'outdoor-track-and-field'],
  'cross country':         ['cross-country', 'mens-cross-country'],
  'swimming & diving':     ['swimming-and-diving', 'swimming'],
  'golf':                  ['golf', 'mens-golf'],
  "women's golf":          ['womens-golf'],
  'tennis':                ['tennis', 'mens-tennis'],
  "women's tennis":        ['womens-tennis'],
  'lacrosse':              ['lacrosse', 'mens-lacrosse'],
  "women's lacrosse":      ['womens-lacrosse'],
  'wrestling':             ['wrestling'],
  'gymnastics':            ['gymnastics', 'womens-gymnastics'],
  'field hockey':          ['field-hockey'],
  'rowing':                ['rowing', 'womens-rowing'],
};

// ── Conference domain map ─────────────────────────────────────────────────
const CONFERENCE_DOMAINS = {
  'SoCon':    'soconports.com',
  'SEC':      'secsports.com',
  'ACC':      'theacc.com',
  'Big Ten':  'bigten.org',
  'Big 12':   'big12sports.com',
  'AAC':      'theamerican.org',
  'Sun Belt': 'sunbeltsports.org',
  'CUSA':     'conferenceusa.com',
  'MW':       'mwsports.com',
  'ASUN':     'asunsports.org',
};

// ── Resolve school info ───────────────────────────────────────────────────
function resolveSchool(universityName) {
  const key = universityName.toLowerCase().trim();
  // Exact match
  if (SCHOOL_DOMAINS[key]) return SCHOOL_DOMAINS[key];
  // Partial match
  for (const [k, v] of Object.entries(SCHOOL_DOMAINS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  // Generic fallback: construct domain from school name
  const slug = key
    .replace(/university of /g, '')
    .replace(/university/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
  return { domain: null, slug, conf: null };
}

// ── Resolve sport slugs ───────────────────────────────────────────────────
function resolveSportSlugs(sport) {
  const key = sport.toLowerCase().trim();
  if (SPORT_SLUGS[key]) return SPORT_SLUGS[key];
  // Partial match
  for (const [k, v] of Object.entries(SPORT_SLUGS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return [key.replace(/\s+/g, '-')];
}

// ── Main: discover sources for a university + sport ───────────────────────
// Returns an array of Source objects ordered by tier (Tier 1 first).
function discoverSources(universityName, sport) {
  const school = resolveSchool(universityName);
  const slugs  = resolveSportSlugs(sport);
  const sources = [];

  // ── TIER 1: Official athletics site ──────────────────────────────
  if (school.domain) {
    for (const slug of slugs.slice(0, 2)) {  // try top 2 slug variants
      sources.push({
        tier:  1,
        label: 'Official Athletics',
        url:   `https://www.${school.domain}/sports/${slug}/roster`,
        trustWeight: 90,
      });
      // Some schools use /roster path without /sports/
      sources.push({
        tier:  1,
        label: 'Official Athletics (alt path)',
        url:   `https://www.${school.domain}/${slug}/roster`,
        trustWeight: 85,
      });
    }
  } else if (school.slug) {
    // Unknown school — try common patterns
    const patterns = [
      `https://www.${school.slug}sports.com/sports/${slugs[0]}/roster`,
      `https://athletics.${school.slug}.edu/sports/${slugs[0]}/roster`,
      `https://www.go${school.slug}.com/sports/${slugs[0]}/roster`,
    ];
    patterns.forEach(url => sources.push({ tier: 1, label: 'Official Athletics (inferred)', url, trustWeight: 70 }));
  }

  // ── TIER 2: Conference pages ──────────────────────────────────────
  if (school.conf && CONFERENCE_DOMAINS[school.conf]) {
    const confDomain  = CONFERENCE_DOMAINS[school.conf];
    const schoolSlug  = universityName.toLowerCase().replace(/[^a-z]/g, '');
    sources.push({
      tier:  2,
      label: `${school.conf} Conference`,
      url:   `https://www.${confDomain}/schools/${schoolSlug}/roster`,
      trustWeight: 65,
    });
  }

  // ── TIER 2: ESPN roster page ──────────────────────────────────────
  // ESPN uses sport-code/school name patterns
  const espnSportCodes = {
    football: 'football', basketball: 'mens-college-basketball',
    baseball: 'college-baseball', softball: 'college-softball',
  };
  const espnCode = espnSportCodes[sport.toLowerCase()];
  if (espnCode) {
    const espnSchool = universityName.toLowerCase().replace(/university|college|state/g, '').trim().replace(/\s+/g, '-');
    sources.push({
      tier:  2,
      label: 'ESPN',
      url:   `https://www.espn.com/${espnCode}/team/roster/_/school/${espnSchool}`,
      trustWeight: 60,
    });
  }

  // Remove duplicates by URL
  const seen = new Set();
  return sources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

module.exports = { discoverSources, resolveSchool, resolveSportSlugs, SCHOOL_DOMAINS };
