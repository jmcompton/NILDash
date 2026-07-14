'use strict';
// NIL state compliance reference data.
//
// EDUCATIONAL INFORMATION ONLY, NOT LEGAL ADVICE.
//
// Every summary here is written in-house from primary sources: state statutes, the
// House v. NCAA settlement, the federal SPARTA statute, and the Uniform / Revised
// Uniform Athlete Agents Act (UAAA / RUAAA). Nothing is copied from law-firm posts
// or other third-party summaries.
//
// Knowledge cutoff for this data is January 2026, and NIL law changes frequently.
// Each state carries a confidence field. "confident" means the citation and framing
// are ones we are comfortable with as of the cutoff. "verify" means the current rule
// is uncertain or fast-moving, so the entry stays deliberately general and cites the
// source TYPE rather than asserting an exact code section that might be wrong. The
// policy is to under-claim rather than assert a wrong rule.

const LAST_REVIEWED = '2026-01';
const NIL_GO_THRESHOLD = 600;

const DISCLAIMER = 'This is educational information, not legal advice. NIL rules change frequently. Confirm current rules with a qualified attorney before acting.';

// Applies regardless of state.
const FEDERAL_FLOOR = {
  sparta: {
    summary: 'SPARTA is a federal law that bars an athlete agent from using false or misleading conduct to recruit or sign a student athlete and requires specific written warnings and disclosures in the agency contract. It is enforced by the Federal Trade Commission and by state attorneys general. SPARTA governs agent conduct; it is not the source of the 72-hour school notice.',
    authority: 'Sports Agent Responsibility and Trust Act, 15 U.S.C. Sections 7801 to 7807',
  },
  uaaaNotice: {
    summary: 'Most states adopted the Uniform Athlete Agents Act or its 2015 revision. That state law, not SPARTA, is what requires an athlete agent to notify the school (typically the athletic director) within 72 hours after signing an agency contract, or before the athlete\'s next scheduled event, whichever is first. It also requires the agent to register with the state.',
    authority: 'Uniform Athlete Agents Act (2000) / Revised Uniform Athlete Agents Act (2015), as adopted by the state',
  },
  reporting: {
    thirdPartyThreshold: NIL_GO_THRESHOLD,
    summary: 'Under the House v. NCAA settlement, a third-party NIL deal of 600 dollars or more is submitted to the NIL Go clearinghouse for a fair-market-value review. This is a national settlement term applied across states, not a state-specific statute.',
    authority: 'House v. NCAA settlement (2025), NIL Go clearinghouse',
  },
};

// The full list of jurisdictions. Detailed overrides follow for the states whose
// exact citations we are confident about; the rest use an honest, hedged base.
const ALL = [
  ['Alabama','AL'],['Alaska','AK'],['Arizona','AZ'],['Arkansas','AR'],['California','CA'],
  ['Colorado','CO'],['Connecticut','CT'],['Delaware','DE'],['District of Columbia','DC'],
  ['Florida','FL'],['Georgia','GA'],['Hawaii','HI'],['Idaho','ID'],['Illinois','IL'],
  ['Indiana','IN'],['Iowa','IA'],['Kansas','KS'],['Kentucky','KY'],['Louisiana','LA'],
  ['Maine','ME'],['Maryland','MD'],['Massachusetts','MA'],['Michigan','MI'],['Minnesota','MN'],
  ['Mississippi','MS'],['Missouri','MO'],['Montana','MT'],['Nebraska','NE'],['Nevada','NV'],
  ['New Hampshire','NH'],['New Jersey','NJ'],['New Mexico','NM'],['New York','NY'],
  ['North Carolina','NC'],['North Dakota','ND'],['Ohio','OH'],['Oklahoma','OK'],['Oregon','OR'],
  ['Pennsylvania','PA'],['Rhode Island','RI'],['South Carolina','SC'],['South Dakota','SD'],
  ['Tennessee','TN'],['Texas','TX'],['Utah','UT'],['Vermont','VT'],['Virginia','VA'],
  ['Washington','WA'],['West Virginia','WV'],['Wisconsin','WI'],['Wyoming','WY'],
];

