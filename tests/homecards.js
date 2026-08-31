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
const ROOT = REPO;
const store=require(ROOT+'server/store.js');
const H=require(ROOT+'server/services/homeQueue.js');
const fs=require('fs');
let F=0; const ok=(n,c,g)=>{if(c)console.log('  PASS '+n);else{F++;console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):''));}};
const AG='hc-agent', ATH='hc-ath';

(async()=>{
  await new Promise(r=>setTimeout(r, TEST_INIT_WAIT_MS));
  const P=store.pool;
  for (const t of ['outreach_logs','outreach_queue','brand_match_scores','athletes'])
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM users WHERE id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM media_kits WHERE athlete_id=$1`,[ATH]).catch(()=>{});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','hc@x.com','x','agent')`,[AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH,AG,JSON.stringify({name:'Jeremiah Cole',school:'Alabama',dob:'2004-06-01'})]);

  // 14 drafts, distinct scores, so "highest fit" is checkable.
  for (let i=0;i<14;i++){
    await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'draft',$7, NOW() - ($8||' minutes')::interval)`,
      ['hc-'+i,AG,ATH,'Brand '+i,'Subject '+i,
       '<p>Hi there,</p><p>Brand '+i+' is a local business with a real reason to back this athlete.</p>',
       'owner'+i+'@x.example', String(100-i)]);
    await P.query(`INSERT INTO brand_match_scores (id,agent_id,athlete_id,brand_name,reasoning,compatibility_score)
      VALUES ($1,$2,$3,$4,$5,$6)`,['hcm-'+i,AG,ATH,'Brand '+i,'Reason '+i,i]);
  }

  console.log('\n-- 1. five, and the rest wait --');
  let h=await H.buildHome(P,AG,{athleteId:ATH});
  ok('no read errors', h.errors.length===0, h.errors);
  ok('exactly five cards', h.cards.length===5, h.cards.length);
  ok('  the true pile is reported', h.pending===14 && h.heldBack===9, {p:h.pending,hb:h.heldBack});
  ok('  the tab count MATCHES the screen, not the pile',
    h.athletes[0].count===5 && h.athletes[0].pending===14, h.athletes[0]);

  console.log('\n-- 2. oldest first, because there is no score to sort by --');
  // CHANGED DELIBERATELY, AND THIS TEST IS THE RECORD OF IT. Home used to order
  // by brand_match_scores.compatibility_score. It cannot any more: Home is a
  // mixed queue of outreach_logs drafts and outreach_queue cards, and
  // brand_match_scores has no brand_key column at all -- it joins on athlete_id
  // plus an exact lowercase brand_name, and reaches 2 of 49 non-programme queue
  // cards in production. Sorting a union by a score that covers 4% of one side
  // and most of the other puts every email above every call and quietly rebuilds
  // the single-channel page. See server/services/actionable.js.
  //
  // These 14 drafts are identical on every signal the ladder does use -- all
  // email, all addressed, none verified, none starved -- so the ranking falls to
  // its final comparable: oldest first. Brand 0 is the oldest here (created 100
  // minutes ago; Brand 13, 87).
  ok('the five are the OLDEST, not the highest-scoring', h.cards.map(c=>c.business).join(',')==='Brand 0,Brand 1,Brand 2,Brand 3,Brand 4',
    h.cards.map(c=>c.business));

  console.log('\n-- 3. the card shows what will be sent --');
  const c=h.cards[0];
  ok('who it goes to', c.to==='owner0@x.example', c.to);
  ok('the subject line', c.subject==='Subject 0', c.subject);
  ok('and it says which channel it is', c.channel==='email', c.channel);
  ok('and its id names the table it came from', /^email:hc-0$/.test(c.id), c.id);
  ok('the pitch body, as paragraphs', Array.isArray(c.body) && c.body.length===2, c.body);
  ok('  greeting kept, because it is what the business reads', /Hi there/.test(c.body[0]), c.body[0]);
  ok('  and it is TEXT, never stored markup', !/[<>]/.test(c.body.join('')), c.body);

  console.log('\n-- 4. the media kit answer matches what approve will do --');
  ok('off by default', c.mediaKit===null, c.mediaKit);
  await P.query(`UPDATE users SET attach_media_kit=true WHERE id=$1`,[AG]);
  h=await H.buildHome(P,AG,{athleteId:ATH});
  ok('on, but no kit built -> still nothing to attach', h.cards[0].mediaKit===null, h.cards[0].mediaKit);
  await P.query(`INSERT INTO media_kits (athlete_id,slug) VALUES ($1,'jeremiah-cole')`,[ATH]);
  h=await H.buildHome(P,AG,{athleteId:ATH});
  ok('on, kit built -> the url the approval will append', /jeremiah-cole/.test(h.cards[0].mediaKit||''), h.cards[0].mediaKit);
  await P.query(`UPDATE users SET attach_media_kit=false WHERE id=$1`,[AG]);

  console.log('\n-- 5. an empty page must not be a silent failure --');
  const bad=await H.buildHome({query:async()=>{throw new Error('boom');}},AG,{athleteId:ATH});
  ok('a broken read reports itself', bad.errors.length>0, bad.errors);
  ok('  rather than rendering as no work', bad.cards.length===0 && bad.errors[0].indexOf('boom')>-1);

  console.log('\n-- 6. the card edits the WORDS, and nothing else --');
  // This asserted the card had no input or textarea at all, which was right when
  // Home was read-only. Subject and body are editable now, deliberately. What has
  // NOT changed is the rule underneath it: the agent does not choose the
  // recipient. So the assertion moved from "no fields" to "no field that picks
  // who this goes to", which is the part that was actually load-bearing.
  const HTML=fs.readFileSync(ROOT+'public/index.html','utf8');
  const home=HTML.slice(HTML.indexOf('function hqRender'), HTML.indexOf('async function hqApprove'));
  ok('no dropdown anywhere on the card', !/<select/i.test(home));
  ok('no recipient field', !/hq-(to|recipient|email)['"]/i.test(home) && !/name=["']to["']/i.test(home));
  // SCOPED TO THE EMAIL CARD, because there are three kinds of card now. The
  // rule this protects has not changed -- an email card offers the subject and
  // the message and nothing else -- but Home also renders DM cards, which have
  // their own single textarea, and asserting over the whole renderer counted
  // both and read as a regression.
  const mail=HTML.slice(HTML.indexOf('function hqEmailBody'), HTML.indexOf('function hqDmBody'));
  ok('exactly two editable fields on an EMAIL card: subject and body',
    (mail.match(/<input class="hq-in"/g)||[]).length===1
    && (mail.match(/<textarea class="hq-ta"/g)||[]).length===1);
  ok('  and they are the subject and the message',
    /id="hq-esubj-/.test(mail) && /id="hq-ebody-/.test(mail));
  // CHANGED DELIBERATELY. "No per-card action" was right when every card was an
  // email and one bar approved all of them. A DM and a call have NO batch action
  // -- approving does not send them, a person does -- so a card with no button
  // is a card an agent cannot act on. The rule that survives is the narrower and
  // actually load-bearing one: an EMAIL card still has no per-card send.
  ok('  an email card still has no per-card send or skip',
    !/hqSend|hqSkip|hqCardDone|hqCardSkip|Copy DM/i.test(mail));
  ok('  but a DM card does, because nothing else will send it',
    /hqCopyDm/.test(home) && /hqCardDone/.test(home));
  ok('the email panel is collapsed by default', /class="hq-mail" id=.*hidden/.test(home) || /hidden>/.test(home));
  ok('  and is one click on the same card', /aria-controls=/.test(home) && /hqPeek/.test(home));

  for (const t of ['outreach_logs','outreach_queue','brand_match_scores','athletes'])
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM users WHERE id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM media_kits WHERE athlete_id=$1`,[ATH]).catch(()=>{});
  console.log('\nfailures: '+F);
  process.exit(F?1:0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
