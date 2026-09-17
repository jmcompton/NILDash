'use strict';
// ── PRO TEAMS: THE TEAM NAMES A CITY, A LEAGUE AND A SPORT ─────────────────
//
// "Add Bo Nix the QB for the Denver Broncos" names a pro athlete, a team and,
// through the team, the city the local lane works in and the state the
// compliance gate rules on. The assistant used to need the city typed as
// "City, ST" and errored without it. Now the team resolves it.
//
// Major North American leagues, written from memory of the 2025-26 seasons.
// A Canadian team carries its province code where the state goes. A team
// that moved keeps its current city. Nicknames are matched as well as full
// names ("Broncos", "the Nuggets").

const TEAMS = [];
const add = (league, sport, entries) => { for (const [name, city, state] of entries) TEAMS.push({ name, city, state, league, sport }); };

add('NFL', 'football', [
  ['Arizona Cardinals', 'Glendale', 'AZ'], ['Atlanta Falcons', 'Atlanta', 'GA'], ['Baltimore Ravens', 'Baltimore', 'MD'], ['Buffalo Bills', 'Orchard Park', 'NY'],
  ['Carolina Panthers', 'Charlotte', 'NC'], ['Chicago Bears', 'Chicago', 'IL'], ['Cincinnati Bengals', 'Cincinnati', 'OH'], ['Cleveland Browns', 'Cleveland', 'OH'],
  ['Dallas Cowboys', 'Arlington', 'TX'], ['Denver Broncos', 'Denver', 'CO'], ['Detroit Lions', 'Detroit', 'MI'], ['Green Bay Packers', 'Green Bay', 'WI'],
  ['Houston Texans', 'Houston', 'TX'], ['Indianapolis Colts', 'Indianapolis', 'IN'], ['Jacksonville Jaguars', 'Jacksonville', 'FL'], ['Kansas City Chiefs', 'Kansas City', 'MO'],
  ['Las Vegas Raiders', 'Las Vegas', 'NV'], ['Los Angeles Chargers', 'Los Angeles', 'CA'], ['Los Angeles Rams', 'Los Angeles', 'CA'], ['Miami Dolphins', 'Miami Gardens', 'FL'],
  ['Minnesota Vikings', 'Minneapolis', 'MN'], ['New England Patriots', 'Foxborough', 'MA'], ['New Orleans Saints', 'New Orleans', 'LA'], ['New York Giants', 'East Rutherford', 'NJ'],
  ['New York Jets', 'East Rutherford', 'NJ'], ['Philadelphia Eagles', 'Philadelphia', 'PA'], ['Pittsburgh Steelers', 'Pittsburgh', 'PA'], ['San Francisco 49ers', 'Santa Clara', 'CA'],
  ['Seattle Seahawks', 'Seattle', 'WA'], ['Tampa Bay Buccaneers', 'Tampa', 'FL'], ['Tennessee Titans', 'Nashville', 'TN'], ['Washington Commanders', 'Landover', 'MD'],
]);
add('NBA', 'basketball', [
  ['Atlanta Hawks', 'Atlanta', 'GA'], ['Boston Celtics', 'Boston', 'MA'], ['Brooklyn Nets', 'Brooklyn', 'NY'], ['Charlotte Hornets', 'Charlotte', 'NC'],
  ['Chicago Bulls', 'Chicago', 'IL'], ['Cleveland Cavaliers', 'Cleveland', 'OH'], ['Dallas Mavericks', 'Dallas', 'TX'], ['Denver Nuggets', 'Denver', 'CO'],
  ['Detroit Pistons', 'Detroit', 'MI'], ['Golden State Warriors', 'San Francisco', 'CA'], ['Houston Rockets', 'Houston', 'TX'], ['Indiana Pacers', 'Indianapolis', 'IN'],
  ['Los Angeles Clippers', 'Inglewood', 'CA'], ['Los Angeles Lakers', 'Los Angeles', 'CA'], ['Memphis Grizzlies', 'Memphis', 'TN'], ['Miami Heat', 'Miami', 'FL'],
  ['Milwaukee Bucks', 'Milwaukee', 'WI'], ['Minnesota Timberwolves', 'Minneapolis', 'MN'], ['New Orleans Pelicans', 'New Orleans', 'LA'], ['New York Knicks', 'New York', 'NY'],
  ['Oklahoma City Thunder', 'Oklahoma City', 'OK'], ['Orlando Magic', 'Orlando', 'FL'], ['Philadelphia 76ers', 'Philadelphia', 'PA'], ['Phoenix Suns', 'Phoenix', 'AZ'],
  ['Portland Trail Blazers', 'Portland', 'OR'], ['Sacramento Kings', 'Sacramento', 'CA'], ['San Antonio Spurs', 'San Antonio', 'TX'], ['Toronto Raptors', 'Toronto', 'ON'],
  ['Utah Jazz', 'Salt Lake City', 'UT'], ['Washington Wizards', 'Washington', 'DC'],
]);
add('WNBA', 'basketball', [
  ['Atlanta Dream', 'Atlanta', 'GA'], ['Chicago Sky', 'Chicago', 'IL'], ['Connecticut Sun', 'Uncasville', 'CT'], ['Dallas Wings', 'Arlington', 'TX'],
  ['Golden State Valkyries', 'San Francisco', 'CA'], ['Indiana Fever', 'Indianapolis', 'IN'], ['Las Vegas Aces', 'Las Vegas', 'NV'], ['Los Angeles Sparks', 'Los Angeles', 'CA'],
  ['Minnesota Lynx', 'Minneapolis', 'MN'], ['New York Liberty', 'Brooklyn', 'NY'], ['Phoenix Mercury', 'Phoenix', 'AZ'], ['Seattle Storm', 'Seattle', 'WA'], ['Washington Mystics', 'Washington', 'DC'],
]);
add('MLB', 'baseball', [
  ['Arizona Diamondbacks', 'Phoenix', 'AZ'], ['Athletics', 'West Sacramento', 'CA'], ['Atlanta Braves', 'Atlanta', 'GA'], ['Baltimore Orioles', 'Baltimore', 'MD'],
  ['Boston Red Sox', 'Boston', 'MA'], ['Chicago Cubs', 'Chicago', 'IL'], ['Chicago White Sox', 'Chicago', 'IL'], ['Cincinnati Reds', 'Cincinnati', 'OH'],
  ['Cleveland Guardians', 'Cleveland', 'OH'], ['Colorado Rockies', 'Denver', 'CO'], ['Detroit Tigers', 'Detroit', 'MI'], ['Houston Astros', 'Houston', 'TX'],
  ['Kansas City Royals', 'Kansas City', 'MO'], ['Los Angeles Angels', 'Anaheim', 'CA'], ['Los Angeles Dodgers', 'Los Angeles', 'CA'], ['Miami Marlins', 'Miami', 'FL'],
  ['Milwaukee Brewers', 'Milwaukee', 'WI'], ['Minnesota Twins', 'Minneapolis', 'MN'], ['New York Mets', 'New York', 'NY'], ['New York Yankees', 'New York', 'NY'],
  ['Philadelphia Phillies', 'Philadelphia', 'PA'], ['Pittsburgh Pirates', 'Pittsburgh', 'PA'], ['San Diego Padres', 'San Diego', 'CA'], ['San Francisco Giants', 'San Francisco', 'CA'],
  ['Seattle Mariners', 'Seattle', 'WA'], ['St. Louis Cardinals', 'St. Louis', 'MO'], ['Tampa Bay Rays', 'Tampa', 'FL'], ['Texas Rangers', 'Arlington', 'TX'],
  ['Toronto Blue Jays', 'Toronto', 'ON'], ['Washington Nationals', 'Washington', 'DC'],
]);
add('NHL', 'hockey', [
  ['Anaheim Ducks', 'Anaheim', 'CA'], ['Boston Bruins', 'Boston', 'MA'], ['Buffalo Sabres', 'Buffalo', 'NY'], ['Calgary Flames', 'Calgary', 'AB'],
  ['Carolina Hurricanes', 'Raleigh', 'NC'], ['Chicago Blackhawks', 'Chicago', 'IL'], ['Colorado Avalanche', 'Denver', 'CO'], ['Columbus Blue Jackets', 'Columbus', 'OH'],
  ['Dallas Stars', 'Dallas', 'TX'], ['Detroit Red Wings', 'Detroit', 'MI'], ['Edmonton Oilers', 'Edmonton', 'AB'], ['Florida Panthers', 'Sunrise', 'FL'],
  ['Los Angeles Kings', 'Los Angeles', 'CA'], ['Minnesota Wild', 'St. Paul', 'MN'], ['Montreal Canadiens', 'Montreal', 'QC'], ['Nashville Predators', 'Nashville', 'TN'],
  ['New Jersey Devils', 'Newark', 'NJ'], ['New York Islanders', 'Elmont', 'NY'], ['New York Rangers', 'New York', 'NY'], ['Ottawa Senators', 'Ottawa', 'ON'],
  ['Philadelphia Flyers', 'Philadelphia', 'PA'], ['Pittsburgh Penguins', 'Pittsburgh', 'PA'], ['San Jose Sharks', 'San Jose', 'CA'], ['Seattle Kraken', 'Seattle', 'WA'],
  ['St. Louis Blues', 'St. Louis', 'MO'], ['Tampa Bay Lightning', 'Tampa', 'FL'], ['Toronto Maple Leafs', 'Toronto', 'ON'], ['Utah Mammoth', 'Salt Lake City', 'UT'],
  ['Vancouver Canucks', 'Vancouver', 'BC'], ['Vegas Golden Knights', 'Las Vegas', 'NV'], ['Washington Capitals', 'Washington', 'DC'], ['Winnipeg Jets', 'Winnipeg', 'MB'],
]);
add('MLS', 'soccer', [
  ['Atlanta United', 'Atlanta', 'GA'], ['Austin FC', 'Austin', 'TX'], ['Charlotte FC', 'Charlotte', 'NC'], ['Chicago Fire', 'Chicago', 'IL'],
  ['FC Cincinnati', 'Cincinnati', 'OH'], ['Colorado Rapids', 'Commerce City', 'CO'], ['Columbus Crew', 'Columbus', 'OH'], ['FC Dallas', 'Frisco', 'TX'],
  ['D.C. United', 'Washington', 'DC'], ['Houston Dynamo', 'Houston', 'TX'], ['Inter Miami', 'Fort Lauderdale', 'FL'], ['LA Galaxy', 'Carson', 'CA'],
  ['Los Angeles FC', 'Los Angeles', 'CA'], ['Minnesota United', 'St. Paul', 'MN'], ['CF Montreal', 'Montreal', 'QC'], ['Nashville SC', 'Nashville', 'TN'],
  ['New England Revolution', 'Foxborough', 'MA'], ['New York City FC', 'New York', 'NY'], ['New York Red Bulls', 'Harrison', 'NJ'], ['Orlando City', 'Orlando', 'FL'],
  ['Philadelphia Union', 'Chester', 'PA'], ['Portland Timbers', 'Portland', 'OR'], ['Real Salt Lake', 'Sandy', 'UT'], ['San Diego FC', 'San Diego', 'CA'],
  ['San Jose Earthquakes', 'San Jose', 'CA'], ['Seattle Sounders', 'Seattle', 'WA'], ['Sporting Kansas City', 'Kansas City', 'KS'], ['St. Louis City SC', 'St. Louis', 'MO'],
  ['Toronto FC', 'Toronto', 'ON'], ['Vancouver Whitecaps', 'Vancouver', 'BC'],
]);