// A hedged, honest base entry. Both the agent-registration duty and the NIL activity
// itself are stated at a level we can stand behind for any state, with the exact
// current citation left to verification. Confidence defaults to "verify".
function baseState(name, code) {
  return {
    state: name,
    code,
    agentRegistration: {
      required: true,
      summary: 'An athlete agent generally must register with the state before recruiting or representing a student athlete. Most states impose this through the Uniform or Revised Uniform Athlete Agents Act. Confirm ' + name + "'s current requirement and registering agency.",
      authority: 'Uniform Athlete Agents Act (2000) / Revised Uniform Athlete Agents Act (2015), as adopted by ' + name,
    },
    nilStatute: {
      summary: name + ' permits student-athlete NIL activity. After the 2025 House v. NCAA settlement, many states amended their NIL laws to let schools support or directly pay athletes. The exact current statute and its latest amendments should be verified.',
      authority: name + ' student-athlete NIL statute or institutional policy (verify current citation)',
    },
    reporting: {
      thirdPartyThreshold: NIL_GO_THRESHOLD,
      summary: FEDERAL_FLOOR.reporting.summary,
      authority: FEDERAL_FLOOR.reporting.authority,
    },
    highSchool: {
      summary: 'High school NIL in ' + name + ' is governed by the state high school athletic association, and its rules differ from, and are usually stricter than, the college rules. Confirm the association\'s current NIL policy.',
      authority: name + ' high school athletic association NIL policy',
    },
    flags: [],
    confidence: 'verify',
    lastReviewed: LAST_REVIEWED,
  };
}

// Confident overrides. These carry specific primary citations we stand behind as of
// the cutoff. All wording is in-house.
const OVERRIDES = {
  GA: {
    agentRegistration: {
      required: true,
      summary: 'Athlete agents must register with the Georgia Secretary of State before recruiting or representing a student athlete, under the Georgia Athlete Agents Act.',
      authority: 'Georgia Athlete Agents Act, O.C.G.A. Title 43, Chapter 4A',
    },
    nilStatute: {
      summary: 'Georgia law lets student athletes earn NIL compensation, and 2025 amendments broadened it to allow schools to support and directly pay athletes in line with the House settlement.',
      authority: 'O.C.G.A. Section 20-3-681 et seq. (HB 617, 2021; amended 2025)',
    },
    highSchool: {
      summary: 'The Georgia High School Association permits high school NIL under its bylaws with limits, including no use of school marks and no recruiting inducements. This is separate from, and stricter than, the college rules.',
      authority: 'Georgia High School Association Constitution and Bylaws, NIL policy',
    },
    flags: ['Georgia requires athlete-agent registration with the Secretary of State before representation.'],
    confidence: 'confident',
  },
  AL: {
    agentRegistration: {
      required: true,
      summary: 'Alabama regulates athlete agents through the Alabama Athlete Agents Regulatory Commission, and agents must register before representing a student athlete under the state\'s Revised Uniform Athlete Agents Act.',
      authority: 'Ala. Code Title 8, Chapter 26B (Revised Uniform Athlete Agents Act); Alabama Athlete Agents Regulatory Commission',
    },
    nilStatute: {
      summary: 'Alabama passed an NIL statute in 2021 and then repealed it in 2023, choosing to govern NIL through institutional and athletic-association policy rather than a standing statute. Treat NIL rules here as policy-driven and confirm the current institutional policy.',
      authority: 'Alabama 2021 NIL Act (repealed 2023); governed by institutional and NCAA policy',
    },
    flags: [
      'Alabama repealed its statutory NIL law in 2023; NIL here is governed by institutional policy, so confirm the specific school\'s current policy.',
      'Athlete-agent registration runs through the Alabama Athlete Agents Regulatory Commission, not the Secretary of State.',
    ],
    confidence: 'confident',
  },
  TX: {
    agentRegistration: {
      required: true,
      summary: 'Athlete agents must register with the Texas Secretary of State before recruiting or representing a student athlete, under the Texas athlete-agent statute.',
      authority: 'Tex. Occ. Code Chapter 2051 (Athlete Agents)',
    },
    nilStatute: {
      summary: 'Texas law lets student athletes earn NIL compensation, and amendments in 2023 and 2025 expanded it to allow schools to facilitate and directly provide NIL compensation.',
      authority: 'Tex. Educ. Code Section 51.9246 (SB 1385, 2023; amended 2025)',
    },
    highSchool: {
      summary: 'The University Interscholastic League has historically restricted high school NIL in Texas, so high school rules here differ sharply from the college rules. Confirm the current UIL position.',
      authority: 'University Interscholastic League (UIL) rules',
    },
    flags: ['Texas requires athlete-agent registration with the Secretary of State before representation.'],
    confidence: 'confident',
  },
  FL: {
    agentRegistration: {
      required: true,
      summary: 'Florida regulates athlete agents through the Department of Business and Professional Regulation, and agents must register before representing a student athlete.',
      authority: 'Fla. Stat. Chapter 468, Part IX (Athlete Agents); Department of Business and Professional Regulation',
    },
    nilStatute: {
      summary: 'Florida was among the first states to enact an NIL law permitting student-athlete compensation, and it has been amended since to align with evolving NCAA and settlement rules.',
      authority: 'Fla. Stat. Section 1006.74 (amended since 2021)',
    },
    flags: ['Florida licenses athlete agents through the Department of Business and Professional Regulation.'],
    confidence: 'confident',
  },
  CA: {
    agentRegistration: {
      required: true,
      summary: 'California regulates athlete agents under the Miller-Ayala Athlete Agents Act, which requires registration before representing a student athlete. California did not adopt the UAAA.',
      authority: 'Miller-Ayala Athlete Agents Act, Cal. Bus. & Prof. Code Section 18895 et seq.',
    },
    nilStatute: {
      summary: 'California\'s Fair Pay to Play Act was the first state NIL law and permits student-athlete NIL compensation. It has been amended since, and confirming the current version is worthwhile given ongoing changes.',
      authority: 'Cal. Educ. Code Section 67456 (Fair Pay to Play Act, SB 206, 2019; amended since)',
    },
    flags: ['California uses the Miller-Ayala Athlete Agents Act, not the UAAA, so agent-registration specifics differ from most states.'],
    confidence: 'confident',
  },
  TN: {
    nilStatute: {
      summary: 'Tennessee law permits student-athlete NIL compensation and has been amended to keep pace with NCAA and settlement changes, including provisions on institutional involvement.',
      authority: 'Tenn. Code Ann. Section 49-7-2801 et seq. (amended since 2021)',
    },
    flags: ['Tennessee has actively amended its NIL statute; confirm the current version, especially on institutional involvement.'],
    confidence: 'confident',
  },
};

