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
// Pre-warm: top cards first, and one retry that names what went wrong.
//
// A draft that tripped checkDraft was discarded and never revisited, so one
// "great fit" made that card a permanent two-minute click until the next scan.
// And the batch drafted in whatever order the array arrived, so whether the card
// the agent clicks first is ready was luck.
//
// The SHIPPED draftPrewarm is executed against a real Postgres with the model
// call injected, so the test sees every prompt and every retry.
const fs = require('fs'), cp = require('child_process'), Module = require('module');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const DB = 'prewarmfix';

function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/pf.sql', text);
  fs.chmodSync('/tmp/pgtest/pf.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/pf.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
  return (r.stdout || '').trim();
}
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function bind(t, p) { if (!p || !p.length) return t; let o = t; for (let i = p.length; i >= 1; i--) o = o.split('$' + i).join(lit(p[i - 1])); return o; }
function parseCsv(out) {
  const lines = []; let cur = '', inQ = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '"') { if (inQ && out[i + 1] === '"') { cur += '""'; i++; } else inQ = !inQ; cur += ch; continue; }
    if (ch === '\n' && !inQ) { lines.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  if (!lines.length) return [];
  const split = (l) => { const c = []; let s = '', q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { s += '"'; i++; } else q = !q; continue; }
      if (ch === ',' && !q) { c.push(s); s = ''; continue; } s += ch; }
    c.push(s); return c; };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => { const c = split(l), o = {}; head.forEach((h, i) => { o[h] = c[i] === '' ? null : c[i]; }); return o; });
}
const pool = {
  async query(text, params) {
    const s = bind(text, params);
    if (!(/^\s*(SELECT|WITH)/i.test(s) || /RETURNING/i.test(s))) { psql(s); return { rows: [], rowCount: 0 }; }
    const rows = parseCsv(psql(s, true));
    return { rows, rowCount: rows.length };
  },
};

psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
// sent_to_email and email_kind come from ALTERs in store.js init on a real
// database; this fixture builds the table by hand, so they are named here too.
// The draft insert carries the address now -- that is the fix for 115 of 120
// drafts being skipped for "no email address on file".
psql(`CREATE TABLE outreach_logs (id TEXT PRIMARY KEY, agent_id TEXT, athlete_id TEXT,
        brand_name TEXT, brand_key TEXT, subject TEXT, body_html TEXT, status TEXT,
        source TEXT, sent_to_email TEXT, email_kind TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());`);
psql(`CREATE TABLE IF NOT EXISTS brand_evidence_cache (brand_key TEXT, lane TEXT, brand TEXT,
        website TEXT, evidence JSONB, outcome TEXT, refreshed_at TIMESTAMPTZ DEFAULT NOW());`);

// ── load the shipped module with the model injected ─────────────────────────
let prompts = [];
let RESPOND = null;      // (prompt, callIndex) => raw string, or throw
const origLoad = Module._load;
Module._load = function (req) {
  if (req === '../store') return { pool };
  if (req === '../ai') return {
    resolveBrandKey: (card) => 'key:' + String(card.brand || '').toLowerCase().replace(/\W+/g, '-'),
    withDeadline: (p) => p,
    oneShot: async (prompt) => {
      prompts.push(prompt);
      return RESPOND(prompt, prompts.length - 1);
    },
  };
  return origLoad.apply(this, arguments);
};
delete require.cache[require.resolve(REPO + 'server/services/draftPrewarm.js')];
const pw = require(REPO + 'server/services/draftPrewarm.js');
Module._load = origLoad;

const ATH = { name: 'Amari Allen', sport: 'Track', school: 'Samford', instagram: 18400 };
const good = (brand) => JSON.stringify({
  subject: 'Amari Allen x ' + brand,
  body: 'Hi,\n\nAmari Allen runs distance at Samford and trains near ' + brand
    + '. She would film one session a month in your space. Worth a short call?',
});
const banned = (brand) => JSON.stringify({
  subject: 'Amari Allen x ' + brand,
  body: 'Hi,\n\nAmari Allen would be a great fit for ' + brand + '. She runs distance at Samford.',
});
const card = (brand, rank, fit) => ({ brand, rank, fitScore: fit, category: 'gym', rationale: 'r' });
const reset = () => { prompts = []; psql('DELETE FROM outreach_logs;'); };

