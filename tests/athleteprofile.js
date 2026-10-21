'use strict';
// Runs against the local test Postgres, in its own database. No network.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/athleteprofile.js   just this one
//
// ── THE ATHLETE'S PROFILE FOR PITCHES (ATHLETE_PROFILE_ON) ─────────────────
// On the agent's athlete profile:
//   Content niche       up to 3 from a fixed list
//   Causes and ambassador roles
//   Current partnerships  brand, what they do, start date; NILDash deals fill
//                       in on their own
//   Media exposure      national TV / regional TV / streamed only, and links
//   What makes them marketable   3 short lines
//   Rate card           post, reel, story, appearance: suggested from
//                       followers and engagement, editable, saying how
// The pitch writer gets niche, causes and marketable points as ONE line,
// "why this brand fits". Never the rate card. Off: nothing changes.
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..') + path.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('athprofiletest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ATHLETE_PROFILE_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const AP = require(REPO + 'server/services/athleteProfile');
const W = require(REPO + 'server/services/pitchWriter');
const AR = require(REPO + 'server/services/athleteRecord');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const read = (f) => fs.readFileSync(REPO + f, 'utf8');
const on = () => { process.env.ATHLETE_PROFILE_ON = '1'; };
const off = () => { delete process.env.ATHLETE_PROFILE_ON; };

