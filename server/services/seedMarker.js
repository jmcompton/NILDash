'use strict';
// ── WHICH VALUES WERE FABRICATED, AND WHICH ARE REAL ─────────────────────────
//
// Demo data becomes production data by being indistinguishable from it. A seeded
// follower count stamped source 'athlete' and today's date looks exactly like one
// an athlete typed in during onboarding -- which is the point for a demo, and
// exactly the reason it has to be marked.
//
// THE MARKER IS PER FIELD, NOT PER ROW. "This athlete is seeded" stops being true
// the moment one real value is entered, and a marker that is only mostly true is
// worse than none: it gets ignored. Recording which fields were seeded means the
// answer stays exact as fields are replaced one at a time.
//
// AND IT CLEARS ITSELF. Every write path that overwrites a field calls clear() for
// that field, so a value replaced by a real one stops being reported as seeded on
// the same write. Nothing has to remember to tidy up.

const KEY = '_seed';

// Merge a seed record into an athlete's data, marking exactly the fields written.
function stamp(existing, fields, opts = {}) {
  const prev = (existing && existing[KEY]) || {};
  const prevFields = Array.isArray(prev.fields) ? prev.fields : [];
  return {
    at: opts.at || new Date().toISOString(),
    by: opts.by || 'seed',
    note: opts.note || 'Fabricated demo data. Not supplied by the athlete or the agent.',
    fields: Array.from(new Set(prevFields.concat(fields))).sort(),
  };
}

// Is this specific field seeded?
function isSeeded(data, field) {
  const s = data && data[KEY];
  return !!(s && Array.isArray(s.fields) && s.fields.indexOf(field) !== -1);
}

// Which of this athlete's fields are still fabricated.
function seededFields(data) {
  const s = data && data[KEY];
  return s && Array.isArray(s.fields) ? s.fields.slice() : [];
}

// Drop fields from the marker because real values just replaced them. Returns the
// new marker, or null when nothing seeded is left -- so the key disappears
// entirely rather than lingering as an empty husk that still reads as "seeded".
function clear(data, fields) {
  const s = data && data[KEY];
  if (!s || !Array.isArray(s.fields)) return null;
  const drop = new Set([].concat(fields));
  const left = s.fields.filter((f) => !drop.has(f));
  if (!left.length) return null;
  return Object.assign({}, s, { fields: left });
}

// The SQL fragment that clears a set of fields on a jsonb `data` column, for use
// inside an UPDATE. Written here so every caller clears it the same way and none
// of them has to hand-roll jsonb surgery.
//
// Removes the whole key when nothing is left, which is what makes "is anything
// about this athlete still fabricated" a simple `data ? '_seed'` test.
function clearSql(column, fieldsParam) {
  return `CASE
    WHEN ${column} -> '${KEY}' IS NULL THEN ${column}
    WHEN COALESCE(jsonb_array_length(
      (SELECT jsonb_agg(f) FROM jsonb_array_elements_text(${column} -> '${KEY}' -> 'fields') AS f
        WHERE f <> ALL(${fieldsParam}))), 0) = 0
      THEN ${column} - '${KEY}'
    ELSE jsonb_set(${column}, '{${KEY},fields}',
      (SELECT jsonb_agg(f) FROM jsonb_array_elements_text(${column} -> '${KEY}' -> 'fields') AS f
        WHERE f <> ALL(${fieldsParam})))
  END`;
}

module.exports = { KEY, stamp, isSeeded, seededFields, clear, clearSql };
