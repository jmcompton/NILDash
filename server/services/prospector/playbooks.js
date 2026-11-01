'use strict';
// ── PLAYBOOKS: ONE ENGINE, A SETTINGS FILE PER MARKET ───────────────────────
//
// The prospector finds local businesses, checks a signal, finds and verifies
// the decision maker and writes the pitch. What changes from one market to the
// next is only this: what the customer sells, who they sell to, the signal
// that says "now", who to reach, and how to pitch. Adding a market is adding a
// playbook here, not building a product.
//
//   key          the URL / database name
//   label        what the customer is ("IT company")
//   targets      Google Places text searches, each run as "<term> in <area>"
//   signal       the plug-in in services/prospector/signals that scores a business
//   reachTitles  job titles to prefer, best first (regex sources, case-insensitive)
//   avoidTitles  titles never chosen as the person to write to
//   pitch        what the writer is told: the offer, the angle, the rules

const PLAYBOOKS = {
  'it-msp': {
    key: 'it-msp',
    label: 'IT company (managed service provider)',
    sells: 'managed IT support and cybersecurity for small and mid-size businesses',
    targets: [
      'dental office', 'orthodontist', 'medical clinic', 'physical therapy clinic', 'veterinary clinic',
      'law firm', 'accounting firm', 'insurance agency', 'financial advisor', 'engineering firm',
      'property management company', 'commercial real estate firm', 'private school', 'church office',
    ],
    signal: 'email-security',
    // Not a small business an IT company can win: hospitals, health systems,
    // universities, and chains (one website, many locations). "Animal
    // hospital" is a vet and stays.
    skip: {
      types: ['hospital', 'university', 'college', 'government office', 'city government office', 'county government office'],
      names: '\\b(hospital|medical center|health system|healthcare system|university|college|school district)\\b',
      keepNames: '\\b(animal|pet|vet|veterinary|equine)\\b',
      maxLocations: 3,
    },
    reachTitles: [
      'owner', 'founder', 'president', 'ceo', 'managing partner', 'principal',
      'practice (manager|administrator)', 'office manager', 'operations manager', 'administrator',
      'coo', 'director of operations', 'business manager', 'it (manager|director|coordinator)',
    ],
    avoidTitles: ['intern', 'assistant to', 'student', 'marketing coordinator', 'social media'],
    pitch: {
      offer: 'a quick fix for the email gap, then ongoing IT support if it is a fit',
      angle: 'Name the one specific email security gap found in their public records, what it lets a stranger do, and why it matters for their kind of business. Offer to show them in 10 minutes.',
      rules: [
        'State only the gap that was found. Never say they were hacked or that anyone has spoofed them.',
        'Never claim to have scanned, tested or accessed their systems: this came from public DNS records.',
        'One ask: a 10 minute call or a reply. No price.',
      ],
    },
  },
  staffing: {
    key: 'staffing',
    label: 'staffing agency',
    sells: 'qualified workers for open roles',
    targets: ['warehouse', 'distribution center', 'manufacturer', 'construction company', 'medical office', 'dental office', 'hvac contractor', 'electrical contractor'],
    signal: 'none',
    reachTitles: ['hr (manager|director)', 'human resources', 'talent', 'recruit', 'operations manager', 'plant manager', 'office manager', 'owner', 'president', 'ceo'],
    avoidTitles: ['intern', 'student'],
    pitch: {
      offer: 'pre-screened candidates for their open role',
      angle: 'Mention the role they are hiring for and offer one qualified candidate this week.',
      rules: ['One ask: a short call or a reply. No fees named.'],
    },
    draft: true, // signal (new job posts) not built yet
  },
};

function get(key) { return PLAYBOOKS[String(key || '')] || null; }

// Why a business is not a fit for this playbook, or null when it is.
function skipReason(playbook, b) {
  const s = playbook.skip;
  if (!s) return null;
  const keep = s.keepNames && new RegExp(s.keepNames, 'i').test(b.name || '');
  const type = String(b.category || '').toLowerCase().trim();
  if (!keep && (s.types || []).includes(type)) return `a ${type}`;
  if (!keep && s.names && new RegExp(s.names, 'i').test(b.name || '')) return 'a large organization';
  if (s.maxLocations && (b.locations || 1) > s.maxLocations) return `a chain (${b.locations} locations on one website)`;
  return null;
}
function list() { return Object.values(PLAYBOOKS).map((p) => ({ key: p.key, label: p.label, ready: !p.draft })); }

// Rank a person against the playbook: lower is better, Infinity = never.
function titleRank(playbook, title) {
  const t = String(title || '').toLowerCase().trim();
  if (!t) return 50;
  if ((playbook.avoidTitles || []).some((a) => t.includes(a))) return Infinity;
  const i = (playbook.reachTitles || []).findIndex((src) => new RegExp('\\b(' + src + ')\\b', 'i').test(t));
  return i === -1 ? 40 : i;
}

module.exports = { PLAYBOOKS, get, list, titleRank, skipReason };