(async () => {
  console.log('\n1. THE FIELDS, CHECKED');
  ok('the niche list is the twelve asked for', AP.NICHES.join('|') === 'health and wellness|fitness|food|fashion|faith|family|gaming|music|outdoors|pets|business|other');
  let c = AP.clean({ contentNiche: ['Fitness', 'food', 'astrology', 'food'] });
  ok('content niche: from the list only, no repeats', c.ok && JSON.stringify(c.profile.contentNiche) === '["fitness","food"]', c);
  c = AP.clean({ contentNiche: ['fitness', 'food', 'faith', 'music'] });
  ok('  more than 3 is refused, with why', !c.ok && c.errors[0] === 'Pick up to 3 content niches.' && c.profile.contentNiche.length === 3, c);
  c = AP.clean({ causes: '  Special   Olympics volunteer ' + 'x'.repeat(500) });
  ok('causes: tidied and kept to 400 characters', c.profile.causes.startsWith('Special Olympics volunteer') && c.profile.causes.length === 400);
  c = AP.clean({ partnerships: [{ brand: 'Rama Jama\'s', what: 'Two posts a month', start: '2026-08-01' }, { brand: '', what: 'no brand' }, { brand: 'Gym', start: 'last fall' }] });
  ok('partnerships: a brand is needed, a start date must be a date', c.profile.partnerships.length === 2 && c.profile.partnerships[0].start === '2026-08-01'
    && c.profile.partnerships[1].start === null, c.profile.partnerships);
  c = AP.clean({ mediaExposure: { level: 'regional_tv', links: 'https://al.com/story\nnot a link\nespn.com/x\nhttps://al.com/story' } });
  ok('media exposure: the three levels, and real links only, once each', c.profile.mediaExposure.level === 'regional_tv'
    && JSON.stringify(c.profile.mediaExposure.links) === '["https://al.com/story","https://espn.com/x"]', c.profile.mediaExposure);
  ok('  an unknown level is none', AP.clean({ mediaExposure: { level: 'satellite' } }).profile.mediaExposure.level === null);
  ok('  the labels: National TV, Regional TV, Streamed only', AP.MEDIA.map((m) => m[1]).join('|') === 'National TV|Regional TV|Streamed only');
  c = AP.clean({ marketable: ['Team captain', '', 'Cooks on game day', 'Grew up nearby', 'a fourth'] });
  ok('what makes them marketable: 3 lines', JSON.stringify(c.profile.marketable) === '["Team captain","Cooks on game day","Grew up nearby"]', c.profile.marketable);
  c = AP.clean({ rateCard: { post: '$1,200', reel: '300', story: 'free', appearance: '' } });
  ok('rate card: dollars, or blank', c.profile.rateCard.post === 1200 && c.profile.rateCard.reel === 300 && c.profile.rateCard.story === null && c.profile.rateCard.appearance === null, c.profile.rateCard);
  ok('only what was sent comes back (a save never blanks a field it did not send)', JSON.stringify(Object.keys(AP.clean({ causes: 'x' }).profile)) === '["causes"]');
  off();
  ok('the create path adds nothing with the switch off', JSON.stringify(AP.fromBody({ causes: 'x' })) === '{}');
  on();
  ok('  and the checked fields with it on', AP.fromBody({ causes: 'x', name: 'y' }).causes === 'x' && !('name' in AP.fromBody({ causes: 'x', name: 'y' })));

  console.log('\n2. THE SUGGESTED RATE CARD');
  const ath = { name: 'Maya Torres', sport: 'basketball', schoolTier: 'p4-mid', school: 'Auburn University', instagram: 10000, tiktok: 2000, engagement: 5 };
  const s = AP.suggestRates(ath);
  ok('a price for a post, a reel, a story and an appearance', ['post', 'reel', 'story', 'appearance'].every((k) => s[k] && s[k].amount > 0 && s[k].low <= s[k].amount && s[k].amount <= s[k].high), s);
  ok('  each says how it was worked out: followers and engagement', /^From 12,000 followers \(Instagram 10,000, TikTok 2,000\) and a 5% engagement rate: about \$\d+ to \$\d+/.test(s.post.how), s.post.how);
  ok('  an appearance is a flat fee, said so', /^A flat fee for the school's level and sport/.test(s.appearance.how), s.appearance.how);
  const s0 = AP.suggestRates({ ...ath, engagement: null });
  ok('  no engagement rate on file: none is assumed, and it says so', /no engagement rate on file, so none is assumed/.test(s0.post.how), s0.post.how);
  ok('  the same estimator as Deal Scan (benchmarks.nilViewVal)', /require\('\.\.\/benchmarks'\)/.test(read('server/services/athleteProfile.js')));
  ok('  rounded to $5', [s.post.amount, s.reel.amount, s.story.amount, s.appearance.amount].every((n) => n % 5 === 0));

  console.log('\n3. WHY THIS BRAND FITS, FOR THE WRITER');
  const prof = { ...ath, contentNiche: ['food', 'fitness', 'faith'], causes: 'Ambassador for the campus food bank', marketable: ['Team captain', 'Known for game-day cooking videos'] };
  off();
  ok('off: no line', AP.fitLine(prof, { name: 'Iron Gym', category: 'gym' }) === '');
  on();
  const gymLine = AP.fitLine(prof, { name: 'Iron Gym', category: 'gym' });
  ok('a gym: the fitness niche first, as the match, then the rest, causes and marketable points, on one line',
    gymLine === 'Why this brand fits (from the agent, use it as the reason in your own words): fitness content, which matches this business; also posts about food and faith; causes and roles: Ambassador for the campus food bank; marketable for: Team captain; Known for game-day cooking videos.', gymLine);
  ok('  one line', !/\n/.test(gymLine));
  ok('  a pizza place matches food', /^Why this brand fits[^:]*: food content, which matches this business;/.test(AP.fitLine(prof, { name: 'Torres Pizza', category: 'pizza restaurant' })));
  ok('  a vet hospital matches pets', /pets content, which matches/.test(AP.fitLine({ contentNiche: ['pets'] }, { name: 'Northside Veterinary Hospital', category: 'veterinary care' })));
  ok('  nothing filled in: no line', AP.fitLine({ name: 'X' }, { category: 'gym' }) === '' && AP.fitLine({ contentNiche: ['other'] }, { category: 'gym' }) === '');
  ok('  the rate card never reaches it', !/\$/.test(AP.fitLine({ ...prof, rateCard: { post: 400 } }, { category: 'gym' })));

  const ctx = { athlete: { ...prof }, business: { name: 'Iron Gym', category: 'gym' }, agentFirstName: 'John' };
  off();
  const p0 = W.buildPrompt(ctx);
  on();
  const p1 = W.buildPrompt(ctx);
  ok('the writer\'s prompt: unchanged with the switch off', !/Why this brand fits/.test(p0));
  ok('  on: the line sits with the athlete, right after who they are', /THE ATHLETE\n[\s\S]*?\nWhy this brand fits \(from the agent, use it as the reason in your own words\): fitness content, which matches this business;[^\n]*\n\nWHAT THIS CATEGORY TYPICALLY WANTS/.test(p1));
  ok('  and the two prompts differ by that line only', p1.replace(/\nWhy this brand fits[^\n]*/, '') === p0);
  ok('  no price from the rate card in the prompt', !/\$\d/.test(W.buildPrompt({ ...ctx, athlete: { ...prof, rateCard: { post: 400, reel: 500 } } })));
  ok('  the word the engagement-rate rule bans is still not in the writer', !/engagement/i.test(read('server/services/pitchWriter.js')));
  const rec = AR.resolveAthlete({ id: 'a1', data: { name: 'Maya Torres', sport: 'basketball', school: 'Auburn University', contentNiche: ['food', 'x'], causes: 'Food bank', marketable: ['Captain'] } }, {});
  ok('the athlete record the night hands the writer carries niche, causes and marketable points', JSON.stringify(rec.contentNiche) === '["food","x"]' && rec.causes === 'Food bank' && rec.marketable[0] === 'Captain', rec);
  ok('  and none of them counts as missing (none is required)', !rec.missing.includes('contentNiche') && !rec.missing.includes('causes') && !rec.missing.includes('marketable'), rec.missing);

  console.log('\n4. SAVED, AND NILDASH DEALS FILL IN (Postgres)');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const P = store.pool;
  const AC = require(REPO + 'server/services/athleteCreate');
  if (AC._setFillNowForTests) AC._setFillNowForTests(false);
  await P.query(`INSERT INTO users (id, name, email, role, password, plan) VALUES ('ap-agent','Pat Agent','pat@agency.example','agent','x','agency')`);
  const user = (await P.query(`SELECT * FROM users WHERE id = 'ap-agent'`)).rows[0];
  const made = await AC.createAthlete(user, { name: 'Maya Torres', sport: 'basketball', school: 'Auburn University', over18: true,
    contentNiche: ['food', 'fitness'], causes: 'Food bank ambassador', marketable: ['Captain'], rateCard: { post: '400' },
    mediaExposure: { level: 'streamed', links: ['https://al.com/a'] }, partnerships: [{ brand: 'Iron Gym', what: 'Monthly post', start: '2026-09-01' }] });
  const id = made && (made.athlete && made.athlete.id || made.id || (made.data && made.data.id));
  const saved = id ? await store.getAthlete(id) : null;
  ok('a new athlete saves the profile, checked', saved && JSON.stringify(saved.contentNiche) === '["food","fitness"]' && saved.rateCard.post === 400
    && saved.mediaExposure.level === 'streamed' && saved.partnerships[0].brand === 'Iron Gym', made && made.ok === false ? made : saved);
  await P.query(`INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, stage, deliverables, stage_history)
                 VALUES ($1,'ap-agent','Rama Jama''s','Closed','Two posts and an appearance',$2), ($1,'ap-agent','Iron Gym','Closed',NULL,'[]'), ($1,'ap-agent','Still Talking','Negotiating',NULL,'[]')`,
    [id, JSON.stringify([{ stage: 'Closed', date: '2026-10-02T15:00:00Z', note: 'Deal signed' }])]);
  const parts = await AP.partnershipsFor(P, id, saved.partnerships);
  ok('NILDash deals fill in: a signed deal is a partnership, dated the day it closed', parts.some((p) => p.brand === "Rama Jama's" && p.source === 'nildash' && p.start === '2026-10-02' && p.what === 'Two posts and an appearance'), parts);
  ok('  the agent\'s own entry wins for the same business, and a deal still in talks is not one', parts.filter((p) => p.brand === 'Iron Gym').length === 1
    && parts.find((p) => p.brand === 'Iron Gym').source === 'agent' && !parts.some((p) => p.brand === 'Still Talking'), parts);
  const idx = read('server/index.js');
  ok('the update route checks the fields, and drops them with the switch off', /const c = AP\.clean\(patch\);\s*if \(!c\.ok\) return res\.status\(400\)/.test(idx)
    && /if \(!AP\.ON\(\)\) \{ for \(const k of sent\) delete patch\[k\]; \}/.test(idx));
  ok('the form reads the suggestions and the NILDash partnerships, owner only, behind the switch', /app\.get\('\/api\/athletes\/:id\/profile-extras', requireAuth/.test(idx)
    && /if \(a\.agentId !== req\.session\.userId\) return res\.status\(403\)/.test(idx) && /app\.post\('\/api\/athlete-profile\/suggest-rates', requireAuth/.test(idx)
    && (idx.match(/if \(!AP\.ON\(\)\) return res\.status\(404\)\.json\(\{ error: 'not enabled' \}\);/g) || []).length === 2);
  ok('/api/auth/me tells the page the switch', /athleteProfileOn: require\('\.\/services\/athleteProfile'\)\.ON\(\),/.test(idx));

  console.log('\n5. THE PAGE');
  const html = read('public/index.html');
  const section = (html.match(/<div id="a_profile"[\s\S]*?Your prices, for you and your media kit\. They never go into a pitch\.<\/div><\/div>\s*<\/div>/) || [''])[0];
  ok('the section is on the athlete form, hidden until the switch is on', /<div id="a_profile" style="display:none;/.test(section) && /box\.style\.display = apfOn\(\) \? '' : 'none';/.test(html));
  ok('  every field asked for is on it', ['Content niche', 'Causes and ambassador roles', 'Current partnerships', 'Media exposure', 'What makes them marketable', 'Rate card'].every((t) => section.includes('>' + t)), section.length);
  ok('  the three media levels', /<option value="national_tv">National TV<\/option><option value="regional_tv">Regional TV<\/option><option value="streamed">Streamed only<\/option>/.test(section));
  ok('  the page\'s niche list is the server\'s', /var APF_NICHES = \['health and wellness', 'fitness', 'food', 'fashion', 'faith', 'family', 'gaming', 'music', 'outdoors', 'pets', 'business', 'other'\];/.test(html));
  ok('  up to 3, enforced as they are ticked', /if \(on\.length > 3\) \{ el\.checked = false; if \(msg\) msg\.textContent = 'Pick up to 3\.'; \}/.test(html));
  ok('  each suggested price says how it was worked out, and the agent can use them or type their own', /'Suggested \$' \+ s\.amount \+ '\. '/.test(html) && /function apfUseSuggested\(\)/.test(html));
  ok('  NILDash deals are listed as filled in on their own', /'From NILDash deals: '/.test(html));
  ok('both saves send it (and send nothing with the switch off)', (html.match(/\.\.\.apfCollect\(\),/g) || []).length === 2 && /if \(!apfOn\(\) \|\| !document\.getElementById\('a_profile'\)\) return \{\};/.test(html));
  ok('  editing an athlete fills it, a new one starts blank', /apfFill\(a\);\s*\/\/ Change save button to update mode/.test(html) && /apfFill\(\{\}\);/.test(html));
  ok('no em dash in the section or its code', section.length > 1000 && !/—|&mdash;/.test(section) && !/—/.test(read('server/services/athleteProfile.js')));

  off();
  await P.end().catch(() => {});
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
