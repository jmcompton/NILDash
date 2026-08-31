'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// REPRODUCTION FIRST. Why did a fetch with a 12s AbortController cap hang on
// California? Because the timer is cleared when the HEADERS arrive, and the body is
// read afterwards with nothing bounding it.
//
//   const resp = await fetch(url, { signal: ctrl.signal, ... });
//   clearTimeout(t);          <-- cap is gone here
//   let html = await resp.text();   <-- unbounded
//
// A server that answers 200 promptly and then trickles (or never finishes) the body
// hangs forever. The cap only ever covered connect + headers.
const staffPage = require(REPO + 'server/services/staffPage.js');

let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const realFetch = global.fetch;

// A response that returns headers instantly and then never finishes its body. Two
// shapes, because the two code paths differ: a streaming body whose reader never
// yields, and a runtime with no streaming body at all falling back to .text().
function stallingStream(signal) {
  const never = (resolve, reject) => {
    if (signal) signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  };
  return {
    ok: true, status: 200, url: 'https://calbears.com/staff-directory',
    body: { getReader: () => ({ read: () => new Promise(never), cancel: async () => {} }) },
    text: () => new Promise(never),
  };
}
function stallingText(signal) {
  const never = (resolve, reject) => {
    if (signal) signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  };
  return { ok: true, status: 200, url: 'https://calbears.com/staff-directory', body: null, text: () => new Promise(never) };
}

// The cap is asserted by measuring against a WINDOW SEVERAL TIMES the cap, so the
// test proves boundedness rather than just outrunning a longer timer. Racing a 3s
// window against a 12s cap would report a correctly-bounded fetch as a hang.
async function boundedWithin(make, capMs, windowMs, label) {
  global.fetch = async (url, opts) => make(opts && opts.signal);
  const t0 = Date.now();
  const race = await Promise.race([
    staffPage.fetchStaffPage('https://calbears.com/staff-directory', { timeoutMs: capMs }),
    new Promise((r) => setTimeout(() => r({ __verdict: 'STILL RUNNING' }), windowMs)),
  ]);
  const ms = Date.now() - t0;
  global.fetch = realFetch;
  if (race.__verdict === 'STILL RUNNING') {
    console.log(`  ${label}: still running after ${ms}ms with a ${capMs}ms cap. UNBOUNDED.`);
  } else {
    console.log(`  ${label}: returned after ${ms}ms as ${race.reason}`);
  }
  return race;
}

(async () => {
  console.log('-- headers arrive fast, body never finishes --');
  const r1 = await boundedWithin(stallingStream, 600, 6000, 'streaming body');
  ok('a stalled STREAMING body is cut off at the cap',
    r1.__verdict !== 'STILL RUNNING' && r1.ok === false && /timeout/.test(r1.reason || ''),
    r1.__verdict || r1.reason);
  const r2 = await boundedWithin(stallingText, 600, 6000, 'text() fallback');
  ok('a stalled .text() fallback is cut off at the cap',
    r2.__verdict !== 'STILL RUNNING' && r2.ok === false && /timeout/.test(r2.reason || ''),
    r2.__verdict || r2.reason);

  console.log('\n-- an enormous body is cut off, not buffered whole --');
  // 3MB cap applied AFTER .text() means a 500MB response is fully read into memory
  // first. Streaming with a running byte count is what makes the cap a real cap.
  let served = 0;
  const CHUNK = 'x'.repeat(100_000);
  global.fetch = async () => ({
    ok: true, status: 200, url: 'https://huge.example/staff',
    body: {
      getReader: () => ({
        read: async () => { served += CHUNK.length; return { done: false, value: Buffer.from(CHUNK) }; },
        cancel: async () => {},
      }),
    },
    text: async () => { served = 50_000_000; return 'x'.repeat(50_000_000); },
  });
  const big = await staffPage.fetchStaffPage('https://huge.example/staff');
  global.fetch = realFetch;
  ok('stopped reading near the cap rather than buffering everything',
    served <= 4_000_000, `read ${served} bytes`);
  ok('the returned html is capped', big.ok && big.html.length <= 3_200_000, big.ok ? big.html.length : big.reason);

  console.log('\n-- a caller can ask for a tighter cap --');
  global.fetch = async (url, opts) => {
    return new Promise((resolve, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    });
  };
  const t1 = Date.now();
  const tight = await staffPage.fetchStaffPage('https://slow.example/staff', { timeoutMs: 400 });
  const el = Date.now() - t1;
  global.fetch = realFetch;
  ok('a 400ms cap returns in well under a second', el < 2000, el);
  ok('and reports it as a timeout', tight.ok === false && /timeout/.test(tight.reason || ''), tight.reason);

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})();
