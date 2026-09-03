'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings, and a startup wait the runner can shorten once the schema
// has been migrated once.
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

// ── FOUR BUGS FROM ONE LIVE RUN OF 31 CARDS ─────────────────────────────────
//
// 1. ZERO EMAIL CARDS. The ladder held four real addresses and every one queued
//    as a call card, because the channel decision searched tier 3 only and a
//    named owner's address lives on their row in tier 1 or 2.
// 2. ONE BRAND FOR NINE ATHLETES. The per-athlete program cap says nothing
//    about the roster, and the lanes rank identically for everyone.
// 3. A WIDEN THAT FOUND 159 BUSINESSES AND PLACED NONE. Two causes: the job
//    discarded the results, and the writer and reader of the market pool used
//    different key spaces.
// 4. "looking forward to" READ AS A POSITION CLAIM, and "wide receiver" read as
//    disagreeing with a stored "WR".

const fs = require('fs');
const ROOT = REPO;
const CL = require(ROOT + 'server/services/contactLadder');
const Q = require(ROOT + 'server/services/outreachQueue');
const PW = require(ROOT + 'server/services/pitchWriter');
const RK = require(ROOT + 'server/services/regionKey');
const store = require(ROOT + 'server/store');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const ladderWith = (contacts, extra) => CL.buildContactLadder(
  Object.assign({ brand: 'B', businessPhone: '2055551212', website: 'https://b.com', contacts },
    extra || {}), { brand: 'B' });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  console.log('\n-- 1. THE FOUR ADDRESSES THAT BECAME CALL CARDS --');
  {
    // Every one of these is a real address from the run, on a NAMED OWNER'S ROW,
    // which is tier 1 or tier 2. The channel decision looked at tier 3 alone.
    const real = [
      ['ronda@trevssportsbar.com', 'Ronda Perkins', 'published'],
      ['rebennett@downtownac.com', 'R Bennett', 'hunter'],
      ['jeffassadi@yahoo.com', 'Jeff Assadi', 'bio'],
    ];
    for (const [email, name, src] of real) {
      const l = ladderWith([{ name, title: 'Owner', email, emailSource: src }]);
      const tiers = (l.tiers || []).map((t) => t.tier);
      ok(`${email} is on tier ${tiers.join('/')} — NOT tier 3`, !tiers.includes(3), tiers);
      ok('  and it is now an EMAIL card', Q.channelFor(l, { instagram: null }) === 'email',
        Q.channelFor(l, { instagram: null }));
      ok('  carrying the address and its provenance',
        (Q.inboxOf(l) || {}).email === email && (Q.inboxOf(l) || {}).kind === src, Q.inboxOf(l));
    }
    // The fourth was a general inbox, which WAS on tier 3 and should always have
    // worked. Asserted so the fix is not credited for something that was fine.
    const gen = ladderWith([], { genericInbox: 'info@primetimesportsbar.com' });
    ok('info@ was on tier 3 and is an email card',
      Q.channelFor(gen, { instagram: null }) === 'email');

    // ── THE BAR HAD THE SAME BLIND SPOT, AND IT IS WORSE THERE ─────────────
    // channelFor misroutes; passesBar DISCARDS. A business reachable only by a
    // named owner's address was called unreachable and thrown away.
    const emailOnly = CL.buildContactLadder({ brand: 'B', website: 'https://b.com',
      contacts: [{ name: 'Ronda Perkins', title: 'Owner',
        email: 'ronda@trevssportsbar.com', emailSource: 'published' }] }, { brand: 'B' });
    const bar = Q.passesBar(emailOnly, { instagram: null });
    ok('AN ADDRESS-ONLY BUSINESS PASSES THE BAR', bar.ok === true, bar);
    ok('  and the bar agrees with the channel about how we reach them',
      bar.via === 'inbox', bar);

    // ── WHICH PROVENANCES MAY CARRY A SEND ────────────────────────────────
    // An invented address is a bounce against the AGENT'S OWN sending domain.
    for (const bad of ['searched', 'made-up-source']) {
      const l = ladderWith([{ name: 'X Y', title: 'Owner', email: 'guess@b.com', emailSource: bad }]);
      ok(`a "${bad}" address does NOT become a send`,
        Q.channelFor(l, { instagram: null }) !== 'email', Q.inboxOf(l));
    }
    ok('  and the allow-list is named, not implied',
      Q.SENDABLE_EMAIL_KINDS.has('published') && Q.SENDABLE_EMAIL_KINDS.has('hunter')
        && Q.SENDABLE_EMAIL_KINDS.has('bio') && !Q.SENDABLE_EMAIL_KINDS.has('searched'),
      [...Q.SENDABLE_EMAIL_KINDS]);

    // BEST FIRST. The tiers are already in quality order, so walking them in
    // order is the precedence with no new ranking: the owner's own mailbox
    // outranks the website's, which outranks info@.
    const both = ladderWith(
      [{ name: 'Ronda Perkins', title: 'Owner', email: 'ronda@b.com', emailSource: 'published' }],
      { genericInbox: 'info@b.com' });
    ok('THE OWNER\'S MAILBOX BEATS info@', (Q.inboxOf(both) || {}).email === 'ronda@b.com',
      Q.inboxOf(both));
    ok('  and every address we hold is still listed', Q.emailRowsOf(both).length === 2,
      Q.emailRowsOf(both).map((r) => r.email));

    // A handle must not outrank an address: an email sends itself, a DM is a
    // copy and a paste.
    const withIg = ladderWith([{ name: 'Ronda Perkins', title: 'Owner',
      email: 'ronda@b.com', emailSource: 'published' }]);
    ok('email still beats a DM',
      Q.channelFor(withIg, { instagram: '@trevs', instagramScope: 'location' }) === 'email');
    const noEmail = ladderWith([{ name: 'Sam Cole', title: 'Owner', phone: '2055559999' }]);
    ok('  and with no address a handle still wins over a call',
      Q.channelFor(noEmail, { instagram: '@trevs', instagramScope: 'location' }) === 'dm');
    ok('  and with neither it is a call',
      Q.channelFor(noEmail, { instagram: null }) === 'call');
  }

  console.log('\n-- 2. ONE BRAND CANNOT BE EVERY ATHLETE\'S PROGRAM CARD --');
  {
    ok('there is a per-brand nightly ceiling', Q.PROGRAM_BRAND_NIGHTLY_MAX >= 1,
      Q.PROGRAM_BRAND_NIGHTLY_MAX);
    ok('  which is smaller than a roster', Q.PROGRAM_BRAND_NIGHTLY_MAX < 9);
    ok('  and separate from the per-athlete cap', Q.PROGRAM_SLOT_CAP === 1);
    ok('the ceiling is reached at the cap',
      !Q.programBrandCapReached(Q.PROGRAM_BRAND_NIGHTLY_MAX - 1)
        && Q.programBrandCapReached(Q.PROGRAM_BRAND_NIGHTLY_MAX));
    // NAME VARIANTS SHARE ONE ALLOWANCE, or a brand spends it twice.
    ok('"Lenny & Larry\'s" and "Lenny and Larry\'s" are one brand',
      Q.programBrandKey("Lenny & Larry's") === Q.programBrandKey("Lenny and Larry's"),
      [Q.programBrandKey("Lenny & Larry's"), Q.programBrandKey("Lenny and Larry's")]);
    ok('  and casing and spacing do not split it',
      Q.programBrandKey('LENNY  &  LARRY S') === Q.programBrandKey("lenny and larry's"));
    ok('  a different brand is a different key',
      Q.programBrandKey('RYZE Superfoods') !== Q.programBrandKey("Lenny & Larry's"));

    // Nine athletes, one brand at the top of every slate: the shape of the run.
    const tally = new Map();
    let placed = 0, skipped = 0;
    for (let i = 0; i < 9; i++) {
      const k = Q.programBrandKey("Lenny & Larry's");
      if (Q.programBrandCapReached(tally.get(k) || 0)) { skipped++; continue; }
      tally.set(k, (tally.get(k) || 0) + 1); placed++;
    }
    ok('NINE ATHLETES, ONE BRAND: it takes the cap and no more',
      placed === Q.PROGRAM_BRAND_NIGHTLY_MAX && skipped === 9 - placed, { placed, skipped });

    const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
    ok('the run builds ONE tally for the whole roster',
      /const programBrandTally = await loadProgramBrandTally\(pool, agent\.id\)/.test(job), null);
    ok('  and threads it through every athlete', /^\s*programBrandTally,$/m.test(job), null);
    ok('  seeded from the database, so a restart does not reset the ceiling',
      /FROM outreach_queue[\s\S]{0,200}channel = 'program'[\s\S]{0,120}INTERVAL '20 hours'/.test(job), null);
    ok('  and the on-demand path reads the same answer',
      /ctx\.programBrandTally\s*\n?\s*\|\| await loadProgramBrandTally\(pool, agentId\)/.test(job), null);
    ok('THE CHECK IS BEFORE THE MONEY, like the per-athlete cap',
      job.indexOf('Q.programBrandCapReached') < job.indexOf('findInstagram(cand.website'), null);
    ok('  and a placed card bumps the tally at BOTH placement sites',
      (job.match(/_tallyProgram\(programBrandTally, pcard\.brandName\)/g) || []).length === 2, null);
    ok('  and a tally that cannot be read fails OPEN rather than stopping the run',
      /program brand tally: /.test(job), null);
  }

  console.log('\n-- 3. THE WIDENED POOL REACHES THE SLATE --');
  {
    // ── CAUSE A: THREE KEY FUNCTIONS, NO TWO AGREEING ──────────────────────
    const dk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
    ok('THE OLD WRITE KEY AND THE READ KEY NEVER MATCHED',
      dk('Auburn University') !== RK.canonicalRegion('Auburn, AL'),
      [dk('Auburn University'), RK.canonicalRegion('Auburn, AL')]);
    ok('there is ONE key function now', typeof RK.marketPoolKey === 'function');
    ok('  and it is the town, because a business is in a town, not at a school',
      RK.marketPoolKey('Auburn, AL') === RK.canonicalRegion('Auburn, AL')
        && RK.marketPoolKey('Auburn, AL') === 'auburn, al', RK.marketPoolKey('Auburn, AL'));
    ok('  two schools in one town therefore share one pool',
      RK.marketPoolKey('Waltham, MA') === RK.marketPoolKey('waltham, ma'));
    ok('  and no market means no key, rather than a key nothing reads',
      RK.marketPoolKey('') === null && RK.marketPoolKey(null) === null);

    const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
    ok('THE DEAL SCAN WRITES UNDER THE MARKET, not the school slug',
      /const mk = marketPoolKey\(_rec\.market\)/.test(idx)
        && !/const mk = _deepenMarketKey\(loaded\.athleteObj\.school\)/.test(idx), null);
    ok('  and refuses to write with no market',
      /not recording a market pool under a key nothing reads/.test(idx), null);
    const scout = fs.readFileSync(ROOT + 'server/services/scout.js', 'utf8');
    ok('  which is the key the Scout reads',
      /m\.market_key = \$1/.test(scout) && /athlete\.marketKey/.test(scout), null);

    // ── CAUSE B: THE WIDEN THREW ITS RESULTS AWAY ──────────────────────────
    const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
    ok('THE WIDEN KEEPS WHAT IT FOUND',
      /const widened = await ai\.getDealRecommendations\(athObj, 'agent', \[\], 'local', \{ deepen: true \}\)/
        .test(job), null);
    ok('  and records it in the pool the Scout reads',
      /store\.markMarketNewcomers\(profile\.marketKey, brands\)/.test(job), null);
    ok('  before re-assembling the slate',
      job.indexOf('markMarketNewcomers(profile.marketKey') < job.indexOf('after widening'), null);
    ok('  and says so when there is no key to file them under',
      /widened but has no market key/.test(job), null);
    ok('  the discarded-result call is gone',
      !/^\s*await ai\.getDealRecommendations\(athObj/m.test(job), null);

    // ── AND THE ROUND TRIP, AGAINST THE REAL TABLE ─────────────────────────
    // Write under the key the Deal Scan and the widen now use; read with the
    // Scout's own query. This is the trip that has never completed.
    const mk = RK.marketPoolKey('Waltham, MA');
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [mk]);
    await store.markMarketNewcomers(mk, ["Trev's Sports Bar", 'Downtown AC', 'Prime Time Sports Bar']);
    const back = await P.query(
      `SELECT m.brand AS brand_name FROM market_business_seen m WHERE m.market_key = $1`, [mk]);
    ok('WHAT THE WIDEN WRITES IS WHAT THE SCOUT READS', back.rowCount === 3, back.rowCount);
    // And the old key writes nothing the Scout can find, which is the bug.
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [dk('Bentley University')]);
    await store.markMarketNewcomers(dk('Bentley University'), ['Orphaned Cafe']);
    const orphan = await P.query(
      `SELECT 1 FROM market_business_seen WHERE market_key = $1`, [mk]);
    ok('  while the OLD key lands somewhere the Scout never looks',
      orphan.rowCount === 3, orphan.rowCount);
    await P.query(`DELETE FROM market_business_seen WHERE market_key = ANY($1::text[])`,
      [[mk, dk('Bentley University')]]);
  }

  console.log('\n-- 4. THE VOICE CHECKER READS CONTEXT --');
  {
    const wr = { name: 'Amari Allen', position: 'WR', sport: 'football', year: 'junior' };
    const probs = (m, a) => PW.verifyAthleteFacts(m, a || wr).problems || [];

    // ── THE REPORTED FAILURE ────────────────────────────────────────────────
    // "forward" was always matched on a word boundary, so this was never a
    // substring problem -- "looking forward to" IS a whole token. It is a
    // context problem.
    ok('THE REPORTED BUG: "looking forward to" is not a position claim',
      probs('I wanted to call your attention to Amari Allen, a wide receiver on the '
        + 'Auburn football team. I am looking forward to hearing what you think.').length === 0,
      probs('I wanted to call your attention to Amari Allen, a wide receiver on the '
        + 'Auburn football team. I am looking forward to hearing what you think.'));

    // ── AND THE ONE UNDERNEATH IT ──────────────────────────────────────────
    // Positions are STORED as abbreviations and the prescribed voice writes them
    // out, so the check compared "wide receiver" with "WR" as strings and
    // refused the opener we asked the model for. That rejected essentially
    // every football pitch written in the new voice.
    ok('"wide receiver" AGREES WITH A STORED "WR"',
      probs('Amari Allen, a wide receiver on the Auburn football team.').length === 0,
      probs('Amari Allen, a wide receiver on the Auburn football team.'));
    ok('  by group, not by string', PW.positionKey('WR') === PW.positionKey('wide receiver'),
      [PW.positionKey('WR'), PW.positionKey('wide receiver')]);
    for (const [a, b] of [['QB', 'quarterback'], ['RB', 'running back'], ['TE', 'tight end'],
      ['LB', 'linebacker'], ['corner', 'cornerback'], ['keeper', 'goalkeeper']]) {
      ok(`  ${a} = ${b}`, PW.positionKey(a) === PW.positionKey(b), [PW.positionKey(a), PW.positionKey(b)]);
    }
    ok('  an unrecognised stored position still matches itself',
      PW.positionKey('slotback') === null
        && probs('Amari Allen is a quarterback.', { ...wr, position: 'slotback' }).length === 1, null);

    // ── EVERY ORDINARY WORD THAT IS ALSO A POSITION, SPORT OR CLASS YEAR ────
    // Each of these is a perfectly normal thing to write to a local business,
    // and each would have refused the pitch.
    const named = 'I wanted to call your attention to Amari Allen. ';
    for (const [what, line] of [
      ['corner of a street', 'Your shop on the corner of Highland has been there nine years.'],
      ['a community center', 'The community center down the road runs a camp.'],
      ['a security guard', 'Your security guard knows every regular by name.'],
      ['a safety record', 'Nine years of food safety inspections with no marks.'],
      ['a bowling alley', 'Your bowling alley draws exactly the audience she reaches.'],
      ['a golf shop', 'Your golf shop is a fixture on Highland.'],
      ['a track record', 'Your track record with local sponsorships speaks for itself.'],
      ['Junior\'s Diner', 'Junior\'s Diner has been a fixture on that block.'],
      ['a senior discount', 'Your senior discount is well known locally.'],
      ['a pitcher of beer', 'A pitcher of your house lager is the best value in town.'],
    ]) {
      ok(`  "${what}" is not a claim about the athlete`,
        probs(named + line).length === 0, probs(named + line));
    }

    // ── AND THE CHECK STILL CATCHES WHAT IT IS FOR ─────────────────────────
    // A looser checker that passes everything is not a fix.
    ok('STILL CAUGHT: the wrong position',
      probs('Amari Allen, a quarterback on the Auburn football team.')
        .some((p) => /quarterback/.test(p)));
    ok('STILL CAUGHT: an invented ambiguous position',
      probs('Amari Allen, a forward on the Auburn team.').some((p) => /forward/.test(p)));
    ok('STILL CAUGHT: the wrong sport',
      probs('Amari Allen plays basketball at Auburn.').some((p) => /basketball/.test(p)));
    ok('STILL CAUGHT: the wrong class year',
      probs('Amari Allen is a senior at Auburn.').some((p) => /senior/.test(p)),
      probs('Amari Allen is a senior at Auburn.'));
    // "at Auburn" is a school; "at 6am" is a time. The capital is the whole
    // difference, and without it every "at" would reopen the false positives.
    ok('  but "at the community center at 6am" still is not a claim',
      probs('Amari Allen trains at the community center at 6am.').length === 0,
      probs('Amari Allen trains at the community center at 6am.'));
    ok('STILL CAUGHT: a claim in a sentence that only refers back',
      probs('I wanted to call your attention to Amari Allen. She is a quarterback.')
        .some((p) => /quarterback/.test(p)));
    ok('STILL CAUGHT: a position when we hold none',
      probs('Amari Allen, a quarterback.', { name: 'Amari Allen' })
        .some((p) => /and we hold none/.test(p)));
    ok('  and the right ambiguous position is accepted',
      probs('Amari Allen, a forward on the Auburn basketball team.',
        { name: 'Amari Allen', position: 'forward', sport: 'basketball', year: 'junior' })
        .length === 0);

    const pw = fs.readFileSync(ROOT + 'server/services/pitchWriter.js', 'utf8');
    ok('the ordinary-word list is named and explained',
      /SOFT_WORDS/.test(pw) && /also an ordinary word/i.test(pw), null);
    ok('  and a claim is scoped to the sentences about the athlete',
      /_athleteScoped/.test(pw), null);
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
