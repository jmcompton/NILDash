'use strict';
// ── NCAA DIVISION II, DIVISION III AND NAIA SCHOOLS, WITH THEIR TOWNS ────────
//
// The shipped school map (ai.js) and services/schoolResolver's curated list
// carried Division I and not much else, so a Division II athlete's school
// ("Western New Mexico University") did not resolve at the keyboard and the
// suggestions offered were the nearest-looking D1 names. Every entry here
// becomes part of the resolver's curated list.
//
// FORMAT. One string per school: "Name | City | ST". A school whose bare name
// is shared with another school carries its state in parentheses in the
// name ("Bethel University (Tennessee)"): the resolver reads the parenthetical
// as the state, offers both when the agent typed the bare name, and never
// picks one for them.
//
// PROVENANCE. Written from memory of the 2025-26 membership lists, not
// fetched: the build box reaches neither ncaa.org nor naia.org. A wrong town
// here sends the local lane to the wrong town, so the list was written to be
// omitted rather than guessed where a town was uncertain, and
// scripts/audit-schools.js --verify-map geocodes every entry (services/
// schoolGeocode) and prints the ones whose geocoded town disagrees. Run it
// once from the Mac, fix what it names, and the list is verified.

const D2 = [
  // California Collegiate Athletic Association
  'California State University, Chico | Chico | CA', 'California State University, Dominguez Hills | Carson | CA',
  'California State University, East Bay | Hayward | CA', 'California State University, Los Angeles | Los Angeles | CA',
  'California State University, Monterey Bay | Seaside | CA', 'California State University, San Bernardino | San Bernardino | CA',
  'California State University San Marcos | San Marcos | CA', 'California State Polytechnic University, Humboldt | Arcata | CA',
  'California State Polytechnic University, Pomona | Pomona | CA', 'San Francisco State University | San Francisco | CA',
  'Sonoma State University | Rohnert Park | CA', 'Stanislaus State University | Turlock | CA', 'University of California, San Diego | La Jolla | CA',
  // Central Intercollegiate Athletic Association
  'Bluefield State University | Bluefield | WV', 'Bowie State University | Bowie | MD', 'Claflin University | Orangeburg | SC',
  'Elizabeth City State University | Elizabeth City | NC', 'Fayetteville State University | Fayetteville | NC',
  'Johnson C. Smith University | Charlotte | NC', 'Lincoln University (Pennsylvania) | Lincoln University | PA',
  'Livingstone College | Salisbury | NC', 'Shaw University | Raleigh | NC', 'Saint Augustine\'s University | Raleigh | NC',
  'Virginia State University | Petersburg | VA', 'Virginia Union University | Richmond | VA', 'Winston-Salem State University | Winston-Salem | NC',
  // Conference Carolinas
  'Barton College | Wilson | NC', 'Belmont Abbey College | Belmont | NC', 'Chowan University | Murfreesboro | NC',
  'Converse University | Spartanburg | SC', 'Emmanuel University | Franklin Springs | GA', 'Erskine College | Due West | SC',
  'Francis Marion University | Florence | SC', 'King University | Bristol | TN', 'Lees-McRae College | Banner Elk | NC',
  'University of Mount Olive | Mount Olive | NC', 'North Greenville University | Tigerville | SC', 'Southern Wesleyan University | Central | SC',
  // East Coast Conference
  'Daemen University | Amherst | NY', 'Dominican University New York | Orangeburg | NY', 'D\'Youville University | Buffalo | NY',
  'Mercy University | Dobbs Ferry | NY', 'Molloy University | Rockville Centre | NY', 'Roberts Wesleyan University | Rochester | NY',
  'St. Thomas Aquinas College | Sparkill | NY', 'Staten Island (CUNY) | Staten Island | NY', 'University of the District of Columbia | Washington | DC',
  // Great Midwest Athletic Conference
  'Ashland University | Ashland | OH', 'Cedarville University | Cedarville | OH', 'University of Findlay | Findlay | OH',
  'Hillsdale College | Hillsdale | MI', 'Kentucky Wesleyan College | Owensboro | KY', 'Lake Erie College | Painesville | OH',
  'Malone University | Canton | OH', 'Northwood University | Midland | MI', 'Ohio Dominican University | Columbus | OH',
  'Thomas More University | Crestview Hills | KY', 'Tiffin University | Tiffin | OH', 'Trevecca Nazarene University | Nashville | TN',
  'Walsh University | North Canton | OH',
  // Great American Conference
  'Arkansas Tech University | Russellville | AR', 'East Central University | Ada | OK', 'Harding University | Searcy | AR',
  'Henderson State University | Arkadelphia | AR', 'Northwestern Oklahoma State University | Alva | OK', 'Oklahoma Baptist University | Shawnee | OK',
  'Ouachita Baptist University | Arkadelphia | AR', 'Southeastern Oklahoma State University | Durant | OK', 'Southern Arkansas University | Magnolia | AR',
  'Southern Nazarene University | Bethany | OK', 'Southwestern Oklahoma State University | Weatherford | OK', 'University of Arkansas at Monticello | Monticello | AR',
  // Great Lakes Intercollegiate Athletic Conference
  'Davenport University | Grand Rapids | MI', 'Ferris State University | Big Rapids | MI', 'Grand Valley State University | Allendale | MI',
  'Lake Superior State University | Sault Ste. Marie | MI', 'Michigan Technological University | Houghton | MI', 'Northern Michigan University | Marquette | MI',
  'Purdue University Northwest | Hammond | IN', 'Roosevelt University | Chicago | IL', 'Saginaw Valley State University | University Center | MI',
  'Wayne State University (Michigan) | Detroit | MI', 'Wisconsin-Parkside | Kenosha | WI',
  // Great Lakes Valley Conference
  'Drury University | Springfield | MO', 'University of Illinois Springfield | Springfield | IL', 'University of Indianapolis | Indianapolis | IN',
  'Lewis University | Romeoville | IL', 'Lindenwood University | St. Charles | MO', 'Maryville University | St. Louis | MO',
  'McKendree University | Lebanon | IL', 'Missouri University of Science and Technology | Rolla | MO', 'University of Missouri-St. Louis | St. Louis | MO',
  'Quincy University | Quincy | IL', 'Rockhurst University | Kansas City | MO', 'Southwest Baptist University | Bolivar | MO',
  'Truman State University | Kirksville | MO', 'Upper Iowa University | Fayette | IA', 'William Jewell College | Liberty | MO',
  // Great Northwest Athletic Conference
  'University of Alaska Anchorage | Anchorage | AK', 'University of Alaska Fairbanks | Fairbanks | AK', 'Central Washington University | Ellensburg | WA',
  'Montana State University Billings | Billings | MT', 'Northwest Nazarene University | Nampa | ID', 'Saint Martin\'s University | Lacey | WA',
  'Simon Fraser University | Burnaby | BC', 'Western Oregon University | Monmouth | OR', 'Western Washington University | Bellingham | WA',
  // Gulf South Conference
  'University of Alabama in Huntsville | Huntsville | AL', 'Auburn University at Montgomery | Montgomery | AL', 'Christian Brothers University | Memphis | TN',
  'Delta State University | Cleveland | MS', 'Lee University | Cleveland | TN', 'Mississippi College | Clinton | MS',
  'University of Montevallo | Montevallo | AL', 'Shorter University | Rome | GA', 'Union University | Jackson | TN',
  'Valdosta State University | Valdosta | GA', 'University of West Alabama | Livingston | AL', 'West Florida | Pensacola | FL',
  'University of West Georgia | Carrollton | GA',
  // Lone Star Conference
  'Angelo State University | San Angelo | TX', 'Cameron University | Lawton | OK', 'Dallas Baptist University | Dallas | TX',
  'Eastern New Mexico University | Portales | NM', 'Lubbock Christian University | Lubbock | TX', 'Midwestern State University | Wichita Falls | TX',
  'Oklahoma Christian University | Edmond | OK', 'St. Edward\'s University | Austin | TX', 'St. Mary\'s University (Texas) | San Antonio | TX',
  'Sul Ross State University | Alpine | TX', 'Texas A&M International University | Laredo | TX', 'Texas A&M University-Commerce | Commerce | TX',
  'Texas A&M University-Kingsville | Kingsville | TX', 'Texas Woman\'s University | Denton | TX', 'University of Texas at Tyler | Tyler | TX',
  'University of Texas of the Permian Basin | Odessa | TX', 'West Texas A&M University | Canyon | TX', 'Western New Mexico University | Silver City | NM',
  // Mountain East Conference
  'University of Charleston | Charleston | WV', 'Concord University | Athens | WV', 'Davis & Elkins College | Elkins | WV',
  'Fairmont State University | Fairmont | WV', 'Frostburg State University | Frostburg | MD', 'Glenville State University | Glenville | WV',
  'West Liberty University | West Liberty | WV', 'West Virginia State University | Institute | WV',
  'West Virginia Wesleyan College | Buckhannon | WV', 'Wheeling University | Wheeling | WV',
  // Mid-America Intercollegiate Athletics Association
  'University of Central Missouri | Warrensburg | MO', 'University of Central Oklahoma | Edmond | OK', 'Emporia State University | Emporia | KS',
  'Fort Hays State University | Hays | KS', 'Lincoln University (Missouri) | Jefferson City | MO', 'Missouri Southern State University | Joplin | MO',
  'Missouri Western State University | St. Joseph | MO', 'University of Nebraska at Kearney | Kearney | NE', 'Newman University | Wichita | KS',
  'Northeastern State University | Tahlequah | OK', 'Northwest Missouri State University | Maryville | MO', 'Pittsburg State University | Pittsburg | KS',
  'Rogers State University | Claremore | OK', 'Washburn University | Topeka | KS',
  // Northeast-10 Conference
  'Adelphi University | Garden City | NY', 'American International College | Springfield | MA', 'Assumption University | Worcester | MA',
  'Bentley University | Waltham | MA', 'Franklin Pierce University | Rindge | NH', 'University of New Haven | West Haven | CT',
  'Pace University | Pleasantville | NY', 'Saint Anselm College | Manchester | NH', 'Saint Michael\'s College | Colchester | VT',
  'Southern Connecticut State University | New Haven | CT', 'Southern New Hampshire University | Manchester | NH',
  // Northern Sun Intercollegiate Conference
  'Augustana University | Sioux Falls | SD', 'Bemidji State University | Bemidji | MN', 'Concordia University, St. Paul | St. Paul | MN',
  'Minnesota State University, Mankato | Mankato | MN', 'Minnesota State University Moorhead | Moorhead | MN', 'University of Minnesota Crookston | Crookston | MN',
  'University of Minnesota Duluth | Duluth | MN', 'Northern State University | Aberdeen | SD', 'University of Mary | Bismarck | ND',
  'St. Cloud State University | St. Cloud | MN', 'University of Sioux Falls | Sioux Falls | SD', 'Southwest Minnesota State University | Marshall | MN',
  'Wayne State College | Wayne | NE', 'Winona State University | Winona | MN', 'Minot State University | Minot | ND',
  // PacWest Conference
  'Academy of Art University | San Francisco | CA', 'Azusa Pacific University | Azusa | CA', 'Biola University | La Mirada | CA',
  'Chaminade University | Honolulu | HI', 'Concordia University Irvine | Irvine | CA', 'Dominican University of California | San Rafael | CA',
  'Fresno Pacific University | Fresno | CA', 'University of Hawaii at Hilo | Hilo | HI', 'Hawaii Pacific University | Honolulu | HI',
  'Jessup University | Rocklin | CA', 'Point Loma Nazarene University | San Diego | CA', 'Vanguard University | Costa Mesa | CA',
  'Westmont College | Santa Barbara | CA', 'Menlo College | Atherton | CA',
  // Pennsylvania State Athletic Conference
  'Bloomsburg University | Bloomsburg | PA', 'California University of Pennsylvania | California | PA', 'Clarion University | Clarion | PA',
  'East Stroudsburg University | East Stroudsburg | PA', 'Edinboro University | Edinboro | PA', 'Gannon University | Erie | PA',
  'Indiana University of Pennsylvania | Indiana | PA', 'Kutztown University | Kutztown | PA', 'Lock Haven University | Lock Haven | PA',
  'Mansfield University | Mansfield | PA', 'Mercyhurst University | Erie | PA', 'Millersville University | Millersville | PA',
  'Pitt-Johnstown | Johnstown | PA', 'Seton Hill University | Greensburg | PA', 'Shepherd University | Shepherdstown | WV',
  'Shippensburg University | Shippensburg | PA', 'Slippery Rock University | Slippery Rock | PA', 'West Chester University | West Chester | PA',
  // Peach Belt Conference
  'Augusta University | Augusta | GA', 'Clayton State University | Morrow | GA', 'Columbus State University | Columbus | GA',
  'Flagler College | St. Augustine | FL', 'Georgia College & State University | Milledgeville | GA', 'Georgia Southwestern State University | Americus | GA',
  'Lander University | Greenwood | SC', 'University of North Georgia | Dahlonega | GA', 'University of South Carolina Aiken | Aiken | SC',
  'University of South Carolina Beaufort | Bluffton | SC', 'Young Harris College | Young Harris | GA',
  // Rocky Mountain Athletic Conference
  'Adams State University | Alamosa | CO', 'Black Hills State University | Spearfish | SD', 'Chadron State College | Chadron | NE',
  'Colorado Christian University | Lakewood | CO', 'Colorado Mesa University | Grand Junction | CO', 'Colorado School of Mines | Golden | CO',
  'Colorado State University Pueblo | Pueblo | CO', 'Fort Lewis College | Durango | CO', 'MSU Denver | Denver | CO',
  'New Mexico Highlands University | Las Vegas | NM', 'Regis University | Denver | CO', 'South Dakota School of Mines and Technology | Rapid City | SD',
  'University of Colorado Colorado Springs | Colorado Springs | CO', 'Westminster University | Salt Lake City | UT', 'Western Colorado University | Gunnison | CO',
  // South Atlantic Conference
  'Anderson University (South Carolina) | Anderson | SC', 'Carson-Newman University | Jefferson City | TN', 'Catawba College | Salisbury | NC',
  'Coker University | Hartsville | SC', 'Emory & Henry University | Emory | VA', 'Lenoir-Rhyne University | Hickory | NC',
  'Limestone University | Gaffney | SC', 'Lincoln Memorial University | Harrogate | TN', 'Mars Hill University | Mars Hill | NC',
  'Newberry College | Newberry | SC', 'Queens University of Charlotte | Charlotte | NC', 'Tusculum University | Greeneville | TN',
  'University of Virginia\'s College at Wise | Wise | VA', 'Wingate University | Wingate | NC',
  // Southern Intercollegiate Athletic Conference
  'Albany State University | Albany | GA', 'Allen University | Columbia | SC', 'Benedict College | Columbia | SC',
  'Central State University | Wilberforce | OH', 'Clark Atlanta University | Atlanta | GA', 'Edward Waters University | Jacksonville | FL',
  'Fort Valley State University | Fort Valley | GA', 'Kentucky State University | Frankfort | KY', 'Lane College | Jackson | TN',
  'LeMoyne-Owen College | Memphis | TN', 'Miles College | Fairfield | AL', 'Morehouse College | Atlanta | GA',
  'Savannah State University | Savannah | GA', 'Spring Hill College | Mobile | AL', 'Tuskegee University | Tuskegee | AL',
  // Sunshine State Conference
  'Barry University | Miami Shores | FL', 'Eckerd College | St. Petersburg | FL', 'Embry-Riddle Aeronautical University | Daytona Beach | FL',
  'Florida Southern College | Lakeland | FL', 'Florida Institute of Technology | Melbourne | FL', 'Lynn University | Boca Raton | FL',
  'Nova Southeastern University | Fort Lauderdale | FL', 'Palm Beach Atlantic University | West Palm Beach | FL', 'Rollins College | Winter Park | FL',
  'Saint Leo University | St. Leo | FL', 'University of Tampa | Tampa | FL',
  // Central Atlantic Collegiate Conference
  'Caldwell University | Caldwell | NJ', 'Chestnut Hill College | Philadelphia | PA',
  'Felician University | Rutherford | NJ', 'Georgian Court University | Lakewood | NJ',
  'Goldey-Beacom College | Wilmington | DE', 'Holy Family University | Philadelphia | PA', 'Jefferson University | Philadelphia | PA',
  'Post University | Waterbury | CT', 'Wilmington University | New Castle | DE', 'University of Bridgeport | Bridgeport | CT',
  // Independents and other Division II
    ];

