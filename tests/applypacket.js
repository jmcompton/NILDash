'use strict';
// Runs against the local test Postgres.
//
//   node tests/applypacket.js
//
// ── READY TO APPLY (services/applyPacket)
// Nov 13: the social lane made 196 program cards in 60 days and agents acted
// on none. They sat off Home with nothing filled in. Now each one carries the
// finished application, built from what we hold, and Home shows it.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('applypackettest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };

async function main() {
  const AP = require(REPO + 'server/services/applyPacket.js');
  const RECORD = require(REPO + 'server/services/athleteRecord.js');

  // ── THE PACKET, PURE ───────────────────────────────────────────────────
  const ath = RECORD.resolveAthlete({ id: 'a1', data: { name: 'Jordan Reese', school: 'Samford', sport: 'Football', position: 'Wide Receiver',
    year: 'Junior', hometown: 'Hoover, AL', instagramHandle: 'jreese', instagram: 2400 } });
  const brand = { brand: 'Gainz Fuel', category: 'Sports nutrition', offer_summary: 'Free product and a commission on sales', proof_url: 'https://gainzfuel.example/athletes' };
  const card = { brand_name: 'Gainz Fuel', program_url: 'https://gainzfuel.example/athletes' };
  const v = { asOf: '2026-11-10', followers: 2512, avgReachPerPost: 1840, cityRows: [{ key: 'Birmingham, Alabama', value: 610 }, { key: 'Hoover, Alabama', value: 300 }] };
  const p = AP.build({ card, athlete: ath, brand, verifiedIg: v, fit: { kinds: ['sport'], lines: ['x'] }, mediaKitUrl: 'https://mynildash.com/media-kit/jreese',
    agent: { name: 'Pat Agent', email: 'pat@agency.example' } });
  const get = (pk, label) => (pk.fields.find((f) => f.label === label) || {}).value;
  ok('the link is the program page', p.programUrl === 'https://gainzfuel.example/athletes', p.programUrl);
  ok('name, school, sport, position, year, hometown', get(p, 'Full name') === 'Jordan Reese' && get(p, 'School') === 'Samford' && get(p, 'Sport') === 'Football'
    && get(p, 'Position') === 'Wide Receiver' && get(p, 'Class year') === 'Junior' && get(p, 'Hometown') === 'Hoover, AL', p.fields);
  ok('Instagram: the connected account\'s own number, dated, not the agent\'s', /2,512 followers \(verified by Instagram, 2026-11-10\)/.test(get(p, 'Instagram')) && /@jreese/.test(get(p, 'Instagram')), get(p, 'Instagram'));
  ok('reach per post and the top follower city', /1,840/.test(get(p, 'Average reach per post') || '') && get(p, 'Top follower city') === 'Birmingham, Alabama', p.fields);
  ok('the media kit link', get(p, 'Media kit') === 'https://mynildash.com/media-kit/jreese');
  const why = get(p, "Why I'm a fit for Gainz Fuel") || '';
  ok('why: in the athlete\'s voice, from facts', /^I'm a junior on the Samford football team, playing Wide Receiver\./.test(why) && /2,512 people follow me/.test(why) && /works with football athletes/.test(why), why);
  ok('content ideas follow the brand\'s category', /before football practice/.test(get(p, 'Content I would create') || ''), get(p, 'Content I would create'));
  ok('representation: the agent', get(p, 'Representation') === 'Pat Agent, pat@agency.example');
  ok('the offer as the program states it', p.offer === 'Free product and a commission on sales');
  ok('the copy text starts with the link and holds every answer', /^Application: Gainz Fuel athlete program\nApply here: https:\/\/gainzfuel\.example\/athletes\n\nFull name: Jordan Reese/.test(p.text), p.text.slice(0, 200));
  ok('nothing missing, and it says verified', !p.missing.length && p.verified === true, p.missing);
  ok('no em dash anywhere', !/—/.test(p.text));

  // Unverified: the agent's number, said plainly; nothing invented.
  const thin = RECORD.resolveAthlete({ id: 'a2', data: { name: 'Sam Doe', sport: 'Soccer' } });
  const q = AP.build({ card: { brand_name: 'Kicks Co' }, athlete: thin, brand: { category: 'Footwear' } });
  ok('no Instagram held: reported missing, not filled', q.missing.includes('Instagram') && !q.fields.some((f) => f.label === 'Instagram'), q);
  ok('no school held: reported missing', q.missing.includes('School'), q.missing);
  ok('no fake numbers or placeholders', !/followers|undefined|null|\[|\{/.test(q.text), q.text);
  const agentNum = AP.build({ card: { brand_name: 'X' }, athlete: ath, brand: {} });
  ok('unconnected: the agent\'s follower count, without "verified"', /@jreese, 2,400 followers$/.test(get(agentNum, 'Instagram')) && !agentNum.verified, get(agentNum, 'Instagram'));

  // Seen in the first live run (Nov 13): a URL as the handle, "the The
  // Citadel", "womens", lower-cased abbreviations, a tennis "game", a default
  // 3% engagement, "..", and raw deal codes.
  const L = (d, b) => AP.build({ card: { brand_name: b.n }, athlete: RECORD.resolveAthlete({ id: 'z', data: d }), brand: b });
  const w = L({ name: 'N W', school: 'Baylor', sport: 'womens soccer', year: 'Sophomore', position: 'Midfielder (MF)', instagramHandle: '_jamie.lee_/?hl=en', instagram: 52000, engagement: 3 },
    { n: 'KNEMO', category: 'Beauty', deal_structure: 'gifting_code' });
  ok('a profile URL as the handle is cleaned', /^@_jamie\.lee_, 52,000 followers$/.test(get(w, 'Instagram')), get(w, 'Instagram'));
  ok("women's, and the position as written", /^I'm a sophomore on the Baylor women's soccer team, playing Midfielder \(MF\)\./.test(get(w, "Why I'm a fit for KNEMO")), get(w, "Why I'm a fit for KNEMO"));
  ok('an entered engagement rate is left off (only a connected account\'s is used)', !get(w, 'Engagement rate'));
  ok('a deal code in words', w.offer === 'Free product and a discount code', w.offer);
  const c2 = L({ name: 'K D', school: 'The Citadel', sport: 'basketball', year: 'Junior', position: 'G' }, { n: 'AT', offer_summary: 'Athletes earn commissions.' });
  ok('no "the The Citadel"', /^I'm a junior on The Citadel basketball team, playing G\./.test(get(c2, "Why I'm a fit for AT")), get(c2, "Why I'm a fit for AT"));
  ok('no double period on the offer', c2.offer === 'Athletes earn commissions', c2.offer);
  const t2 = L({ name: 'T T', school: 'Minnesota', sport: 'tennis' }, { n: 'K', category: 'skincare' });
  ok('tennis has a match, not a game', /tennis match/.test(get(t2, 'Content I would create')) && !/ game/.test(get(t2, 'Content I would create')), get(t2, 'Content I would create'));
  ok('no year: "I play tennis at Minnesota."', /^I play tennis at Minnesota\./.test(get(t2, "Why I'm a fit for K")), get(t2, "Why I'm a fit for K"));

  // The email to the athlete.
  const m = AP.mailtoFor(p, 'jordan@samford.edu', 'Jordan Reese');
  ok('send to athlete: a mailto with the subject and every answer', /^mailto:jordan%40samford\.edu\?subject=Apply%20to%20Gainz%20Fuel/.test(m) && decodeURIComponent(m).includes('Full name: Jordan Reese'), m && m.slice(0, 120));
  ok('no athlete email: no button', AP.mailtoFor(p, null, 'x') === null && AP.mailtoFor(p, 'nope', 'x') === null);

  // ── AGAINST THE DATABASE ───────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ('ap-ag','Pat Agent','ap@agent.example','x','agent'), ('ap-ag2','Other','ap2@agent.example','x','agent')`);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ap-a1','ap-ag',$1), ('ap-a2','ap-ag2',$2)`,
    [JSON.stringify({ name: 'Jordan Reese', school: 'Samford', sport: 'Football', instagramHandle: 'jreese', instagram: 2400, email: 'jordan@samford.edu' }),
      JSON.stringify({ name: 'Other Kid', school: 'Auburn', sport: 'Baseball' })]);
  await P.query(`INSERT INTO social_brands (brand, category, website, proof_url, offer_summary, deal_structure, sports, active, proof_date, tier_min, tier_max)
                 VALUES ('Gainz Fuel','Sports nutrition','https://gainzfuel.example','https://gainzfuel.example/athletes','Free product and a commission on sales','Affiliate', ARRAY['football'], true, CURRENT_DATE, 0, 1000000)`);
  const ins = (id, agent, ath2, brandName, channel, state) => P.query(
    `INSERT INTO outreach_queue (id, agent_id, athlete_id, brand_name, brand_key, channel, state, program_url, lane, slot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'social',$9)`, [id, agent, ath2, brandName, 'name:' + brandName.toLowerCase(), channel, state,
      channel === 'program' ? 'https://gainzfuel.example/athletes' : null, Math.floor(Math.random() * 1000) + 1]);
  await ins(901, 'ap-ag', 'ap-a1', 'Gainz Fuel', 'program', 'queued');
  await ins(902, 'ap-ag', 'ap-a1', 'Local Cafe', 'dm', 'queued');
  await ins(903, 'ap-ag', 'ap-a1', 'Old Brand', 'program', 'sent');
  await ins(904, 'ap-ag2', 'ap-a2', 'Gainz Fuel', 'program', 'queued');
  const list = await AP.listForAgent(P, 'ap-ag', { verifiedFor: async () => null });
  ok('one queued program card for this agent, nobody else\'s, no DM, no sent one', list.length === 1 && String(list[0].id) === '901', list.map((x) => x.id));
  const one = list[0] || { fields: [] };
  ok('it carries the brand\'s program facts', one.brand === 'Gainz Fuel' && one.offer === 'Free product and a commission on sales' && one.category === 'Sports nutrition', one);
  ok('the program lists football: the why says so', /works with football athletes/.test((one.fields.find((f) => /Why/.test(f.label)) || {}).value || ''), one.fields);
  ok('the athlete\'s email gives a Send to athlete link', /^mailto:jordan%40samford\.edu/.test(one.mailto || ''), one.mailto);

  // ── HOME AND THE ROUTE ─────────────────────────────────────────────────
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('GET /api/agent/applications is behind requireAuth', /app\.get\('\/api\/agent\/applications', requireAuth/.test(idx));
  const html = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('Home shows "Ready to apply" when there are program cards', /if \(d\.programs\) html \+= '<div id="hq-apps"/.test(html) && /Ready to apply/.test(html));
  ok('  and no longer sends them to another tab', !/waiting on the Outreach tab/.test(html));
  ok('  Applied records it as a program contact', /hqAppPost\(i, btn, 'sent', \{ via: 'program' \}\)/.test(html));
  ok('the sent route accepts program', /const VIA = \['dm', 'call', 'program', 'email'\]/.test(idx));
  ok('the admin report is registered', Object.keys(require(REPO + 'server/services/adminScripts').discover({ strict: true })).includes('applications'));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
