'use strict';
// ONE CANONICAL FORM FOR A REGION, used wherever a region goes into a cache key.
//
// The same business was being cached under different keys because each caller had
// its own idea of what a region string looks like:
//
//   the Deal Scan card    d.region                 "Fayetteville, AR"
//   the outreach workflow enrichmentRecord.location "Fayetteville, Arkansas"
//   Add a Business        place.address             "123 W Dickson St, Fayetteville, AR 72701"
//
// Three keys, one business. Every deep lookup re-paid for a Places call that was
// already cached, and the scan-time ladder warm wrote a row the click could never
// read -- silently, because a cache miss looks exactly like a cold business.
//
// This does not try to be a geocoder. It reduces a region to "city, ST" when it can
// recognise a state, and to a tidied lowercase string when it cannot, which is
// enough for two spellings of the same place to collide.

const { normalizeState } = require('../areaCodes');

// "AR 72701" -> "AR", "Arkansas" -> "Arkansas". A trailing ZIP is never part of the
// identity of a region for our purposes.
function _stripZip(s) {
  return String(s || '').replace(/\s+\d{5}(?:-\d{4})?\s*$/, '').trim();
}

function _tidy(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.]/g, '').trim();
}

// Canonical "city, st". Returns '' for an empty input so callers can keep their
// existing "no region" branch.
function canonicalRegion(loc) {
  const raw = String(loc == null ? '' : loc).trim();
  if (!raw) return '';
  const parts = raw.split(',').map((p) => _stripZip(p)).filter((p) => p.length);
  if (!parts.length) return '';

  // Walk from the end for the first segment that is a state. A street address has
  // the state second-from-last or last; a plain "City, State" has it last.
  for (let i = parts.length - 1; i >= 0; i--) {
    const st = normalizeState(parts[i]);
    if (!st) continue;
    const city = i > 0 ? _tidy(parts[i - 1]) : '';
    return city ? `${city}, ${st.toLowerCase()}` : st.toLowerCase();
  }
  // No recognisable state. Tidy the whole thing so at least casing and spacing
  // cannot split one business into two rows.
  return _tidy(parts.join(', '));
}

module.exports = { canonicalRegion };