(async () => {
  console.log('-- A REJECTED DRAFT IS RETRIED ONCE, AND TOLD WHY --');
  {
    reset();
    let n = 0;
    RESPOND = (p) => { n++; return n === 1 ? banned('Iron Tribe') : good('Iron Tribe'); };
    const r = await pw.draftOne({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH,
      card: card('Iron Tribe', 1, 90), agentName: 'John', lane: 'local' });
    ok('THE DRAFT IS SAVED, not dropped', r.drafted === true, r);
    ok('  it took two attempts', prompts.length === 2, prompts.length);
    ok('  and the result is marked as retried', r.retried === true, r);
    ok('the retry names the exact phrase that failed',
      /YOUR PREVIOUS ATTEMPT WAS REJECTED: contains banned filler "would be a great fit"/.test(prompts[1] || ''),
      (prompts[1] || '(no retry happened)').slice(0, 160));
    ok('  the first attempt carried no such line',
      !/PREVIOUS ATTEMPT/.test(prompts[0] || ''), (prompts[0] || '').slice(0, 80));
    const rows = parseCsv(psql('SELECT brand_name, source, status FROM outreach_logs', true));
    ok('  and the row is a normal prewarm draft', rows.length === 1 && rows[0].source === 'prewarm' && rows[0].status === 'draft', rows);
  }
  {
    reset();
    RESPOND = () => banned('Iron Tribe');       // fails twice
    const r = await pw.draftOne({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH,
      card: card('Iron Tribe', 1, 90), agentName: 'John', lane: 'local' });
    ok('two failures give up rather than looping', prompts.length === 2, prompts.length);
    ok('  and say it was after a retry', /after retry/.test(r.failed || ''), r);
    ok('  nothing is stored', parseCsv(psql('SELECT id FROM outreach_logs', true)).length === 0);
  }


  console.log('\n-- TOP CARDS ARE DRAFTED FIRST --');
  {
    // Guarded: an absent helper must FAIL loudly, not throw and skip the retry
    // assertions below, which are the ones that carry the behaviour.
    ok('an ordering helper exists', typeof pw.orderForPrewarm === 'function', typeof pw.orderForPrewarm);
    const order1 = typeof pw.orderForPrewarm === 'function' ? pw.orderForPrewarm : ((x) => x);
    const cards = [card('Tenth', 10, 40), card('First', 1, 95), card('Fifth', 5, 70)];
    const ordered = order1(cards).map((c) => c.brand);
    ok('rank decides the order', JSON.stringify(ordered) === JSON.stringify(['First', 'Fifth', 'Tenth']), ordered);
    const noRank = order1([
      { brand: 'Low', fitScore: 40 }, { brand: 'High', fitScore: 95 }, { brand: 'Mid', fitScore: 70 }]);
    ok('  fitScore decides when rank is absent',
      JSON.stringify(noRank.map((c) => c.brand)) === JSON.stringify(['High', 'Mid', 'Low']), noRank.map((c) => c.brand));
    const tie = order1([{ brand: 'A' }, { brand: 'B' }, { brand: 'C' }]);
    ok('  and a tie keeps the order it arrived in',
      JSON.stringify(tie.map((c) => c.brand)) === JSON.stringify(['A', 'B', 'C']), tie.map((c) => c.brand));
    const mixed = order1([{ brand: 'NoRank', fitScore: 99 }, card('Ranked', 3, 10)]);
    ok('  a ranked card outranks an unranked one whatever its score',
      mixed[0].brand === 'Ranked', mixed.map((c) => c.brand));
  }
  {
    reset();
    // CONCURRENCY is 3, so the first three prompts out are the first three cards.
    RESPOND = (p) => good((p.match(/- Business: (.+)/) || [])[1] || 'X');
    await pw.prewarmScan({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH, lane: 'local',
      cards: [card('Tenth', 10, 40), card('First', 1, 95), card('Second', 2, 90), card('Ninth', 9, 45)] });
    const order = prompts.map((p) => (p.match(/- Business: (.+)/) || [])[1]);
    ok('the batch drafts the top card first, not the array head',
      order[0] === 'First', order);
    ok('  and the top three are all in the first wave',
      order.slice(0, 3).indexOf('Tenth') === -1, order.slice(0, 3));
  }

  console.log('\n-- BUT A TIMEOUT IS NOT RETRIED --');
  {
    reset();
    RESPOND = () => { throw new Error('prewarm draft for X timed out after 45000ms'); };
    const r = await pw.draftOne({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH,
      card: card('Slow Co', 1, 90), agentName: 'John', lane: 'local' });
    ok('one attempt only: doubling the wait is what this feature exists to avoid',
      prompts.length === 1, prompts.length);
    ok('  and it is reported as the timeout it was', /timed out/.test(r.failed || ''), r);
  }
  {
    reset();
    RESPOND = () => 'not json at all';
    const r = await pw.draftOne({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH,
      card: card('Garbled', 1, 90), agentName: 'John', lane: 'local' });
    ok('an unparseable response is not retried either', prompts.length === 1, prompts.length);
    ok('  and is named', /unparseable/.test(r.failed || ''), r);
  }

  console.log('\n-- A DRAFT THAT PASSES FIRST TIME IS UNCHANGED --');
  {
    reset();
    RESPOND = () => good('Clean Co');
    const r = await pw.draftOne({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH,
      card: card('Clean Co', 1, 90), agentName: 'John', lane: 'local' });
    ok('one call', prompts.length === 1, prompts.length);
    ok('  saved', r.drafted === true, r);
    ok('  and NOT marked as retried', !r.retried, r);
  }

  console.log('\n-- ALREADY-DRAFTED STILL SHORT-CIRCUITS --');
  {
    reset();
    RESPOND = () => good('Clean Co');
    await pw.draftOne({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH,
      card: card('Clean Co', 1, 90), agentName: 'John', lane: 'local' });
    prompts = [];
    const again = await pw.draftOne({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH,
      card: card('Clean Co', 1, 90), agentName: 'John', lane: 'local' });
    ok('no second model call', prompts.length === 0, prompts.length);
    ok('  reported as cached', again.skipped === 'cached', again);
  }

  console.log('\n-- THE BATCH LINE REPORTS THE RETRIES --');
  {
    reset();
    let n = 0;
    RESPOND = (p) => { n++; return n === 1 ? banned('A') : good((p.match(/- Business: (.+)/) || [])[1] || 'X'); };
    const t = await pw.prewarmScan({ agentId: 'usr_john', athleteId: 'ath_a', athlete: ATH, lane: 'local',
      cards: [card('A', 1, 90), card('B', 2, 80)] });
    ok('both drafted', t.drafted === 2, t);
    ok('  and one is counted as a retry', t.retried === 1, t);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