const NIL_STATE_RULES = {};
for (const [name, code] of ALL) {
  const entry = baseState(name, code);
  const ov = OVERRIDES[code];
  if (ov) Object.assign(entry, ov);
  // Every "verify" state gets an explicit honesty flag so the UI never presents a
  // hedged entry as settled fact.
  if (entry.confidence === 'verify') {
    entry.flags = entry.flags.concat([
      'The exact current NIL statute for ' + name + ' was not confirmed for this reference; verify the current rule with a qualified attorney before relying on it.',
    ]);
  }
  NIL_STATE_RULES[code] = entry;
}

// ── Resolution helpers ──────────────────────────────────────────────────────────

const STATE_NAME_TO_CODE = {};
for (const [name, code] of ALL) STATE_NAME_TO_CODE[name.toLowerCase()] = code;
const VALID_CODES = new Set(ALL.map(([, code]) => code));

// Accepts "GA", "Georgia", "City, GA", "City, Georgia", or a bare state name and
// returns the 2-letter code, or null when nothing resolves. No web, no AI.
function stateCodeFromText(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  // "City, ST" or "City, State" -> take the part after the last comma first.
  const tail = raw.includes(',') ? raw.split(',').pop().trim() : raw;
  const tries = [tail, raw];
  for (const t of tries) {
    const up = t.toUpperCase();
    if (up.length === 2 && VALID_CODES.has(up)) return up;
    const byName = STATE_NAME_TO_CODE[t.toLowerCase()];
    if (byName) return byName;
  }
  return null;
}

function getStateRule(code) {
  if (!code) return null;
  return NIL_STATE_RULES[String(code).toUpperCase()] || null;
}

// Build the reference payload for an athlete's home state and school state.
function rulesForStates(homeCode, schoolCode) {
  const home = getStateRule(homeCode);
  const school = getStateRule(schoolCode);
  return {
    disclaimer: DISCLAIMER,
    federal: FEDERAL_FLOOR,
    homeState: home ? home.code : null,
    schoolState: school ? school.code : null,
    home,
    school,
    crossState: !!(home && school && home.code !== school.code),
    lastReviewed: LAST_REVIEWED,
  };
}

module.exports = {
  NIL_STATE_RULES,
  FEDERAL_FLOOR,
  DISCLAIMER,
  LAST_REVIEWED,
  NIL_GO_THRESHOLD,
  STATE_NAME_TO_CODE,
  stateCodeFromText,
  getStateRule,
  rulesForStates,
};