const D3 = [
  // New England Small College Athletic Conference
  'Amherst College | Amherst | MA', 'Bates College | Lewiston | ME', 'Bowdoin College | Brunswick | ME', 'Colby College | Waterville | ME',
  'Connecticut College | New London | CT', 'Hamilton College | Clinton | NY', 'Middlebury College | Middlebury | VT', 'Trinity College (Connecticut) | Hartford | CT',
  'Tufts University | Medford | MA', 'Wesleyan University | Middletown | CT', 'Williams College | Williamstown | MA',
  // New England Women's and Men's Athletic Conference
  'Babson College | Wellesley | MA', 'Clark University | Worcester | MA', 'Coast Guard Academy | New London | CT', 'Emerson College | Boston | MA',
  'Massachusetts Institute of Technology | Cambridge | MA', 'Mount Holyoke College | South Hadley | MA', 'Smith College | Northampton | MA',
  'Springfield College | Springfield | MA', 'Wellesley College | Wellesley | MA', 'Wheaton College (Massachusetts) | Norton | MA',
  'Worcester Polytechnic Institute | Worcester | MA',
  // Liberty League
  'Bard College | Annandale-on-Hudson | NY', 'Clarkson University | Potsdam | NY', 'Hobart and William Smith Colleges | Geneva | NY',
  'Ithaca College | Ithaca | NY', 'Rensselaer Polytechnic Institute | Troy | NY', 'University of Rochester | Rochester | NY',
  'Rochester Institute of Technology | Rochester | NY', 'St. Lawrence University | Canton | NY', 'Skidmore College | Saratoga Springs | NY',
  'Union College (New York) | Schenectady | NY', 'Vassar College | Poughkeepsie | NY',
  // State University of New York Athletic Conference
  'SUNY Brockport | Brockport | NY', 'Buffalo State University | Buffalo | NY', 'SUNY Cortland | Cortland | NY', 'SUNY Fredonia | Fredonia | NY',
  'SUNY Geneseo | Geneseo | NY', 'SUNY New Paltz | New Paltz | NY', 'SUNY Oneonta | Oneonta | NY', 'SUNY Oswego | Oswego | NY',
  'SUNY Plattsburgh | Plattsburgh | NY', 'SUNY Potsdam | Potsdam | NY', 'SUNY Morrisville | Morrisville | NY',
  // Empire 8
  'Alfred University | Alfred | NY', 'Elmira College | Elmira | NY', 'Hartwick College | Oneonta | NY', 'Houghton University | Houghton | NY',
  'Keuka College | Keuka Park | NY', 'Nazareth University | Rochester | NY', 'Russell Sage College | Troy | NY', 'St. John Fisher University | Rochester | NY',
  'Utica University | Utica | NY',
  // Centennial Conference
  'Bryn Mawr College | Bryn Mawr | PA', 'Dickinson College | Carlisle | PA', 'Franklin & Marshall College | Lancaster | PA', 'Gettysburg College | Gettysburg | PA',
  'Haverford College | Haverford | PA', 'Johns Hopkins University | Baltimore | MD', 'McDaniel College | Westminster | MD', 'Muhlenberg College | Allentown | PA',
  'Swarthmore College | Swarthmore | PA', 'Ursinus College | Collegeville | PA', 'Washington College | Chestertown | MD',
  // Middle Atlantic Conferences
  'Albright College | Reading | PA', 'Alvernia University | Reading | PA', 'Arcadia University | Glenside | PA', 'DeSales University | Center Valley | PA',
  'Eastern University | St. Davids | PA', 'Hood College | Frederick | MD', 'King\'s College (Pennsylvania) | Wilkes-Barre | PA', 'Lebanon Valley College | Annville | PA',
  'Lycoming College | Williamsport | PA', 'Messiah University | Mechanicsburg | PA', 'Misericordia University | Dallas | PA', 'Stevens Institute of Technology | Hoboken | NJ',
  'Stevenson University | Owings Mills | MD', 'Widener University | Chester | PA', 'Wilkes University | Wilkes-Barre | PA', 'York College of Pennsylvania | York | PA',
  'Delaware Valley University | Doylestown | PA', 'FDU-Florham | Madison | NJ',
  // Landmark Conference
  'Catholic University of America | Washington | DC', 'Drew University | Madison | NJ', 'Elizabethtown College | Elizabethtown | PA',
  'Juniata College | Huntingdon | PA', 'Moravian University | Bethlehem | PA', 'University of Scranton | Scranton | PA',
  'Susquehanna University | Selinsgrove | PA',   // Old Dominion Athletic Conference
  'Averett University | Danville | VA', 'Bridgewater College | Bridgewater | VA', 'Eastern Mennonite University | Harrisonburg | VA',
  'Ferrum College | Ferrum | VA', 'Guilford College | Greensboro | NC', 'Hampden-Sydney College | Hampden-Sydney | VA', 'Hollins University | Roanoke | VA',
  'University of Lynchburg | Lynchburg | VA', 'Randolph College | Lynchburg | VA', 'Randolph-Macon College | Ashland | VA',
  'Roanoke College | Salem | VA', 'Shenandoah University | Winchester | VA', 'Sweet Briar College | Sweet Briar | VA',
  'Virginia Wesleyan University | Virginia Beach | VA', 'Washington and Lee University | Lexington | VA',
  // USA South Athletic Conference
  'Berea College | Berea | KY', 'Brevard College | Brevard | NC', 'Covenant College | Lookout Mountain | GA', 'Greensboro College | Greensboro | NC',
  'Huntingdon College | Montgomery | AL', 'LaGrange College | LaGrange | GA', 'Maryville College | Maryville | TN', 'Meredith College | Raleigh | NC',
  'Methodist University | Fayetteville | NC', 'North Carolina Wesleyan University | Rocky Mount | NC', 'Piedmont University | Demorest | GA',
  'Pfeiffer University | Misenheimer | NC', 'Salem College | Winston-Salem | NC', 'William Peace University | Raleigh | NC',
  'Wesleyan College | Macon | GA', 'Mary Baldwin University | Staunton | VA',
  // Southern Athletic Association
  'Berry College | Mount Berry | GA', 'Centre College | Danville | KY',
  'Hendrix College | Conway | AR', 'Millsaps College | Jackson | MS', 'Oglethorpe University | Atlanta | GA', 'Rhodes College | Memphis | TN',
  'Sewanee: The University of the South | Sewanee | TN', 'Belhaven University | Jackson | MS',
  // North Coast Athletic Conference
  'Allegheny College | Meadville | PA', 'Denison University | Granville | OH', 'DePauw University | Greencastle | IN', 'Hiram College | Hiram | OH',
  'Kenyon College | Gambier | OH', 'Oberlin College | Oberlin | OH', 'Ohio Wesleyan University | Delaware | OH', 'Wabash College | Crawfordsville | IN',
  'Wittenberg University | Springfield | OH', 'College of Wooster | Wooster | OH',
  // Ohio Athletic Conference
  'Baldwin Wallace University | Berea | OH', 'Capital University | Columbus | OH', 'Heidelberg University | Tiffin | OH', 'John Carroll University | University Heights | OH',
  'Marietta College | Marietta | OH', 'University of Mount Union | Alliance | OH', 'Muskingum University | New Concord | OH', 'Ohio Northern University | Ada | OH',
  'Otterbein University | Westerville | OH', 'Wilmington College (Ohio) | Wilmington | OH',
  // Heartland Collegiate Athletic Conference
  'Anderson University (Indiana) | Anderson | IN', 'Bluffton University | Bluffton | OH', 'Defiance College | Defiance | OH', 'Earlham College | Richmond | IN',
  'Franklin College | Franklin | IN', 'Hanover College | Hanover | IN', 'Manchester University | North Manchester | IN', 'Mount St. Joseph University | Cincinnati | OH',
  'Rose-Hulman Institute of Technology | Terre Haute | IN', 'Transylvania University | Lexington | KY',
  // Michigan Intercollegiate Athletic Association
  'Adrian College | Adrian | MI', 'Albion College | Albion | MI', 'Alma College | Alma | MI', 'Calvin University | Grand Rapids | MI',
  'Hope College | Holland | MI', 'Kalamazoo College | Kalamazoo | MI', 'Olivet College | Olivet | MI', 'Saint Mary\'s College (Indiana) | Notre Dame | IN',
  'Trine University | Angola | IN',
  // College Conference of Illinois and Wisconsin
  'Augustana College (Illinois) | Rock Island | IL', 'Carroll University | Waukesha | WI', 'Carthage College | Kenosha | WI', 'Elmhurst University | Elmhurst | IL',
  'Illinois Wesleyan University | Bloomington | IL', 'Millikin University | Decatur | IL', 'North Central College | Naperville | IL', 'North Park University | Chicago | IL',
  'Wheaton College (Illinois) | Wheaton | IL',
  // Wisconsin Intercollegiate Athletic Conference
  'University of Wisconsin-Eau Claire | Eau Claire | WI', 'University of Wisconsin-La Crosse | La Crosse | WI', 'University of Wisconsin-Oshkosh | Oshkosh | WI',
  'University of Wisconsin-Platteville | Platteville | WI', 'University of Wisconsin-River Falls | River Falls | WI', 'University of Wisconsin-Stevens Point | Stevens Point | WI',
  'University of Wisconsin-Stout | Menomonie | WI', 'University of Wisconsin-Superior | Superior | WI', 'University of Wisconsin-Whitewater | Whitewater | WI',
  // Minnesota Intercollegiate Athletic Conference
  'Augsburg University | Minneapolis | MN', 'Bethel University (Minnesota) | Arden Hills | MN', 'Carleton College | Northfield | MN', 'Concordia College (Minnesota) | Moorhead | MN',
  'Gustavus Adolphus College | St. Peter | MN', 'Hamline University | St. Paul | MN', 'Macalester College | St. Paul | MN', 'Saint John\'s University (Minnesota) | Collegeville | MN',
  'St. Catherine University | St. Paul | MN', 'College of Saint Benedict | St. Joseph | MN', 'Saint Mary\'s University of Minnesota | Winona | MN',
  'St. Olaf College | Northfield | MN', 'University of St. Thomas (Minnesota) | St. Paul | MN',
  // Upper Midwest Athletic Conference
  'Bethany Lutheran College | Mankato | MN', 'Crown College | St. Bonifacius | MN', 'University of Minnesota Morris | Morris | MN',
  'North Central University | Minneapolis | MN', 'Northwestern (Minnesota) | St. Paul | MN', 'Martin Luther College | New Ulm | MN',
    // Northern Athletics Collegiate Conference
  'Alverno College | Milwaukee | WI', 'Aurora University | Aurora | IL', 'Benedictine University | Lisle | IL', 'Concordia University Chicago | River Forest | IL',
  'Concordia University Wisconsin | Mequon | WI', 'Edgewood College | Madison | WI', 'Illinois Tech | Chicago | IL',
  'Lakeland University | Plymouth | WI', 'Marian University (Wisconsin) | Fond du Lac | WI', 'Milwaukee School of Engineering | Milwaukee | WI',
  'Rockford University | Rockford | IL', 'Wisconsin Lutheran College | Milwaukee | WI', 'Dominican University (Illinois) | River Forest | IL',
  // Southern California Intercollegiate Athletic Conference
  'California Institute of Technology | Pasadena | CA', 'California Lutheran University | Thousand Oaks | CA', 'Chapman University | Orange | CA',
  'Claremont-Mudd-Scripps | Claremont | CA', 'University of La Verne | La Verne | CA', 'Occidental College | Los Angeles | CA',
  'Pomona-Pitzer | Claremont | CA', 'University of Redlands | Redlands | CA', 'Whittier College | Whittier | CA',
  // American Southwest Conference and Southern Collegiate Athletic Conference
  'East Texas Baptist University | Marshall | TX', 'Hardin-Simmons University | Abilene | TX', 'Howard Payne University | Brownwood | TX',
  'LeTourneau University | Longview | TX', 'Mary Hardin-Baylor | Belton | TX', 'McMurry University | Abilene | TX', 'University of the Ozarks | Clarksville | AR',
  'Texas Lutheran University | Seguin | TX', 'Concordia University Texas | Austin | TX',
  'Austin College | Sherman | TX', 'Centenary College of Louisiana | Shreveport | LA', 'Colorado College | Colorado Springs | CO',
  'University of Dallas | Irving | TX', 'Johnson & Wales University (Colorado) | Denver | CO', 'Schreiner University | Kerrville | TX',
  'Southwestern University | Georgetown | TX', 'Trinity University (Texas) | San Antonio | TX',
  // Northwest Conference
  'George Fox University | Newberg | OR', 'Lewis & Clark College | Portland | OR', 'Linfield University | McMinnville | OR', 'Pacific University | Forest Grove | OR',
  'Pacific Lutheran University | Tacoma | WA', 'University of Puget Sound | Tacoma | WA', 'Whitman College | Walla Walla | WA', 'Whitworth University | Spokane | WA',
  'Willamette University | Salem | OR',
  // University Athletic Association
  'Brandeis University | Waltham | MA', 'Carnegie Mellon University | Pittsburgh | PA', 'Case Western Reserve University | Cleveland | OH',
  'University of Chicago | Chicago | IL', 'Emory University | Atlanta | GA', 'New York University | New York | NY', 'Washington University in St. Louis | St. Louis | MO',
  // Little East Conference and MASCAC
  'Castleton University | Castleton | VT', 'Eastern Connecticut State University | Willimantic | CT', 'Keene State College | Keene | NH',
  'University of Massachusetts Boston | Boston | MA', 'University of Massachusetts Dartmouth | Dartmouth | MA', 'Plymouth State University | Plymouth | NH',
  'Rhode Island College | Providence | RI', 'University of Southern Maine | Gorham | ME', 'Vermont State University | Castleton | VT',
  'Western Connecticut State University | Danbury | CT', 'Bridgewater State University | Bridgewater | MA', 'Fitchburg State University | Fitchburg | MA',
  'Framingham State University | Framingham | MA', 'Massachusetts College of Liberal Arts | North Adams | MA', 'Massachusetts Maritime Academy | Buzzards Bay | MA',
  'Salem State University | Salem | MA', 'Westfield State University | Westfield | MA', 'Worcester State University | Worcester | MA',
  // Commonwealth Coast Conference and New England Collegiate Conference
  'Curry College | Milton | MA', 'Endicott College | Beverly | MA', 'Gordon College | Wenham | MA', 'University of New England | Biddeford | ME',
  'Nichols College | Dudley | MA', 'Roger Williams University | Bristol | RI', 'Salve Regina University | Newport | RI', 'Suffolk University | Boston | MA',
  'Wentworth Institute of Technology | Boston | MA', 'Western New England University | Springfield | MA', 'Regis College | Weston | MA',
  'Dean College | Franklin | MA', 'Elms College | Chicopee | MA', 'Lesley University | Cambridge | MA', 'Mitchell College | New London | CT',
  'Bay Path University | Longmeadow | MA',   // Great Northeast Athletic Conference (D3)
  'Albertus Magnus College | New Haven | CT', 'Anna Maria College | Paxton | MA', 'Emmanuel College (Massachusetts) | Boston | MA',
  'Johnson & Wales University (Rhode Island) | Providence | RI', 'Lasell University | Newton | MA', 'Norwich University | Northfield | VT',
  'Rivier University | Nashua | NH', 'Saint Joseph\'s College of Maine | Standish | ME', 'University of Saint Joseph | West Hartford | CT',
  'Simmons University | Boston | MA', 'Colby-Sawyer College | New London | NH',
  // Skyline Conference and CUNYAC
  'Farmingdale State College | Farmingdale | NY', 'Manhattanville University | Purchase | NY', 'Mount Saint Mary College | Newburgh | NY',
  'Purchase College | Purchase | NY', 'St. Joseph\'s University (Brooklyn) | Brooklyn | NY', 'St. Joseph\'s University (Long Island) | Patchogue | NY',
  'Sarah Lawrence College | Bronxville | NY', 'SUNY Maritime College | Throggs Neck | NY', 'Yeshiva University | New York | NY',
  'Baruch College | New York | NY', 'Brooklyn College | Brooklyn | NY', 'City College of New York | New York | NY', 'Hunter College | New York | NY',
  'John Jay College | New York | NY', 'Lehman College | Bronx | NY', 'Medgar Evers College | Brooklyn | NY', 'York College (CUNY) | Jamaica | NY',
  // New Jersey Athletic Conference
  'Kean University | Union | NJ', 'Montclair State University | Montclair | NJ', 'New Jersey City University | Jersey City | NJ', 'Ramapo College | Mahwah | NJ',
  'Rowan University | Glassboro | NJ', 'Rutgers University-Camden | Camden | NJ', 'Rutgers University-Newark | Newark | NJ', 'Stockton University | Galloway | NJ',
  'The College of New Jersey | Ewing | NJ', 'William Paterson University | Wayne | NJ',
  // Presidents' Athletic Conference and Allegheny Mountain Collegiate Conference
  'Bethany College (West Virginia) | Bethany | WV', 'Chatham University | Pittsburgh | PA', 'Franciscan University | Steubenville | OH',
  'Geneva College | Beaver Falls | PA', 'Grove City College | Grove City | PA', 'Saint Vincent College | Latrobe | PA', 'Thiel College | Greenville | PA',
  'Washington & Jefferson College | Washington | PA', 'Waynesburg University | Waynesburg | PA', 'Westminster College (Pennsylvania) | New Wilmington | PA',
  'Alfred State College | Alfred | NY', 'Hilbert College | Hamburg | NY', 'La Roche University | Pittsburgh | PA', 'Mount Aloysius College | Cresson | PA',
  'Penn State Altoona | Altoona | PA', 'Penn State Behrend | Erie | PA', 'Pitt-Bradford | Bradford | PA', 'Pitt-Greensburg | Greensburg | PA',
  // Atlantic East, CSAC, Coast to Coast, United East
  'Centenary University | Hackettstown | NJ', 'Gwynedd Mercy University | Gwynedd Valley | PA',
  'Immaculata University | Immaculata | PA', 'Marymount University | Arlington | VA', 'Marywood University | Scranton | PA',
  'Neumann University | Aston | PA', 'Saint Elizabeth University | Morristown | NJ', 'Bryn Athyn College | Bryn Athyn | PA',
  'Cairn University | Langhorne | PA', 'Cedar Crest College | Allentown | PA',   'Keystone College | La Plume | PA', 'Rosemont College | Rosemont | PA', 'Notre Dame of Maryland University | Baltimore | MD',
  'Christopher Newport University | Newport News | VA', 'Mary Washington | Fredericksburg | VA', 'Salisbury University | Salisbury | MD',
  'St. Mary\'s College of Maryland | St. Mary\'s City | MD', 'Southern Virginia University | Buena Vista | VA',   'Pratt Institute | Brooklyn | NY', 'Penn State Harrisburg | Middletown | PA', 'Penn State Berks | Reading | PA', 'Gallaudet University | Washington | DC',
  'Lancaster Bible College | Lancaster | PA', 'SUNY Canton | Canton | NY', 'SUNY Cobleskill | Cobleskill | NY', 'SUNY Delhi | Delhi | NY',
  'SUNY Polytechnic Institute | Utica | NY',   // Midwest Conference, St. Louis Intercollegiate, American Rivers, Iowa
  'Beloit College | Beloit | WI', 'Cornell College | Mount Vernon | IA', 'Grinnell College | Grinnell | IA', 'Illinois College | Jacksonville | IL',
  'Knox College | Galesburg | IL', 'Lake Forest College | Lake Forest | IL', 'Lawrence University | Appleton | WI', 'Monmouth College | Monmouth | IL',
  'Ripon College | Ripon | WI', 'Blackburn College | Carlinville | IL', 'Eureka College | Eureka | IL', 'Fontbonne University | St. Louis | MO',
  'Greenville University | Greenville | IL', 'Principia College | Elsah | IL', 'Westminster College (Missouri) | Fulton | MO', 'Spalding University | Louisville | KY', 'Webster University | St. Louis | MO',
  'Buena Vista University | Storm Lake | IA', 'Central College | Pella | IA', 'Coe College | Cedar Rapids | IA',
  'University of Dubuque | Dubuque | IA', 'Loras College | Dubuque | IA', 'Luther College | Decorah | IA', 'Nebraska Wesleyan University | Lincoln | NE',
  'Simpson College | Indianola | IA', 'Wartburg College | Waverly | IA',
];

