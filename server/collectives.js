// Real NIL collective budget estimates — compiled from public reporting
// Sources: On3, NIL Network, Sports Illustrated, 2026 estimates

// Sport allocation percentages — how much of collective budget goes to each sport
// Based on reported data from On3, NIL Network, Sports Illustrated 2025-26
const SPORT_ALLOCATION = {
  // Format: school_abbr: { basketball: 0.X, football: 0.X, other: 0.X }
  // P4 basketball-first programs
  'Kentucky':      { basketball: 0.55, football: 0.35, other: 0.10 },
  'Duke':          { basketball: 0.60, football: 0.30, other: 0.10 },
  'Kansas':        { basketball: 0.55, football: 0.35, other: 0.10 },
  'UNC':           { basketball: 0.50, football: 0.38, other: 0.12 },
  'Indiana':       { basketball: 0.52, football: 0.38, other: 0.10 },
  'Michigan State':{ basketball: 0.45, football: 0.45, other: 0.10 },
  // P4 football-first programs
  'Alabama':       { basketball: 0.20, football: 0.68, other: 0.12 },
  'Georgia':       { basketball: 0.22, football: 0.65, other: 0.13 },
  'Ohio State':    { basketball: 0.25, football: 0.63, other: 0.12 },
  'Texas':         { basketball: 0.22, football: 0.66, other: 0.12 },
  'LSU':           { basketball: 0.28, football: 0.58, other: 0.14 },
  'Michigan':      { basketball: 0.25, football: 0.62, other: 0.13 },
  'Oregon':        { basketball: 0.25, football: 0.62, other: 0.13 },
  'USC':           { basketball: 0.28, football: 0.58, other: 0.14 },
  'Clemson':       { basketball: 0.22, football: 0.65, other: 0.13 },
  'Florida':       { basketball: 0.30, football: 0.58, other: 0.12 },
  'Tennessee':     { basketball: 0.32, football: 0.55, other: 0.13 },
  'Auburn':        { basketball: 0.25, football: 0.62, other: 0.13 },
  'Texas A&M':     { basketball: 0.20, football: 0.68, other: 0.12 },
  'Oklahoma':      { basketball: 0.25, football: 0.62, other: 0.13 },
  'Florida State': { basketball: 0.25, football: 0.62, other: 0.13 },
  'Miami':         { basketball: 0.30, football: 0.55, other: 0.15 },
  'Colorado':      { basketball: 0.30, football: 0.57, other: 0.13 },
  'UCLA':          { basketball: 0.38, football: 0.48, other: 0.14 },
  'Washington':    { basketball: 0.30, football: 0.57, other: 0.13 },
  // Default allocation
  'default':       { basketball: 0.35, football: 0.52, other: 0.13 },
};

function getSportBudget(collective, sport) {
  const alloc = SPORT_ALLOCATION[collective.abbr] || SPORT_ALLOCATION['default'];
  const sp = (sport || '').toLowerCase();
  let pct = alloc.other / 2; // default
  if (sp.includes('basketball') || sp.includes('womens basketball')) pct = alloc.basketball;
  else if (sp.includes('football')) pct = alloc.football;
  else pct = alloc.other;
  return {
    low: Math.round(collective.nilLow * pct),
    high: Math.round(collective.nilHigh * pct)
  };
}

