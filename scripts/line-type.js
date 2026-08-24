#!/usr/bin/env node
// scripts/line-type.js
//
// Is this number a mobile, a landline, or VoIP? Used by ladder-sample.js so
// "phone found 20/20" becomes something you can act on: a restaurant's landline
// is a call at 2pm on a Tuesday, a sole proprietor's cell is a text.
//
// WHY A LIVE LOOKUP AND NOT A PREFIX TABLE. US local number portability means the
// NPA-NXX no longer says whether a number is served by a wireline or a wireless
// carrier -- over 100 million numbers have been ported since 2003, in both
// directions. An offline prefix table would be wrong precisely where it matters
// most here: the owner who took the shop's old landline number with them onto a
// cell. A confident wrong answer is worse than no answer, so there is no offline
// fallback and an unclassifiable number is reported as 'unknown', never guessed.
//
// PROVIDER: Numverify (apilayer), free tier, 100 lookups a month, no card. Every
// answer is cached BY NUMBER in a local JSON file, so a re-run of the same market
// costs nothing and a number is never bought twice. A 20-business sample is about
// 24 lookups, so the free tier covers roughly four runs a month.
//
// NOTHING IS SPENT UNLESS A PROVIDER IS PASSED IN. newLookup({}) is inert and
// returns null for everything, which is what ladder-sample does without --carrier.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE = path.join(__dirname, '.line-type-cache.json');
const TIMEOUT_MS = parseInt(process.env.LINE_TYPE_TIMEOUT_MS, 10) || 8000;
// The free plan is HTTP-only on apilayer; paid plans allow HTTPS. Overridable so
// a paid key does not have to run in the clear.
const NUMVERIFY_BASE = process.env.NUMVERIFY_BASE || 'http://apilayer.net/api/validate';

// Numverify's line_type vocabulary, collapsed to the three that change what an
// agent does. Anything unrecognised is 'unknown' rather than being forced into a
// bucket it does not belong in.
const TYPE_MAP = {
  mobile: 'mobile',
  landline: 'landline',
  voip: 'voip',
  fixed_line: 'landline',
  fixed_line_or_mobile: 'unknown',
  toll_free: 'landline',
  premium_rate: 'landline',
  special_services: 'landline',
  satellite: 'unknown',
  paging: 'unknown',
};

// 10 digits, NANP. Anything else is not a number we can classify, and saying so
// is free -- it must never reach the provider and be billed.
function toDigits(phone) {
  const d = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return d.length === 10 ? d : null;
}

function normalizeType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return 'unknown';
  return TYPE_MAP[t] || 'unknown';
}

// provider(digits) -> the provider's raw line_type string, or null.
function numverifyProvider(apiKey) {
  if (!apiKey) return null;
  return async function lookup(digits) {
    const url = NUMVERIFY_BASE + '?access_key=' + encodeURIComponent(apiKey)
      + '&number=1' + digits + '&country_code=US&format=1';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { signal: ctrl.signal });
    } finally { clearTimeout(t); }
    if (!resp.ok) throw new Error('numverify http=' + resp.status);
    const j = await resp.json();
    // apilayer reports quota and key errors in a 200 body, so the status code
    // alone does not tell you the run has stopped working.
    if (j && j.success === false) {
      const info = (j.error && (j.error.info || j.error.type)) || 'unknown error';
      throw new Error('numverify: ' + info);
    }
    if (!j || j.valid === false) return null;
    return j.line_type || null;
  };
}

function newLookup(opts) {
  const o = opts || {};
  const provider = typeof o.provider === 'function' ? o.provider : null;
  const cacheFile = o.cacheFile === null ? null : (o.cacheFile || DEFAULT_CACHE);
  let cache = {};
  if (cacheFile) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch (_) { cache = {}; }
  }
  let spent = 0, dirty = false;

  return {
    // 'mobile' | 'landline' | 'voip' | 'unknown', or null when there is nothing
    // to classify or no provider configured.
    async classify(phone) {
      const digits = toDigits(phone);
      if (!digits) return null;
      if (Object.prototype.hasOwnProperty.call(cache, digits)) return cache[digits];
      if (!provider) return null;
      let value;
      try {
        value = normalizeType(await provider(digits));
      } catch (e) {
        // A dead provider must not take the whole run with it, and must not be
        // cached either -- a quota error today is not a fact about the number.
        console.warn('[line-type] ' + digits + ' lookup failed: ' + (e && e.message));
        return 'unknown';
      }
      spent++;
      cache[digits] = value;
      dirty = true;
      return value;
    },
    count() { return spent; },
    cached() { return Object.keys(cache).length; },
    save() {
      if (!cacheFile || !dirty) return;
      try { fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2)); } catch (e) {
        console.warn('[line-type] could not write ' + cacheFile + ': ' + e.message);
      }
    },
  };
}

// Named so ladder-sample can say WHICH provider ran in the summary.
function providerFor(name, env) {
  const e = env || process.env;
  if (!name) return { provider: null, label: null };
  if (String(name).toLowerCase() === 'numverify') {
    // TRIMMED. This was passed straight to encodeURIComponent, so a trailing
    // newline from a .env file or a shell export went up the wire as %0A and
    // every call came back http=401 -- which reads exactly like a bad key, and
    // meant line type came back "unknown" for all 20 numbers without anything
    // saying why.
    const key = String(e.NUMVERIFY_API_KEY || '').trim();
    if (!key) {
      console.error('--carrier numverify needs NUMVERIFY_API_KEY in the environment.');
      console.error('Free key, 100 lookups a month, no card: https://numverify.com/product');
      process.exit(2);
    }
    return { provider: numverifyProvider(key), label: 'numverify' };
  }
  console.error('Unknown carrier provider: ' + name + '. Supported: numverify');
  process.exit(2);
  return { provider: null, label: null };
}

module.exports = { newLookup, numverifyProvider, providerFor, toDigits, normalizeType, DEFAULT_CACHE };
