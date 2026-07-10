// server/areaCodes.js
// US NANP geographic area code -> state (2-letter). Used by Deal Scan contacts
// to sanity-check that a business phone belongs to the card's market, so a
// wrong-location number (e.g. a Wyoming 307 line for a Marietta, Georgia scan) is
// never shown. Toll-free codes map to 'TF' (locality cannot be inferred).
const AREA_CODE_STATE = {};
const _add = (st, codes) => codes.forEach((c) => { AREA_CODE_STATE[String(c)] = st; });

_add('AL', [205, 251, 256, 334, 659, 938]);
_add('AK', [907]);
_add('AZ', [480, 520, 602, 623, 928]);
_add('AR', [479, 501, 870]);
_add('CA', [209, 213, 279, 310, 323, 341, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 858, 909, 916, 925, 949, 951]);
_add('CO', [303, 719, 720, 970, 983]);
_add('CT', [203, 475, 860, 959]);
_add('DE', [302]);
_add('DC', [202]);
_add('FL', [239, 305, 321, 352, 386, 407, 561, 689, 727, 754, 772, 786, 813, 850, 863, 904, 941, 954]);
_add('GA', [229, 404, 470, 478, 678, 706, 762, 770, 912]);
_add('HI', [808]);
_add('ID', [208, 986]);
_add('IL', [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 773, 779, 815, 847, 872]);
_add('IN', [219, 260, 317, 463, 574, 765, 812, 930]);
_add('IA', [319, 515, 563, 641, 712]);
_add('KS', [316, 620, 785, 913]);
_add('KY', [270, 364, 502, 606, 859]);
_add('LA', [225, 318, 337, 504, 985]);
_add('ME', [207]);
_add('MD', [227, 240, 301, 410, 443, 667]);
_add('MA', [339, 351, 413, 508, 617, 774, 781, 857, 978]);
_add('MI', [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989]);
_add('MN', [218, 320, 507, 612, 651, 763, 952]);
_add('MS', [228, 601, 662, 769]);
_add('MO', [314, 417, 573, 636, 660, 816]);
_add('MT', [406]);
_add('NE', [308, 402, 531]);
_add('NV', [702, 725, 775]);
_add('NH', [603]);
_add('NJ', [201, 551, 609, 640, 732, 848, 856, 862, 908, 973]);
_add('NM', [505, 575]);
_add('NY', [212, 315, 332, 347, 363, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934]);
_add('NC', [252, 336, 704, 743, 828, 910, 919, 980, 984]);
_add('ND', [701]);
_add('OH', [216, 220, 234, 326, 330, 380, 419, 440, 513, 567, 614, 740, 937]);
_add('OK', [405, 539, 580, 918]);
_add('OR', [458, 503, 541, 971]);
_add('PA', [215, 223, 267, 272, 412, 445, 484, 570, 610, 717, 724, 814, 878]);
_add('RI', [401]);
_add('SC', [803, 839, 843, 854, 864]);
_add('SD', [605]);
_add('TN', [423, 615, 629, 731, 865, 901, 931]);
_add('TX', [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 915, 936, 940, 945, 956, 972, 979]);
_add('UT', [385, 435, 801]);
_add('VT', [802]);
_add('VA', [276, 434, 540, 571, 703, 757, 804, 826, 948]);
_add('WA', [206, 253, 360, 425, 509, 564]);
_add('WV', [304, 681]);
_add('WI', [262, 414, 534, 608, 715, 920]);
_add('WY', [307]);
_add('TF', [800, 833, 844, 855, 866, 877, 888]); // toll-free: locality unknown

const STATE_NAME_TO_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY',
};
const _ABBRS = new Set(Object.values(STATE_NAME_TO_ABBR));

// Reverse lookup: 2-letter abbreviation -> Title Case full name (for search copy
// like "Alabama Secretary of State"). null for unknown / non-state codes.
const _ABBR_TO_NAME = {};
for (const [name, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
  _ABBR_TO_NAME[abbr] = name.replace(/\b\w/g, (c) => c.toUpperCase());
}
function stateName(abbr) {
  if (!abbr) return null;
  return _ABBR_TO_NAME[String(abbr).trim().toUpperCase()] || null;
}

// Normalize a state string (full name or 2-letter) to a 2-letter abbreviation, or
// null if unrecognized.
function normalizeState(s) {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  if (t.length === 2 && _ABBRS.has(t.toUpperCase())) return t.toUpperCase();
  return STATE_NAME_TO_ABBR[t] || null;
}

// State (2-letter) for a phone's area code, or null if unknown. 'TF' for toll-free.
function areaCodeState(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length < 10) return null;
  return AREA_CODE_STATE[digits.slice(0, 3)] || null;
}

module.exports = { AREA_CODE_STATE, normalizeState, areaCodeState, stateName };