const fold = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim();
// The nickname: the last word, or the last two for "Trail Blazers", "Red Sox",
// "White Sox", "Blue Jays", "Maple Leafs", "Golden Knights", "Red Wings", "Blue Jackets", "Red Bulls", "City FC".
const NICK_TWO = new Set(['trail blazers', 'red sox', 'white sox', 'blue jays', 'maple leafs', 'golden knights', 'red wings', 'blue jackets', 'red bulls', 'golden state', 'city fc', 'city sc', 'salt lake']);
function nickOf(name) {
  const w = fold(name).split(' ');
  const two = w.slice(-2).join(' ');
  if (NICK_TWO.has(two)) return two;
  return w[w.length - 1];
}
const INDEX = TEAMS.map((t) => ({ ...t, key: fold(t.name), nick: nickOf(t.name), cityKey: fold(t.city) }));

// The team a piece of text names, or null. A full name wins; a nickname alone
// ("Broncos") is accepted when only one team carries it; "Denver Nuggets" and
// "the Nuggets" both resolve. Returns { name, city, state, league, sport, market }.
// Nicknames that are ordinary words a school or a town could carry ("Union
// College", "Kansas City", "Sun Belt"): only the full team name matches them.
const GENERIC_NICK = new Set(['city', 'united', 'fc', 'sc', 'crew', 'fire', 'union', 'sun', 'sky', 'dream', 'wings', 'storm', 'magic', 'heat', 'jazz', 'wild', 'lightning', 'revolution', 'athletics', 'stars', 'kings', 'giants', 'rangers', 'panthers', 'cardinals', 'jets', 'nationals', 'liberty', 'mystics', 'fever', 'aces', 'sparks', 'lynx', 'mercury', 'valkyries', 'dynamo', 'galaxy', 'timbers', 'sounders', 'earthquakes', 'rapids', 'whitecaps']);
function findTeam(text) {
  const f = fold(text);
  if (!f || f.length < 3) return null;
  // A school is never a team, whatever word it shares with one.
  if (/\b(college|university|univ|high school|high|academy|prep|school|institute)\b/.test(f)) return null;
  const hit = (t) => ({ name: t.name, city: t.city, state: t.state, league: t.league, sport: t.sport, market: `${t.city}, ${t.state}` });
  const exact = INDEX.find((t) => t.key === f);
  if (exact) return hit(exact);
  // "Denver Broncos QB", "for the Denver Broncos": the full name inside the text.
  const inside = INDEX.filter((t) => new RegExp('(^| )' + t.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(f));
  if (inside.length === 1) return hit(inside[0]);
  if (inside.length > 1) return hit(inside.sort((a, b) => b.key.length - a.key.length)[0]);
  // A nickname on its own, or with a city word: "Broncos", "Nuggets", "LA Rams".
  const words = f.split(' ');
  const byNick = INDEX.filter((t) => t.nick.split(' ').every((n) => words.includes(n)) && (t.nick.split(' ').length > 1 || t.nick.length > 3) && !GENERIC_NICK.has(t.nick));
  if (byNick.length === 1) return hit(byNick[0]);
  if (byNick.length > 1) {
    const withCity = byNick.filter((t) => t.cityKey.split(' ').some((c) => c.length > 2 && words.includes(c)));
    if (withCity.length === 1) return hit(withCity[0]);
  }
  return null;
}
function isProTeam(text) { return !!findTeam(text); }

module.exports = { TEAMS, findTeam, isProTeam, nickOf };
