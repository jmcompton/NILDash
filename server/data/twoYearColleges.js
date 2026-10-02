'use strict';
// ── TWO-YEAR COLLEGES (JUNIOR AND COMMUNITY COLLEGES) ───────────────────────
//
// What services/athleteTier reads to know a school is a junior college when
// its name does not say so ("Cypress College", "Blinn College"). An athlete at
// one is low tier: local businesses only, never a national brand.
//
// PROVENANCE. Written from knowledge of the CCCAA (California) and NJCAA
// membership, not fetched: the build box reaches neither cccaasports.org nor
// njcaa.org. It is a list of names that ARE two-year schools; it does not
// claim to be every one. A school on no list at all is not assumed to be
// Division I -- athleteTier treats an unconfirmed level as low tier until it
// is confirmed (an athlete's `division` field, or a list). To add a school:
// its name as athletes' records spell it, one per line.
const CCCAA = [
  'Allan Hancock College', 'American River College', 'Antelope Valley College', 'Bakersfield College', 'Barstow Community College',
  'Butte College', 'Cabrillo College', 'Canada College', 'College of the Canyons', 'Cerritos College', 'Cerro Coso Community College',
  'Chabot College', 'Chaffey College', 'Citrus College', 'City College of San Francisco', 'West Hills College Coalinga',
  'Compton College', 'Contra Costa College', 'Copper Mountain College', 'Cosumnes River College', 'Cuesta College', 'Cuyamaca College',
  'Cypress College', 'De Anza College', 'College of the Desert', 'Diablo Valley College', 'East Los Angeles College', 'El Camino College',
  'Evergreen Valley College', 'Feather River College', 'Folsom Lake College', 'Foothill College', 'Fresno City College',
  'Fullerton College', 'Gavilan College', 'Glendale Community College', 'Golden West College', 'Grossmont College', 'Hartnell College',
  'Imperial Valley College', 'Irvine Valley College', 'Laney College', 'Lassen Community College', 'Long Beach City College',
  'Los Angeles City College', 'Los Angeles Harbor College', 'Los Angeles Mission College', 'Los Angeles Pierce College',
  'Los Angeles Southwest College', 'Los Angeles Trade-Technical College', 'Los Angeles Valley College', 'Los Medanos College',
  'College of Marin', 'Mendocino College', 'Merced College', 'MiraCosta College', 'Mission College', 'Modesto Junior College',
  'Monterey Peninsula College', 'Moorpark College', 'Moreno Valley College', 'Mt. San Antonio College', 'Mt. San Jacinto College',
  'Napa Valley College', 'Norco College', 'Ohlone College', 'Orange Coast College', 'Oxnard College', 'Palo Verde College',
  'Palomar College', 'Pasadena City College', 'Porterville College', 'College of the Redwoods', 'Reedley College', 'Rio Hondo College',
  'Riverside City College', 'Sacramento City College', 'Saddleback College', 'San Bernardino Valley College', 'San Diego City College',
  'San Diego Mesa College', 'San Diego Miramar College', 'San Joaquin Delta College', 'San Jose City College', 'College of San Mateo',
  'Santa Ana College', 'Santa Barbara City College', 'Santa Monica College', 'Santa Rosa Junior College', 'Santiago Canyon College',
  'College of the Sequoias', 'Shasta College', 'Sierra College', 'College of the Siskiyous', 'Skyline College', 'Solano Community College',
  'Southwestern College', 'Taft College', 'Ventura College', 'Victor Valley College', 'West Hills College Lemoore',
  'West Los Angeles College', 'West Valley College', 'Yuba College',
];
const NJCAA = [
  'Blinn College', 'Navarro College', 'Tyler Junior College', 'Kilgore College', 'Trinity Valley Community College', 'Cisco College',
  'Ranger College', 'Grayson College', 'Panola College', 'Angelina College', 'Odessa College', 'Midland College', 'Western Texas College',
  'South Plains College', 'Howard College', 'Frank Phillips College', 'Clarendon College', 'Hill College', 'Paris Junior College',
  'Hutchinson Community College', 'Butler Community College', 'Garden City Community College', 'Coffeyville Community College',
  'Independence Community College', 'Dodge City Community College', 'Fort Scott Community College', 'Highland Community College',
  'Iowa Western Community College', 'Ellsworth Community College', 'Iowa Central Community College', 'Indian Hills Community College',
  'Kirkwood Community College', 'Des Moines Area Community College', 'Northwest Mississippi Community College',
  'East Mississippi Community College', 'Jones College', 'Copiah-Lincoln Community College', 'Hinds Community College',
  'Mississippi Gulf Coast Community College', 'Pearl River Community College', 'Itawamba Community College', 'Holmes Community College',
  'Coahoma Community College', 'Snow College', 'Salt Lake Community College', 'College of Southern Idaho', 'College of Southern Nevada',
  'Arizona Western College', 'Eastern Arizona College', 'Mesa Community College', 'Scottsdale Community College', 'Pima Community College',
  'Central Arizona College', 'Phoenix College', 'Chipola College', 'Northwest Florida State College', 'Gulf Coast State College',
  'Tallahassee Community College', 'Santa Fe College', 'Pensacola State College', 'Indian River State College',
  'Georgia Military College', 'East Georgia State College', 'South Georgia State College', 'Chattahoochee Valley Community College',
  'Wallace State Community College', 'Calhoun Community College', 'Northeastern Oklahoma A&M College', 'Connors State College',
  'Murray State College', 'Seminole State College', 'Northern Oklahoma College', 'Crowder College', 'State Fair Community College',
  'Mineral Area College', 'Moberly Area Community College', 'Three Rivers College', 'Western Nebraska Community College',
  'Northeast Community College', 'Lackawanna College', 'Monroe College', 'Nassau Community College', 'Hudson Valley Community College',
  'Lake Land College', 'John A. Logan College', 'Southeastern Illinois College', 'Rend Lake College', 'Kaskaskia College',
  'Vincennes University', 'Jefferson College', 'Walters State Community College', 'Cleveland State Community College',
  'Motlow State Community College', 'Louisburg College', 'Tidewater Community College',
];
module.exports = { TWO_YEAR: CCCAA.concat(NJCAA), CCCAA, NJCAA };
