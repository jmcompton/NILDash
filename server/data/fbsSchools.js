'use strict';
// FBS athletics domains, keyed by the school name the program map uses.
//
// PROVENANCE, AND WHY IT MATTERS. These domains come from general knowledge, not
// from a verified feed. Some will be wrong: a school that rebranded its athletics
// site, a domain that now redirects, a name spelled differently here than in the
// database. That is survivable BECAUSE the sweep proves each one: a wrong domain
// produces "NO CANDIDATE PATH WORKED" and lands on the needs-attention list at the
// end of the run, where it can be hand-set with --set-url. Nothing here is trusted
// on faith, and no staff record is ever created from a domain alone.
//
// Conference is deliberately absent. Realignment churns every year, the sweep does
// not use it, and recording a fact this volatile only creates something to be wrong
// about. The domain is the only field the pipeline needs.
//
// The 10 pilot schools are NOT repeated here. programMap.SCHOOLS remains their
// source of truth, including their verified hand-set URLs, and this list is merged
// underneath it so a pilot entry always wins.

const FBS_SCHOOLS = {
  // SEC (minus the 10 pilot programs already in programMap.SCHOOLS)
  'Arkansas': 'arkansasrazorbacks.com',
  'Kentucky': 'ukathletics.com',
  'Mississippi State': 'hailstate.com',
  'Oklahoma': 'soonersports.com',
  'Vanderbilt': 'vucommodores.com',

  // Big Ten
  'Illinois': 'fightingillini.com',
  'Indiana': 'iuhoosiers.com',
  'Iowa': 'hawkeyesports.com',
  'Maryland': 'umterps.com',
  'Michigan': 'mgoblue.com',
  'Michigan State': 'msuspartans.com',
  'Minnesota': 'gophersports.com',
  'Nebraska': 'huskers.com',
  'Northwestern': 'nusports.com',
  'Ohio State': 'ohiostatebuckeyes.com',
  'Oregon': 'goducks.com',
  'Penn State': 'gopsusports.com',
  'Purdue': 'purduesports.com',
  'Rutgers': 'scarletknights.com',
  'UCLA': 'uclabruins.com',
  'USC': 'usctrojans.com',
  'Washington': 'gohuskies.com',
  'Wisconsin': 'uwbadgers.com',

  // Big 12
  'Arizona': 'arizonawildcats.com',
  'Arizona State': 'thesundevils.com',
  'Baylor': 'baylorbears.com',
  'BYU': 'byucougars.com',
  'Cincinnati': 'gobearcats.com',
  'Colorado': 'cubuffs.com',
  'Houston': 'uhcougars.com',
  'Iowa State': 'cyclones.com',
  'Kansas': 'kuathletics.com',
  'Kansas State': 'kstatesports.com',
  'Oklahoma State': 'okstate.com',
  'TCU': 'gofrogs.com',
  'Texas Tech': 'texastech.com',
  'UCF': 'ucfknights.com',
  'Utah': 'utahutes.com',
  'West Virginia': 'wvusports.com',

  // ACC
  'Boston College': 'bceagles.com',
  'California': 'calbears.com',
  'Clemson': 'clemsontigers.com',
  'Duke': 'goduke.com',
  'Florida State': 'seminoles.com',
  'Georgia Tech': 'ramblinwreck.com',
  'Louisville': 'gocards.com',
  'Miami': 'hurricanesports.com',
  'NC State': 'gopack.com',
  'North Carolina': 'goheels.com',
  'Pittsburgh': 'pittsburghpanthers.com',
  'SMU': 'smumustangs.com',
  'Stanford': 'gostanford.com',
  'Syracuse': 'cuse.com',
  'Virginia': 'virginiasports.com',
  'Virginia Tech': 'hokiesports.com',
  'Wake Forest': 'godeacs.com',

  // Independents
  'Notre Dame': 'und.com',
  'UConn': 'uconnhuskies.com',

  // American
  'Army': 'goarmywestpoint.com',
  'Charlotte': 'charlotte49ers.com',
  'East Carolina': 'ecupirates.com',
  'Florida Atlantic': 'fausports.com',
  'Memphis': 'gotigersgo.com',
  'Navy': 'navysports.com',
  'North Texas': 'meangreensports.com',
  'Rice': 'riceowls.com',
  'South Florida': 'gousfbulls.com',
  'Temple': 'owlsports.com',
  'Tulane': 'tulanegreenwave.com',
  'Tulsa': 'tulsahurricane.com',
  'UAB': 'uabsports.com',
  'UTSA': 'goutsa.com',

  // Mountain West
  'Air Force': 'goairforcefalcons.com',
  'Boise State': 'broncosports.com',
  'Colorado State': 'csurams.com',
  'Fresno State': 'gobulldogs.com',
  'Hawaii': 'hawaiiathletics.com',
  'Nevada': 'nevadawolfpack.com',
  'New Mexico': 'golobos.com',
  'San Diego State': 'goaztecs.com',
  'San Jose State': 'sjsuspartans.com',
  'UNLV': 'unlvrebels.com',
  'Utah State': 'utahstateaggies.com',
  'Wyoming': 'gowyo.com',

  // Conference USA
  'Delaware': 'bluehens.com',
  'Florida International': 'fiusports.com',
  'Jacksonville State': 'jsugamecocksports.com',
  'Kennesaw State': 'ksuowls.com',
  'Liberty': 'libertyflames.com',
  'Louisiana Tech': 'latechsports.com',
  'Middle Tennessee': 'goblueraiders.com',
  'Missouri State': 'missouristatebears.com',
  'New Mexico State': 'nmstatesports.com',
  'Sam Houston': 'gobearkats.com',
  'UTEP': 'utepminers.com',
  'Western Kentucky': 'wkusports.com',

  // MAC
  'Akron': 'gozips.com',
  'Ball State': 'ballstatesports.com',
  'Bowling Green': 'bgsufalcons.com',
  'Buffalo': 'ubbulls.com',
  'Central Michigan': 'cmuchippewas.com',
  'Eastern Michigan': 'emueagles.com',
  'Kent State': 'kentstatesports.com',
  'Miami (OH)': 'miamiredhawks.com',
  'Northern Illinois': 'niuhuskies.com',
  'Ohio': 'ohiobobcats.com',
  'Toledo': 'utrockets.com',
  'UMass': 'umassathletics.com',
  'Western Michigan': 'wmubroncos.com',

  // Pac-12
  'Oregon State': 'osubeavers.com',
  'Washington State': 'wsucougars.com',

  // Sun Belt
  'Appalachian State': 'appstatesports.com',
  'Arkansas State': 'astateredwolves.com',
  'Coastal Carolina': 'goccusports.com',
  'Georgia Southern': 'gseagles.com',
  'Georgia State': 'georgiastatesports.com',
  'James Madison': 'jmusports.com',
  'Louisiana': 'ragincajuns.com',
  'Louisiana-Monroe': 'ulmwarhawks.com',
  'Marshall': 'herdzone.com',
  'Old Dominion': 'odusports.com',
  'South Alabama': 'usajaguars.com',
  'Southern Miss': 'southernmiss.com',
  'Texas State': 'txstatebobcats.com',
  'Troy': 'troytrojans.com',
};

module.exports = { FBS_SCHOOLS };
