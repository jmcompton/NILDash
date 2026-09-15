'use strict';
// No database. Runs anywhere:
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/rosterimport.js       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const fs = require('fs');

// ── A ROSTER CSV BECOMES THE ATHLETES THE FORM WOULD HAVE SAVED ─────────────
//
// The seven rows below are the agent's own file, and they hold every messy
// case the importer has a rule for: "15,000+", two handles or two counts in
// one cell, a handle without its @, a handle with a space, "Hockey" for ice
// hockey, "Basketball and Softball", a pro team, and "Professional Golfer"
// which is neither a school nor a team and must not be guessed.

const RI = require(REPO + 'server/services/rosterImport.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const CSV = `First,Last,Sport,School/Affiliation,Total followers,Instagram handle,Instagram followers,TikTok handle,TikTok followers
Cooper,Farrall,Basketball,Bentley University,"15,000+",@t1dhooper/@cooperfarrall,"11,100/4,254",@cooperfarrall,643
Caleb,Manuel,Golf,Professional Golfer,"4,500+",@calebmanuel59/@calebgolf59,"3,612/1,034",@Caleb.Manuel03,128
Max,Murray,Soccer,New York City FC,"2,500+",@_justmaxwell,"2,465",@maxwellmurray15,134
Abby,Turnpaugh,Softball,University of Manhattan,"1,700+",abby.turnpaugh,"1,534",@abbyturnpaugh,219
Emma,Boulanger,Basketball and Softball,UMaine at Augusta,"1,200+",emmaboulanger,759,@emma_boulanger,566
Kaylee,Sakoda,Golf,Professional Golfer,"1,200+",@kay_sakoda,"1,213",@kaylee sakoda,186
Ella,Boerger,Hockey,University of St. Thomas,"1,200+",@ella.boerger,"1,262",,
`;

async function main() {
  // ── 1. THE CELLS ─────────────────────────────────────────────────────────
  OUT.push('-- cells --');
  ok('"15,000+" is 15000', RI.parseCount('15,000+') === 15000);
  ok('"11,100" is 11100', RI.parseCount('11,100') === 11100);
  ok('"643" is 643', RI.parseCount('643') === 643);
  ok('"1.2k" is 1200', RI.parseCount('1.2k') === 1200);
  ok('a blank count is null, not 0', RI.parseCount('') === null);
  ok('words are not a count', RI.parseCount('lots') === null);
  ok('"a/b" splits into two', JSON.stringify(RI.splitPair('@t1dhooper/@cooperfarrall')) === '["@t1dhooper","@cooperfarrall"]');
  ok('"11,100/4,254" splits into two counts', JSON.stringify(RI.splitPair('11,100/4,254').map(RI.parseCount)) === '[11100,4254]');
  ok('a handle without @ is accepted and noted', RI.cleanHandle('abby.turnpaugh').handle === 'abby.turnpaugh' && /added @/.test(RI.cleanHandle('abby.turnpaugh').note));
  ok('a handle with a space loses the space and says so', RI.cleanHandle('@kaylee sakoda').handle === 'kayleesakoda' && /removed a space/.test(RI.cleanHandle('@kaylee sakoda').note));
  ok('a handle is lower-cased', RI.cleanHandle('@Caleb.Manuel03').handle === 'caleb.manuel03');
  ok('a URL is a handle', RI.cleanHandle('https://www.instagram.com/ella.boerger/').handle === 'ella.boerger');
  ok('a number in the handle column is not a handle', RI.cleanHandle('1,262').handle === null);

  // ── 2. THE SPORT ─────────────────────────────────────────────────────────
  OUT.push('', '-- sport --');
  ok('Hockey is ice hockey', RI.normalizeSport('Hockey').sport === 'ice hockey');
  ok('Ice hockey is ice hockey', RI.normalizeSport('Ice hockey').sport === 'ice hockey');
  ok('  and they are the same sport', RI.normalizeSport('Hockey').sport === RI.normalizeSport('Ice Hockey').sport);
  ok('Field hockey is not ice hockey', RI.normalizeSport('Field Hockey').sport === 'field hockey');
  ok("Women's Hockey is womens ice hockey", RI.normalizeSport("Women's Hockey").sport === 'womens ice hockey');
  const two = RI.normalizeSport('Basketball and Softball');
  ok('"Basketball and Softball" takes the first', two.sport === 'basketball', two);
  ok('  keeps the second', two.secondSport === 'softball', two);
  ok('  and says so', /plays softball too/.test(two.note), two.note);
  ok('"Soccer/Track" takes soccer', RI.normalizeSport('Soccer/Track').sport === 'soccer');
  ok('Basketball is the form value "basketball"', RI.normalizeSport('Basketball').sport === 'basketball');
  ok("Women's Basketball is its own value", RI.normalizeSport("Women's Basketball").sport === 'womens basketball');
  ok('Track & Field is "track"', RI.normalizeSport('Track & Field').sport === 'track');
  ok('every sport value is one the form offers', RI.SPORT_VALUES.every((v) => Object.values(RI.SPORT_ALIASES).includes(v) || RI.SPORT_VALUES.includes(v)));
  ok('a word that is not a sport is refused, not guessed', RI.normalizeSport('Esports').sport === null);
  const html = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  const formValues = (html.match(/<select class="select-sm" id="a_sport">[\s\S]*?<\/select>/) || [''])[0].match(/value="([^"]+)"/g).map((m) => m.slice(7, -1));
  ok('the sport values are exactly the Add Client form\'s', JSON.stringify(RI.SPORT_VALUES.slice().sort()) === JSON.stringify(formValues.slice().sort()), { missing: formValues.filter((v) => !RI.SPORT_VALUES.includes(v)), extra: RI.SPORT_VALUES.filter((v) => !formValues.includes(v)) });

  // ── 3. THE AFFILIATION ───────────────────────────────────────────────────
  OUT.push('', '-- affiliation --');
  ok('Bentley University is a school', RI.classifyAffiliation('Bentley University') === 'school');
  ok('UMaine at Augusta is a school', RI.classifyAffiliation('UMaine at Augusta') === 'school');
  ok('University of St. Thomas is a school', RI.classifyAffiliation('University of St. Thomas') === 'school');
  ok('Boston College is a school', RI.classifyAffiliation('Boston College') === 'school');
  ok('New York City FC is a team', RI.classifyAffiliation('New York City FC') === 'team');
  ok('Denver Broncos is a team', RI.classifyAffiliation('Denver Broncos') === 'team');
  ok('Professional Golfer is neither', RI.classifyAffiliation('Professional Golfer') === 'none');
  ok('Team USA is neither', RI.classifyAffiliation('Team USA') === 'none');
  ok('PEAK Recovery is neither', RI.classifyAffiliation('PEAK Recovery') === 'none');
  ok('an empty cell is neither', RI.classifyAffiliation('') === 'none');

  // ── 4. THE ROWS ──────────────────────────────────────────────────────────
  OUT.push('', '-- the file --');
  const cities = RI.parseCities('Caleb Manuel=Portland, ME; Kaylee Sakoda: Honolulu, HI');
  ok('--cities reads "First Last=City, ST; First Last: City, ST"', cities[RI.nameKey('Caleb Manuel')] === 'Portland, ME' && cities[RI.nameKey('Kaylee Sakoda')] === 'Honolulu, HI', cities);
  ok('  and JSON', RI.parseCities('{"Caleb Manuel":"Portland, ME"}')[RI.nameKey('Caleb Manuel')] === 'Portland, ME');
  const { columns, rows } = RI.parseRoster(CSV, { cities: RI.parseCities('Caleb Manuel=Portland, ME') });
  ok('every column is recognised', ['first', 'last', 'sport', 'affiliation', 'total', 'instagramHandle', 'instagram', 'tiktokHandle', 'tiktok'].every((k) => columns[k] !== undefined), columns);
  ok('seven rows', rows.length === 7, rows.length);
  const by = (n) => rows.find((r) => r.name === n);
  const cooper = by('Cooper Farrall');
  ok('Cooper: primary Instagram is the first handle', cooper.instagramHandle === 't1dhooper', cooper);
  ok('  the second is kept as the alternate', cooper.instagramHandleAlt === 'cooperfarrall');
  ok('  the counts pair the same way', cooper.instagram === 11100 && cooper.instagramAlt === 4254);
  ok('  total 15000', cooper.totalFollowers === 15000);
  ok('  TikTok 643', cooper.tiktokHandle === 'cooperfarrall' && cooper.tiktok === 643);
  const caleb = by('Caleb Manuel');
  ok('Caleb: Professional Golfer is no school or team', caleb.affiliationKind === 'none');
  ok('  --cities gave him a town', caleb.city === 'Portland, ME');
  ok('  handle lower-cased', caleb.tiktokHandle === 'caleb.manuel03');
  const max = by('Max Murray');
  ok('Max: New York City FC is a team', max.affiliationKind === 'team');
  ok('  a lone count is the primary with no alternate', max.instagram === 2465 && max.instagramAlt === 0 && max.instagramHandleAlt === '');
  const abby = by('Abby Turnpaugh');
  ok('Abby: handle without @ is accepted', abby.instagramHandle === 'abby.turnpaugh' && abby.notes.some((n) => /added @/.test(n)));
  const emma = by('Emma Boulanger');
  ok('Emma: basketball, with softball noted', emma.sport === 'basketball' && emma.secondSport === 'softball');
  const kaylee = by('Kaylee Sakoda');
  ok('Kaylee: no city, so no town', kaylee.city === '' && kaylee.affiliationKind === 'none');
  ok('  the TikTok space is gone', kaylee.tiktokHandle === 'kayleesakoda');
  const ella = by('Ella Boerger');
  ok('Ella: Hockey is ice hockey', ella.sport === 'ice hockey');
  ok('  no TikTok at all is empty, not 0-with-a-handle', ella.tiktokHandle === '' && ella.tiktok === 0);
  ok('no row has a problem', rows.every((r) => !r.problems.length), rows.filter((r) => r.problems.length).map((r) => r.problems));

  // ── 5. PLACING EACH ROW ──────────────────────────────────────────────────
  OUT.push('', '-- college, pro, or skipped --');
  const lookups = [];
  const ctx = {
    existing: ['Cooper Farrall', 'Amber Bretton'],
    existingName: (n) => ['Cooper Farrall', 'Amber Bretton'].find((x) => RI.sameName(x, n)) || n,
    schoolLocation: (s) => (/St\. Thomas/.test(s) ? { city: 'St. Paul', state: 'MN' } : null),
    proLookup: async (q) => {
      lookups.push(q);
      if (/New York City FC/.test(q.team)) return { found: true, candidates: [{ best: true, name: 'Max Murray', team: 'New York City FC', city: 'New York, NY', position: 'Defender', knownFor: 'Homegrown signing', interestTags: ['sneakers'], confidence: 88, sourceLabel: 'MLSsoccer.com' }] };
      return { found: false, candidates: [], message: 'nothing on a roster' };
    },
    nameScore: (a, b) => (RI.sameName(a, b) ? 35 : 0),
  };
  const placed = [];
  for (const r of rows) placed.push(await RI.placeRow(r, ctx));
  const P = (n) => placed.find((p) => p.name === n);
  ok('Cooper Farrall is skipped: already on the roster', /already on the roster/.test(P('Cooper Farrall').skip || ''), P('Cooper Farrall').skip);
  ok('  matched by first and last name, not case or spacing', RI.sameName('cooper  farrall', 'Cooper Farrall') && RI.sameName("Amber Bretton", 'amber bretton'));
  ok('Caleb Manuel is a pro in Portland, ME (from --cities), no team', P('Caleb Manuel').athleteType === 'pro' && P('Caleb Manuel').market === 'Portland, ME' && P('Caleb Manuel').team === '', P('Caleb Manuel'));
  ok('Kaylee Sakoda is skipped and told what to pass', /--cities "Kaylee Sakoda=City, ST"/.test(P('Kaylee Sakoda').skip || ''), P('Kaylee Sakoda').skip);
  ok('Max Murray is a pro placed by the lookup', P('Max Murray').athleteType === 'pro' && P('Max Murray').market === 'New York, NY' && P('Max Murray').team === 'New York City FC', P('Max Murray'));
  ok('  the lookup ran once, for him alone, as a pro', lookups.length === 1 && lookups[0].athleteType === 'pro' && lookups[0].name === 'Max Murray', lookups);
  ok('  and carried his position and known-for', P('Max Murray').lookup.position === 'Defender' && P('Max Murray').lookup.knownFor === 'Homegrown signing');
  ok('Abby Turnpaugh is college, school not in the map, geocoded later', P('Abby Turnpaugh').athleteType === 'college' && P('Abby Turnpaugh').school === 'University of Manhattan' && P('Abby Turnpaugh').market === null && /geocoded/.test(P('Abby Turnpaugh').marketNote));
  ok('Emma Boulanger is college at UMaine at Augusta', P('Emma Boulanger').athleteType === 'college' && P('Emma Boulanger').school === 'UMaine at Augusta');
  ok('Ella Boerger is college with a known market', P('Ella Boerger').athleteType === 'college' && P('Ella Boerger').market === 'St. Paul, MN');
  ok('five would be created, two skipped', placed.filter((p) => !p.skip).length === 5 && placed.filter((p) => p.skip).length === 2, placed.map((p) => [p.name, p.skip || p.athleteType]));

  // A team row when the lookup finds nothing: skipped, never guessed.
  const stray = await RI.placeRow({ ...rows[2], affiliation: 'Springfield Isotopes', affiliationKind: 'team' }, ctx);
  ok('a team the lookup cannot place is skipped, not guessed', /found no "Max Murray" on "Springfield Isotopes"/.test(stray.skip || ''), stray.skip);
  const off = await RI.placeRow(rows[2], { ...ctx, proLookup: null });
  ok('--no-lookup on a team row skips it and says to pass --cities', /--no-lookup/.test(off.skip || '') && /--cities/.test(off.skip), off.skip);
  const givenCity = await RI.placeRow({ ...rows[2], city: 'Queens, NY' }, ctx);
  ok('a team row with a city given skips the lookup and keeps the team', givenCity.athleteType === 'pro' && givenCity.team === 'New York City FC' && givenCity.market === 'Queens, NY' && lookups.length === 2);
  const twoSchool = await RI.placeRow({ ...rows[6], city: 'Boston, MA' }, ctx);
  ok('a city on a college row is ignored, with a note', twoSchool.athleteType === 'college' && twoSchool.notes.some((n) => /city ignored/.test(n)));

  // ── 6. THE RECORD ────────────────────────────────────────────────────────
  OUT.push('', '-- the record matches what the form saves --');
  const recC = RI.recordFor(P('Ella Boerger'), 'agent-1', 'ath-1', { tier: 'd3-mid' });
  ok('college: school, no city or team, tier as asked', recC.athleteType === 'college' && recC.school === 'University of St. Thomas' && recC.city === '' && recC.team === '' && recC.schoolTier === 'd3-mid');
  ok('  sport is the form value', recC.sport === 'ice hockey');
  ok('  counts and handles', recC.instagram === 1262 && recC.instagramHandle === 'ella.boerger' && recC.tiktok === 0 && recC.tiktokHandle === '');
  ok('  reach is dated and credited to the agent', recC.reachSource === 'agent' && /^\d{4}-\d{2}-\d{2}$/.test(recC.reachAsOf));
  ok('  over18 and dob are unknown, not assumed', recC.over18 === null && recC.dob === null);
  ok('  the total from the sheet is kept in notes', /Total followers on the roster sheet: 1,200/.test(recC.notes));
  ok('  agentId travels separately for saveAthlete', recC.agentId === 'agent-1' && recC.id === 'ath-1');
  const recP = RI.recordFor(P('Max Murray'), 'agent-1', 'ath-2');
  ok('pro: city and team, no school, no year', recP.athleteType === 'pro' && recP.city === 'New York, NY' && recP.team === 'New York City FC' && recP.school === '' && recP.year === '');
  ok('  position and known-for from the lookup', recP.position === 'Defender' && recP.stats === 'Homegrown signing' && recP.tags.includes('sneakers'));
  const recG = RI.recordFor(P('Caleb Manuel'), 'agent-1', 'ath-3');
  ok('pro golfer: city, no team, the affiliation in notes', recG.city === 'Portland, ME' && recG.team === '' && /Professional Golfer\./.test(recG.notes));
  ok('  both Instagram handles and both counts kept', recG.instagramHandle === 'calebmanuel59' && recG.instagramHandleAlt === 'calebgolf59' && recG.instagram === 3612 && recG.instagramAlt === 1034);
  const recE = RI.recordFor(P('Emma Boulanger'), 'agent-1', 'ath-4');
  ok('the second sport is in notes', /Also plays softball\./.test(recE.notes));
  const formKeys = ['name', 'sport', 'position', 'athleteType', 'school', 'schoolTier', 'city', 'team', 'instagram', 'tiktok', 'engagement', 'notes', 'year', 'stats', 'hometown', 'dob', 'over18', 'schoolRestrictions', 'tags', 'productWants', 'instagramHandle', 'brandRestrictions', 'igStatsSource', 'igStatsFetchedAt', 'createdAt'];
  ok('every field the form saves is present', formKeys.every((k) => k in recC), formKeys.filter((k) => !(k in recC)));

  // ── 7. THE SCRIPT ────────────────────────────────────────────────────────
  OUT.push('', '-- the script --');
  const src = fs.readFileSync(REPO + 'scripts/import-roster.js', 'utf8');
  ok('dry run unless --commit', /const commit = flag\('commit'\)/.test(src) && /if \(!commit\) \{[\s\S]*?nothing written/.test(src));
  ok('a commit stamps last_login, so the nightly skip lifts', /UPDATE users SET last_login = NOW\(\) WHERE id = \$1/.test(src));
  ok('  and fills each new athlete on demand, one at a time', /job\.fillOnDemand\(P, aths\[0\]\)/.test(src) && /loadAthletesForQueue\(P, u\.id, c\.id\)/.test(src));
  ok('  through saveAthlete, like the form', /store\.saveAthlete\(id, rec\)/.test(src));
  ok('the seat rule is the server\'s', /function seatLimit\(plan\)/.test(src) && /'599'/.test(src) && /'499'/.test(src));
  const gi = fs.readFileSync(REPO + '.gitignore', 'utf8');
  ok('roster CSVs are ignored by git', /^\*\.csv$/m.test(gi));
  ok('no CSV is committed', !require('child_process').execSync('git ls-files', { cwd: REPO }).toString().split('\n').some((f) => /\.csv$/i.test(f)));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