const COLLECTIVES = [
  // SEC
  { school: "University of Alabama", abbr: "Alabama", conf: "SEC", market: "Tuscaloosa", nilLow: 10000000, nilHigh: 13000000, strength: "Elite", proExposure: "Very High" },
  { school: "University of Georgia", abbr: "Georgia", conf: "SEC", market: "Athens", nilLow: 9000000, nilHigh: 12000000, strength: "Elite", proExposure: "Very High" },
  { school: "LSU", abbr: "LSU", conf: "SEC", market: "Baton Rouge", nilLow: 8000000, nilHigh: 11000000, strength: "Elite", proExposure: "Very High" },
  { school: "University of Texas", abbr: "Texas", conf: "SEC", market: "Austin", nilLow: 9000000, nilHigh: 14000000, strength: "Elite", proExposure: "Very High" },
  { school: "Texas A&M University", abbr: "Texas A&M", conf: "SEC", market: "College Station", nilLow: 7000000, nilHigh: 10000000, strength: "Elite", proExposure: "Very High" },
  { school: "University of Florida", abbr: "Florida", conf: "SEC", market: "Gainesville", nilLow: 6000000, nilHigh: 9000000, strength: "Strong", proExposure: "Very High" },
  { school: "University of Tennessee", abbr: "Tennessee", conf: "SEC", market: "Knoxville", nilLow: 6000000, nilHigh: 9000000, strength: "Strong", proExposure: "High" },
  { school: "Auburn University", abbr: "Auburn", conf: "SEC", market: "Auburn", nilLow: 5000000, nilHigh: 8000000, strength: "Strong", proExposure: "High" },
  { school: "University of Oklahoma", abbr: "Oklahoma", conf: "SEC", market: "Norman", nilLow: 5000000, nilHigh: 7000000, strength: "Strong", proExposure: "High" },
  { school: "University of Arkansas", abbr: "Arkansas", conf: "SEC", market: "Fayetteville", nilLow: 4000000, nilHigh: 6000000, strength: "Solid", proExposure: "High" },
  { school: "University of Mississippi", abbr: "Ole Miss", conf: "SEC", market: "Oxford", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  { school: "Mississippi State University", abbr: "Mississippi State", conf: "SEC", market: "Starkville", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "University of South Carolina", abbr: "South Carolina", conf: "SEC", market: "Columbia", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  { school: "Vanderbilt University", abbr: "Vanderbilt", conf: "SEC", market: "Nashville", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "University of Kentucky", abbr: "Kentucky", conf: "SEC", market: "Lexington", nilLow: 4000000, nilHigh: 6000000, strength: "Solid", proExposure: "High" },
  { school: "University of Missouri", abbr: "Missouri", conf: "SEC", market: "Columbia", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  // Big Ten
  { school: "Ohio State University", abbr: "Ohio State", conf: "Big Ten", market: "Columbus", nilLow: 10000000, nilHigh: 15000000, strength: "Elite", proExposure: "Very High" },
  { school: "University of Michigan", abbr: "Michigan", conf: "Big Ten", market: "Ann Arbor", nilLow: 7000000, nilHigh: 10000000, strength: "Elite", proExposure: "Very High" },
  { school: "University of Oregon", abbr: "Oregon", conf: "Big Ten", market: "Eugene", nilLow: 8000000, nilHigh: 12000000, strength: "Elite", proExposure: "Very High" },
  { school: "USC", abbr: "USC", conf: "Big Ten", market: "Los Angeles", nilLow: 8000000, nilHigh: 12000000, strength: "Elite", proExposure: "Very High" },
  { school: "UCLA", abbr: "UCLA", conf: "Big Ten", market: "Los Angeles", nilLow: 6000000, nilHigh: 10000000, strength: "Elite", proExposure: "Very High" },
  { school: "Penn State University", abbr: "Penn State", conf: "Big Ten", market: "State College", nilLow: 5000000, nilHigh: 8000000, strength: "Strong", proExposure: "High" },
  { school: "University of Wisconsin", abbr: "Wisconsin", conf: "Big Ten", market: "Madison", nilLow: 4000000, nilHigh: 6000000, strength: "Solid", proExposure: "High" },
  { school: "University of Nebraska", abbr: "Nebraska", conf: "Big Ten", market: "Lincoln", nilLow: 4000000, nilHigh: 7000000, strength: "Solid", proExposure: "High" },
  { school: "University of Iowa", abbr: "Iowa", conf: "Big Ten", market: "Iowa City", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "Michigan State University", abbr: "Michigan State", conf: "Big Ten", market: "East Lansing", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "University of Minnesota", abbr: "Minnesota", conf: "Big Ten", market: "Minneapolis", nilLow: 3000000, nilHigh: 5000000, strength: "Developing", proExposure: "Medium" },
  { school: "Indiana University", abbr: "Indiana", conf: "Big Ten", market: "Bloomington", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Purdue University", abbr: "Purdue", conf: "Big Ten", market: "West Lafayette", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Rutgers University", abbr: "Rutgers", conf: "Big Ten", market: "New Brunswick", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "University of Illinois", abbr: "Illinois", conf: "Big Ten", market: "Champaign", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Northwestern University", abbr: "Northwestern", conf: "Big Ten", market: "Chicago", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "University of Maryland", abbr: "Maryland", conf: "Big Ten", market: "College Park", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "High" },
  { school: "Washington", abbr: "Washington", conf: "Big Ten", market: "Seattle", nilLow: 4000000, nilHigh: 7000000, strength: "Strong", proExposure: "High" },
  // ACC
  { school: "Clemson University", abbr: "Clemson", conf: "ACC", market: "Clemson", nilLow: 5000000, nilHigh: 8000000, strength: "Strong", proExposure: "Very High" },
  { school: "University of Miami", abbr: "Miami", conf: "ACC", market: "Miami", nilLow: 6000000, nilHigh: 9000000, strength: "Elite", proExposure: "Very High" },
  { school: "Florida State University", abbr: "Florida State", conf: "ACC", market: "Tallahassee", nilLow: 4000000, nilHigh: 7000000, strength: "Strong", proExposure: "High" },
  { school: "University of North Carolina", abbr: "UNC", conf: "ACC", market: "Chapel Hill", nilLow: 4000000, nilHigh: 6000000, strength: "Strong", proExposure: "High" },
  { school: "Duke University", abbr: "Duke", conf: "ACC", market: "Durham", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "NC State University", abbr: "NC State", conf: "ACC", market: "Raleigh", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  { school: "Georgia Tech", abbr: "Georgia Tech", conf: "ACC", market: "Atlanta", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "Virginia Tech", abbr: "Virginia Tech", conf: "ACC", market: "Blacksburg", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "University of Virginia", abbr: "Virginia", conf: "ACC", market: "Charlottesville", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "University of Louisville", abbr: "Louisville", conf: "ACC", market: "Louisville", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Syracuse University", abbr: "Syracuse", conf: "ACC", market: "Syracuse", nilLow: 2000000, nilHigh: 3000000, strength: "Developing", proExposure: "Medium" },
  { school: "Boston College", abbr: "Boston College", conf: "ACC", market: "Boston", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "University of Pittsburgh", abbr: "Pitt", conf: "ACC", market: "Pittsburgh", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Wake Forest University", abbr: "Wake Forest", conf: "ACC", market: "Winston-Salem", nilLow: 1500000, nilHigh: 3000000, strength: "Developing", proExposure: "Low" },
  // Big 12
  { school: "University of Kansas", abbr: "Kansas", conf: "Big 12", market: "Lawrence", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "Baylor University", abbr: "Baylor", conf: "Big 12", market: "Waco", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  { school: "TCU", abbr: "TCU", conf: "Big 12", market: "Fort Worth", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "University of Utah", abbr: "Utah", conf: "Big 12", market: "Salt Lake City", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  { school: "Arizona State University", abbr: "Arizona State", conf: "Big 12", market: "Tempe", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "University of Arizona", abbr: "Arizona", conf: "Big 12", market: "Tucson", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Colorado", abbr: "Colorado", conf: "Big 12", market: "Boulder", nilLow: 4000000, nilHigh: 7000000, strength: "Strong", proExposure: "High" },
  { school: "BYU", abbr: "BYU", conf: "Big 12", market: "Provo", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "West Virginia University", abbr: "West Virginia", conf: "Big 12", market: "Morgantown", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Iowa State University", abbr: "Iowa State", conf: "Big 12", market: "Ames", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  { school: "Kansas State University", abbr: "Kansas State", conf: "Big 12", market: "Manhattan", nilLow: 2000000, nilHigh: 3000000, strength: "Developing", proExposure: "Medium" },
  { school: "Oklahoma State University", abbr: "Oklahoma State", conf: "Big 12", market: "Stillwater", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  { school: "Texas Tech University", abbr: "Texas Tech", conf: "Big 12", market: "Lubbock", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  { school: "University of Houston", abbr: "Houston", conf: "Big 12", market: "Houston", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "University of Cincinnati", abbr: "Cincinnati", conf: "Big 12", market: "Cincinnati", nilLow: 2000000, nilHigh: 3000000, strength: "Developing", proExposure: "Medium" },
  { school: "UCF", abbr: "UCF", conf: "Big 12", market: "Orlando", nilLow: 2000000, nilHigh: 4000000, strength: "Developing", proExposure: "Medium" },
  // Other notable
  { school: "University of Notre Dame", abbr: "Notre Dame", conf: "Independent", market: "South Bend", nilLow: 6000000, nilHigh: 9000000, strength: "Elite", proExposure: "Very High" },
  { school: "University of Memphis", abbr: "Memphis", conf: "AAC", market: "Memphis", nilLow: 1500000, nilHigh: 3000000, strength: "Developing", proExposure: "Medium" },
  { school: "University of Tulsa", abbr: "Tulsa", conf: "AAC", market: "Tulsa", nilLow: 500000, nilHigh: 1500000, strength: "Limited", proExposure: "Low" },
  { school: "SMU", abbr: "SMU", conf: "ACC", market: "Dallas", nilLow: 3000000, nilHigh: 5000000, strength: "Solid", proExposure: "High" },
  { school: "University of South Florida", abbr: "USF", conf: "AAC", market: "Tampa", nilLow: 1000000, nilHigh: 2000000, strength: "Developing", proExposure: "Medium" },
  { school: "App State", abbr: "App State", conf: "Sun Belt", market: "Boone", nilLow: 300000, nilHigh: 800000, strength: "Limited", proExposure: "Low" },
  { school: "James Madison University", abbr: "JMU", conf: "Sun Belt", market: "Harrisonburg", nilLow: 300000, nilHigh: 700000, strength: "Limited", proExposure: "Low" },
  { school: "University of Nevada Las Vegas", abbr: "UNLV", conf: "Mountain West", market: "Las Vegas", nilLow: 1500000, nilHigh: 3000000, strength: "Developing", proExposure: "Medium" },
  { school: "Boise State University", abbr: "Boise State", conf: "Mountain West", market: "Boise", nilLow: 1000000, nilHigh: 2000000, strength: "Developing", proExposure: "Medium" },
  { school: "University of New Mexico", abbr: "New Mexico", conf: "Mountain West", market: "Albuquerque", nilLow: 500000, nilHigh: 1000000, strength: "Limited", proExposure: "Low" },
  { school: "Air Force Academy", abbr: "Air Force", conf: "Mountain West", market: "Colorado Springs", nilLow: 200000, nilHigh: 500000, strength: "Limited", proExposure: "Low" },
  { school: "Liberty University", abbr: "Liberty", conf: "CUSA", market: "Lynchburg", nilLow: 500000, nilHigh: 1500000, strength: "Developing", proExposure: "Low" },
];

// Conference NIL range estimates for schools not in the above list
const CONF_ESTIMATES = {
  "SEC": { nilLow: 3000000, nilHigh: 8000000, strength: "Strong", proExposure: "High" },
  "Big Ten": { nilLow: 3000000, nilHigh: 7000000, strength: "Strong", proExposure: "High" },
  "ACC": { nilLow: 2000000, nilHigh: 6000000, strength: "Solid", proExposure: "High" },
  "Big 12": { nilLow: 2000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  "AAC": { nilLow: 500000, nilHigh: 2000000, strength: "Developing", proExposure: "Medium" },
  "Mountain West": { nilLow: 500000, nilHigh: 1500000, strength: "Developing", proExposure: "Low" },
  "Sun Belt": { nilLow: 200000, nilHigh: 800000, strength: "Limited", proExposure: "Low" },
  "MAC": { nilLow: 100000, nilHigh: 500000, strength: "Limited", proExposure: "Low" },
  "CUSA": { nilLow: 200000, nilHigh: 700000, strength: "Limited", proExposure: "Low" },
  "Independent": { nilLow: 1000000, nilHigh: 5000000, strength: "Solid", proExposure: "Medium" },
  "FCS": { nilLow: 50000, nilHigh: 300000, strength: "Minimal", proExposure: "Very Low" },
};

module.exports = { COLLECTIVES, CONF_ESTIMATES, getSportBudget };
