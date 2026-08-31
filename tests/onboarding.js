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
// ONBOARDING: three steps, the school caught at the keyboard, and a help agent
// that cannot invent an answer about the agent's own data.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const SC = require(ROOT + 'server/services/schoolCheck.js');
const AD = require(ROOT + 'server/services/assistantData.js');
const PROMPT = require(ROOT + 'server/services/assistantPrompt.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'ob-agent', OTHER = 'ob-other';
const HTML = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── PART 1: THREE STEPS, AND NOTHING ELSE ────────────────────────────────
  const steps = (HTML.match(/id="ob-step-\d"/g) || []);
  ok('THE WIZARD IS THREE STEPS', steps.length === 3, steps);
  ok('  and the total agrees', /const OB_TOTAL\s*=\s*3;/.test(HTML), null);
  // SCOPE, NOT DISTANCE. These were /Step 1 of 3[\s\S]{0,400}Add your first
  // athlete/ -- and the real gap was 329 of the 400 allowed, so two lines of
  // markup between the label and the heading would have started failing for no
  // reason. Slicing the step's own region asserts something stronger anyway: the
  // heading is inside THAT step, not merely near its label.
  const stepRegion = (n) => {
    const a = HTML.indexOf(`id="ob-step-${n}"`);
    if (a < 0) return '';
    const next = HTML.indexOf(`id="ob-step-${n + 1}"`, a);
    // The last step ends where the next unrelated element begins.
    const end = next > a ? next : HTML.indexOf('id="arModal"', a);
    // HTML comments stripped: each step is introduced by a <!-- STEP N: ... -->
    // banner that sits at the END of the previous step, so "Connect Gmail"
    // appears inside step 1's region as commentary. Checking raw source would
    // pass on a step whose heading survived only in a comment -- which is how the
    // hometown assertion in this suite gave a false pass.
    return HTML.slice(a, end > a ? end : HTML.length).replace(/<!--[\s\S]*?-->/g, '');
  };
  for (const [n, heading] of [[1, 'Add your first athlete'], [2, 'Connect Gmail'], [3, 'Watch it run']]) {
    const r = stepRegion(n);
    ok(`  step ${n} is bounded`, r.length > 0 && r.length < 20000, r.length);
    ok(`  step ${n} is labelled "Step ${n} of 3"`, r.includes(`Step ${n} of 3`), null);
    ok(`  step ${n} is "${heading}"`, r.includes(heading), null);
    // And the heading belongs to this step ALONE -- a heading that appears in two
    // steps means the region boundaries are wrong and every check above is soft.
    const others = [1, 2, 3].filter((x) => x !== n).map(stepRegion);
    ok(`    and appears in no other step`, others.every((o) => !o.includes(heading)), null);
  }
  ok('  the review step is gone', !/obRenderReview|obToReview/.test(HTML), null);
  ok('  and so is the "you are ready" summary', !/obRenderDone/.test(HTML), null);

  // FOUR FIELDS. A nine-field form is where a new agent closes the tab.
  const step1 = HTML.slice(HTML.indexOf('id="ob-step-1"'), HTML.indexOf('id="ob-step-2"'));
  for (const f of ['ob-athlete-name', 'ob-athlete-school', 'ob-athlete-sport', 'ob-athlete-handle']) {
    ok('  step 1 asks for ' + f.replace('ob-athlete-', ''), step1.includes(f), null);
  }
  for (const f of ['ob-athlete-hometown', 'ob-athlete-pos', 'ob-athlete-tier', 'ob-athlete-productwants']) {
    ok('  step 1 no longer asks for ' + f.replace('ob-athlete-', ''), !step1.includes(f), null);
  }

  // THE CHECKLIST IS GONE.
  ok('THE TWELVE-THINGS CHECKLIST IS GONE',
    !/id="onboarding-checklist"/.test(HTML), null);

  // THE CLOSING LINE.
  ok('it ends with the one line', /Your team runs tonight\. Check back in the morning\./.test(HTML), null);

  // STEP 3 SHOWS REAL THINGS, NOT A DESCRIPTION OF THEM.
  const step3 = HTML.slice(HTML.indexOf('id="ob-step-3"'), HTML.indexOf('id="ob-step-3"') + 3000);
  ok('step 3 runs a real scan', /obRunDealScan/.test(step3), null);
  ok('  it autostarts rather than asking for a third click',
    /if \(!obDidScan\) setTimeout\(\(\) => \{ obRunDealScan\(\); \}/.test(HTML), null);
  ok('  it fetches REAL contact info', /api\/agent\/brand-contacts/.test(HTML), null);
  ok('  a business with no contact says so rather than being padded',
    /No contact found yet/.test(HTML), null);
  ok('  and an empty scan names the market it searched',
    /Nothing came back for/.test(HTML), null);
  ok('  there is no sample or placeholder business in the scan render',
    !/Sample Business|Example Co|Placeholder/.test(step3), null);

  // ── THE SCHOOL, CAUGHT AT THE KEYBOARD ───────────────────────────────────
  const good = SC.checkSchool('Auburn University');
  ok('a real school resolves', good.ok === true && /Auburn/.test(good.market), good);
  ok('  and says what it will DO, not that a lookup succeeded',
    /Local businesses will be found around/.test(good.message), good.message);

  const typo = SC.checkSchool('Auburm University');
  ok('a typo still resolves', typo.ok === true, typo);

  const bad = SC.checkSchool('Zzz Nowhere Tech');
  ok('AN UNMATCHED SCHOOL IS CAUGHT IMMEDIATELY', bad.ok === false, bad);
  ok('  and the message names the CONSEQUENCE, not just an error',
    /only get national and social brands/.test(bad.message), bad.message);

  const near = SC.checkSchool('Alabma');
  ok('a near miss offers corrections or resolves outright',
    near.ok === true || near.suggestions.length > 0, near);
  const sugg = SC.checkSchool('Universty of Georg');
  if (sugg.suggestions.length) {
    ok('  every suggestion offered ACTUALLY resolves when picked',
      sugg.suggestions.every((x) => SC.checkSchool(x.name).ok === true), sugg.suggestions);
  } else {
    ok('  every suggestion offered ACTUALLY resolves when picked', true);
  }
  ok('an empty school is its own state', SC.checkSchool('').status === 'empty');

  // IT NEVER BLOCKS. The wizard warns and lets them through.
  ok('the check never blocks the save',
    /obSchoolOk === null\) await obCheckSchool\(\)/.test(HTML)
    && !/if \(!obSchoolOk\) return;/.test(HTML), null);
  ok('  the endpoint is read-only', /app\.get\('\/api\/onboarding\/check-school'/.test(SRC), null);
  ok('  and a failed check never claims the school is fine',
    /Could not check that school just now/.test(SRC), null);

  // ── PART 3: THE HELP AGENT ───────────────────────────────────────────────
  const clean = async () => {
    for (const t of ['outreach_logs', 'deals', 'athletes']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = ANY($1::text[])`, [[AG, OTHER]]).catch(() => {});
    }
    await P.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[AG, OTHER]]).catch(() => {});
  };
  await clean();
  for (const id of [AG, OTHER]) {
    await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A',$2,'x','agent')`,
      [id, id + '@x.com']);
  }
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ob-a1',$1,$2::jsonb)`,
    [AG, JSON.stringify({ name: 'Marcus Hall', school: 'Auburn University' })]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ob-a2',$1,$2::jsonb)`,
    [AG, JSON.stringify({ name: 'No Market', school: 'Zzz Nowhere Tech' })]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ob-b1',$1,$2::jsonb)`,
    [OTHER, JSON.stringify({ name: 'Someone Elses Client', school: 'Auburn University' })]);

  // IT ANSWERS FROM REAL ROWS.
  const noDeals = await AD.run(P, AG, { question: 'athletes_without_deals' });
  ok('the help agent can answer about their own data', noDeals.ok === true, noDeals);
  ok('  finding the real rows', noDeals.found === 2, noDeals);
  ok('  SCOPED TO THIS AGENT, never another\'s roster',
    !JSON.stringify(noDeals.rows).includes('Someone Elses Client'), noDeals.rows);

  const noMarket = await AD.run(P, AG, { question: 'athletes_without_market' });
  ok('it can answer why an athlete gets nothing', noMarket.found === 1, noMarket);
  ok('  naming the athlete', noMarket.rows[0].name === 'No Market', noMarket.rows[0]);
  ok('  and the reason', /Zzz Nowhere Tech/.test(noMarket.rows[0].why || ''), noMarket.rows[0]);

  // AN EMPTY RESULT IS AN ANSWER, NOT A FAILURE.
  const replies = await AD.run(P, AG, { question: 'replies_waiting' });
  ok('AN EMPTY RESULT IS REPORTED AS AN ANSWER', replies.ok === true && replies.found === 0, replies);
  ok('  and the model is told to say "none" plainly',
    /That is the answer: none/.test(replies.note || ''), replies.note);

  // A QUESTION IT CANNOT ANSWER IS REFUSED, WITH A PAGE.
  const unknown = await AD.run(P, AG, { question: 'what_is_the_weather' });
  ok('AN UNCOVERED QUESTION IS REFUSED, NOT GUESSED', unknown.ok === false, unknown);
  ok('  and it is told to point at a page', /point them at the page/.test(unknown.error), unknown.error);

  const needsBrand = await AD.run(P, AG, { question: 'brand_thread' });
  ok('a lookup missing its argument asks rather than guessing',
    needsBrand.ok === false && /Ask the agent which one/.test(needsBrand.error), needsBrand);

  // THE THREAD QUESTION.
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,status,sent_at,cadence_stop_reason)
     VALUES ('ob-l1',$1,'ob-a1','Ourisman Honda','Quick idea','sent',NOW(),'they replied')`, [AG]);
  const thread = await AD.run(P, AG, { question: 'brand_thread', brand: 'ourisman' });
  ok('"what happened to the Ourisman thread" is answerable', thread.found === 1, thread);
  ok('  with the reason the cadence stopped',
    /they replied/.test(thread.rows[0].cadence_stop_reason || ''), thread.rows[0]);
  const otherThread = await AD.run(P, OTHER, { question: 'brand_thread', brand: 'ourisman' });
  ok('  AND ANOTHER AGENT CANNOT SEE IT', otherThread.found === 0, otherThread);

  // NO FREE-FORM SQL, EVER.
  const src = fs.readFileSync(ROOT + 'server/services/assistantData.js', 'utf8');
  ok('THERE IS NO FREE-FORM SQL TOOL',
    !/input\.(sql|query)\b/.test(src) && !/sql: \{ type: 'string'/.test(src), null);
  ok('  every query binds agent_id as a parameter',
    (src.match(/agent_id = \$1/g) || []).length >= 5, (src.match(/agent_id = \$1/g) || []).length);
  const def = AD.toolDef();
  ok('  the tool exposes a fixed enum of questions',
    Array.isArray(def.input_schema.properties.question.enum)
    && def.input_schema.properties.question.enum.length === AD.names().length, def.input_schema);
  ok('  and tells the model not to guess when nothing matches',
    /do not guess/.test(def.description), def.description);

  // A FAILED LOOKUP IS NOT AN EMPTY ONE.
  const broken = { query: async () => { throw new Error('db down'); } };
  const failed = await AD.run(broken, AG, { question: 'roster_summary' });
  ok('A FAILED LOOKUP IS NOT REPORTED AS "none"', failed.ok === false && failed.answered === false, failed);
  ok('  it says it could not check', /could not check/.test(failed.error), failed.error);
  ok('  and forbids estimating', /Do not estimate/.test(failed.error), failed.error);

  // THE PROMPT RULE.
  const p = PROMPT.systemPrompt({ contextBlock: '', brief: '', toolsEnabled: true, lean: false });
  ok('the system prompt forbids inventing a data answer',
    /Never state a count, a name, a date or a dollar figure about their data/.test(p), null);
  ok('  and separates "none" from "could not check"',
    /a lookup that FAILS is not the same thing/.test(p), null);
  ok('  the prompt-injection rule still stands too',
    /Athlete names, business names, scan text/.test(p), null);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