const NAIA = [
  // Sooner Athletic Conference
  'John Brown University | Siloam Springs | AR', 'Langston University | Langston | OK', 'Mid-America Christian University | Oklahoma City | OK',
  'Oklahoma City University | Oklahoma City | OK', 'Oklahoma Panhandle State University | Goodwell | OK', 'University of Science and Arts of Oklahoma | Chickasha | OK',
  'Southwestern Assemblies of God University | Waxahachie | TX', 'Southwestern Christian University | Bethany | OK', 'Texas Wesleyan University | Fort Worth | TX',
  'Wayland Baptist University | Plainview | TX', 'Central Christian College of Kansas | McPherson | KS',
  // Kansas Collegiate Athletic Conference
  'Avila University | Kansas City | MO', 'Bethany College (Kansas) | Lindsborg | KS', 'Bethel College (Kansas) | North Newton | KS', 'Evangel University | Springfield | MO',
  'Friends University | Wichita | KS', 'Kansas Wesleyan University | Salina | KS', 'McPherson College | McPherson | KS', 'Oklahoma Wesleyan University | Bartlesville | OK',
  'Ottawa University (Kansas) | Ottawa | KS', 'University of Saint Mary | Leavenworth | KS', 'Southwestern College (Kansas) | Winfield | KS',
  'Sterling College | Sterling | KS', 'Tabor College | Hillsboro | KS', 'York University (Nebraska) | York | NE',
  // Heart of America Athletic Conference
  'Baker University | Baldwin City | KS', 'Benedictine College | Atchison | KS', 'Central Methodist University | Fayette | MO', 'Clarke University | Dubuque | IA',
  'Culver-Stockton College | Canton | MO', 'Graceland University | Lamoni | IA', 'Grand View University | Des Moines | IA', 'Mount Mercy University | Cedar Rapids | IA',
  'MidAmerica Nazarene University | Olathe | KS', 'Missouri Valley College | Marshall | MO', 'Park University | Parkville | MO', 'Peru State College | Peru | NE',
  'William Penn University | Oskaloosa | IA', 'William Woods University | Fulton | MO',
  // Crossroads League
  'Bethel University (Indiana) | Mishawaka | IN', 'Goshen College | Goshen | IN', 'Grace College | Winona Lake | IN', 'Huntington University | Huntington | IN',
  'Indiana Wesleyan University | Marion | IN', 'Marian University (Indiana) | Indianapolis | IN', 'Mount Vernon Nazarene University | Mount Vernon | OH',
  'University of Saint Francis (Indiana) | Fort Wayne | IN', 'Spring Arbor University | Spring Arbor | MI', 'Taylor University | Upland | IN',
  // Mid-South Conference
  'Bethel University (Tennessee) | McKenzie | TN', 'Campbellsville University | Campbellsville | KY', 'University of the Cumberlands | Williamsburg | KY',
  'Cumberland University | Lebanon | TN', 'Freed-Hardeman University | Henderson | TN', 'Georgetown College | Georgetown | KY', 'Life University | Marietta | GA',
  'Lindsey Wilson College | Columbia | KY', 'Martin Methodist College | Pulaski | TN', 'University of Pikeville | Pikeville | KY', 'Shawnee State University | Portsmouth | OH',
  'Tennessee Southern | Pulaski | TN',   // Appalachian Athletic Conference
  'Bluefield University | Bluefield | VA', 'Bryan College | Dayton | TN', 'Columbia International University | Columbia | SC', 'Kentucky Christian University | Grayson | KY',
  'Milligan University | Milligan College | TN', 'Montreat College | Montreat | NC', 'Point University | West Point | GA', 'Reinhardt University | Waleska | GA',
  'St. Andrews University | Laurinburg | NC', 'Tennessee Wesleyan University | Athens | TN', 'Truett McConnell University | Cleveland | GA',
  'Union College (Kentucky) | Barbourville | KY', 'Union Commonwealth University | Barbourville | KY',
  // The Sun Conference
  'Ave Maria University | Ave Maria | FL', 'College of Coastal Georgia | Brunswick | GA', 'Florida College | Temple Terrace | FL', 'Florida Memorial University | Miami Gardens | FL',
  'Keiser University | West Palm Beach | FL', 'Saint Thomas University (Florida) | Miami Gardens | FL', 'Southeastern University | Lakeland | FL',
  'Thomas University | Thomasville | GA', 'Warner University | Lake Wales | FL', 'Webber International University | Babson Park | FL',
  'William Carey University | Hattiesburg | MS',
  // Frontier Conference and Cascade Collegiate Conference
  'Carroll College | Helena | MT', 'Montana Tech | Butte | MT', 'Montana State University-Northern | Havre | MT', 'University of Montana Western | Dillon | MT',
  'University of Providence | Great Falls | MT', 'Rocky Mountain College | Billings | MT', 'Eastern Oregon University | La Grande | OR',
  'Southern Oregon University | Ashland | OR', 'Oregon Institute of Technology | Klamath Falls | OR', 'College of Idaho | Caldwell | ID',
  'Bushnell University | Eugene | OR', 'Corban University | Salem | OR', 'Evergreen State College | Olympia | WA', 'Lewis-Clark State College | Lewiston | ID',
  'Multnomah University | Portland | OR', 'Northwest University | Kirkland | WA', 'Warner Pacific University | Portland | OR', 'Walla Walla University | College Place | WA',
  'University of British Columbia | Vancouver | BC',
  // Golden State Athletic Conference and California Pacific Conference
  'Arizona Christian University | Glendale | AZ', 'Hope International University | Fullerton | CA', 'Life Pacific University | San Dimas | CA',
  'The Master\'s University | Santa Clarita | CA', 'Ottawa University Arizona | Surprise | AZ', 'San Diego Christian College | Santee | CA',
  'Embry-Riddle Aeronautical University Prescott | Prescott | AZ',
  'Benedictine University at Mesa | Mesa | AZ', 'University of Antelope Valley | Lancaster | CA', 'Park University Gilbert | Gilbert | AZ',
  'Pacific Union College | Angwin | CA', 'Simpson University | Redding | CA', 'Soka University of America | Aliso Viejo | CA', 'UC Merced | Merced | CA',
  // Red River Athletic Conference
  'Huston-Tillotson University | Austin | TX', 'Jarvis Christian University | Hawkins | TX', 'Louisiana State University Shreveport | Shreveport | LA',
  'Louisiana State University of Alexandria | Alexandria | LA', 'Our Lady of the Lake University | San Antonio | TX', 'Paul Quinn College | Dallas | TX',
  'Texas A&M University-San Antonio | San Antonio | TX', 'Texas A&M University-Texarkana | Texarkana | TX', 'Texas College | Tyler | TX', 'University of Houston-Victoria | Victoria | TX',
  'University of St. Thomas (Texas) | Houston | TX', 'Wiley University | Marshall | TX', 'Xavier University of Louisiana | New Orleans | LA',
  'North American University | Stafford | TX', 'Texas A&M University-Texarkana | Texarkana | TX',
  // Chicagoland Collegiate Athletic Conference
  'Calumet College of St. Joseph | Whiting | IN', 'Governors State University | University Park | IL', 'Holy Cross College | Notre Dame | IN',
  'Indiana University Kokomo | Kokomo | IN', 'Indiana University Northwest | Gary | IN', 'Indiana University South Bend | South Bend | IN',
  'Judson University | Elgin | IL', 'Olivet Nazarene University | Bourbonnais | IL', 'Saint Xavier University | Chicago | IL', 'Saint Francis (Illinois) | Joliet | IL',
  'Trinity Christian College | Palos Heights | IL', 'Trinity International University | Deerfield | IL',
  // Wolverine-Hoosier Athletic Conference
  'Aquinas College | Grand Rapids | MI', 'Cleary University | Howell | MI', 'Concordia University Ann Arbor | Ann Arbor | MI', 'Cornerstone University | Grand Rapids | MI',
  'Indiana Tech | Fort Wayne | IN', 'Lawrence Technological University | Southfield | MI', 'Lourdes University | Sylvania | OH', 'Madonna University | Livonia | MI',
  'University of Michigan-Dearborn | Dearborn | MI', 'University of Northwestern Ohio | Lima | OH', 'Rochester University | Rochester Hills | MI',
  'Siena Heights University | Adrian | MI',
  // Great Plains Athletic Conference and North Star Athletic Association
  'Briar Cliff University | Sioux City | IA', 'Concordia University (Nebraska) | Seward | NE', 'Dakota Wesleyan University | Mitchell | SD', 'Doane University | Crete | NE',
  'Dordt University | Sioux Center | IA', 'Hastings College | Hastings | NE', 'University of Jamestown | Jamestown | ND', 'Midland University | Fremont | NE',
  'Morningside University | Sioux City | IA', 'Mount Marty University | Yankton | SD', 'Northwestern College (Iowa) | Orange City | IA', 'College of Saint Mary | Omaha | NE',
  'Bellevue University | Bellevue | NE', 'Dakota State University | Madison | SD', 'Dickinson State University | Dickinson | ND', 'Mayville State University | Mayville | ND',
  'Valley City State University | Valley City | ND', 'Viterbo University | La Crosse | WI', 'Waldorf University | Forest City | IA',
  // Southern States, Gulf Coast, Continental
  'Blue Mountain Christian University | Blue Mountain | MS', 'Brewton-Parker College | Mount Vernon | GA', 'Dalton State College | Dalton | GA',
  'Faulkner University | Montgomery | AL', 'Loyola University New Orleans | New Orleans | LA', 'University of Mobile | Mobile | AL', 'Middle Georgia State University | Macon | GA',
  'Stillman College | Tuscaloosa | AL', 'Talladega College | Talladega | AL', 'Tougaloo College | Tougaloo | MS',   'Dillard University | New Orleans | LA', 'Fisk University | Nashville | TN', 'Oakwood University | Huntsville | AL', 'Philander Smith University | Little Rock | AR',
  'Rust College | Holly Springs | MS', 'Southern University at New Orleans | New Orleans | LA', 'Voorhees University | Denmark | SC',   'Florida National University | Hialeah | FL',
  // River States Conference and American Midwest Conference
  'Alice Lloyd College | Pippa Passes | KY', 'Asbury University | Wilmore | KY', 'Brescia University | Owensboro | KY', 'Carlow University | Pittsburgh | PA',
  'Indiana University East | Richmond | IN', 'Indiana University Southeast | New Albany | IN',
  'Midway University | Midway | KY', 'Ohio Christian University | Circleville | OH', 'Oakland City University | Oakland City | IN', 'Point Park University | Pittsburgh | PA',
  'University of Rio Grande | Rio Grande | OH', 'West Virginia University Institute of Technology | Beckley | WV', 'Central Baptist College | Conway | AR',
  'Columbia College (Missouri) | Columbia | MO', 'Hannibal-LaGrange University | Hannibal | MO', 'Harris-Stowe State University | St. Louis | MO',
  'Lyon College | Batesville | AR', 'Missouri Baptist University | St. Louis | MO', 'Stephens College | Columbia | MO', 'University of Health Sciences and Pharmacy | St. Louis | MO',
  'Williams Baptist University | Walnut Ridge | AR',   // Association of Independent Institutions and other NAIA
  'Fisher College | Boston | MA', 'Florida College | Temple Terrace | FL',
  'Haskell Indian Nations University | Lawrence | KS', 'Providence Christian College | Pasadena | CA',
  'Crowley\'s Ridge College | Paragould | AR',   ];

// Parse "Name | City | ST" into { name: { city, state } }.
function parse(list) {
  const out = {};
  for (const line of list) {
    const parts = String(line).split('|').map((s) => s.trim());
    if (parts.length !== 3 || !parts[0] || !parts[1] || !/^[A-Z]{2}$/.test(parts[2])) throw new Error('schoolsDivisions: bad entry ' + JSON.stringify(line));
    if (!out[parts[0]]) out[parts[0]] = { city: parts[1], state: parts[2] };
  }
  return out;
}

const SCHOOLS = Object.assign({}, parse(NAIA), parse(D3), parse(D2));

module.exports = { SCHOOLS, D2, D3, NAIA, parse };
