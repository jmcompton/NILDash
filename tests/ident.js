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
const BI=require(REPO + 'server/services/brandIdentity.js');
const out=[]; const check=(n,c,d)=>{out.push({n,ok:!!c});console.log((c?'  PASS  ':'  FAIL  ')+n+(d?'   '+d:''));};
const pad=(s,n)=>String(s).padEnd(n);

console.log('\n1. The nine pairs that defeated normBrand');
const PAIRS=[
 ['Cahaba Brewing Company','Cahaba Brewing Co.'],
 ['Trak Shak','Trak Shak Inc'],
 ['Post Office Pies','Post Office Pies, Birmingham'],
 ['Onyx Coffee Lab','Onyx Coffee Lab (Homewood)'],
 ["Ben & Jerry's","Ben and Jerry's"],
 ['The Hall CP','Hall CP'],
 ['Vigilante Coffee Company','Vigilante Coffee'],
 ['Board and Brew','Board & Brew'],
 ['Franklins Restaurant, Brewery & General Store','Franklins Restaurant'],
];
let same=0;
for(const [a,b] of PAIRS){
  const ka=BI.keyOf({brand_name:a,market_key:'birmingham-al'});
  const kb=BI.keyOf({brand_name:b,market_key:'birmingham-al'});
  const ok=ka===kb; if(ok)same++;
  console.log('  '+pad(a,46)+pad(b,34)+(ok?'SAME':'DIFFERENT')+'   '+ka);
}
check('all nine name variants now collapse', same===PAIRS.length, same+'/'+PAIRS.length);

console.log('\n2. URL variants');
const U=[['https://www.cahababrewing.com/','http://cahababrewing.com'],
 ['https://cahababrewing.com/contact?utm=x','cahababrewing.com'],
 ['https://shop.trakshak.com','https://www.trakshak.com/'],
 ['HTTPS://TrakShak.com:443/menu#top','trakshak.com/']];
let u=0;
for(const [a,b] of U){
  const ka=BI.keyOf({brand_name:'X',website:a}), kb=BI.keyOf({brand_name:'X',website:b});
  if(ka===kb)u++;
  console.log('  '+pad(a,42)+pad(b,26)+(ka===kb?'SAME':'DIFFERENT')+'   '+ka);
}
check('every URL variant collapses', u===U.length, u+'/'+U.length);

console.log('\n3. The strong key is preferred over the name');
const a1={brand_name:'Cahaba Brewing Company',place_id:'ChIJabc'},
      a2={brand_name:'Cahaba Brewing Co.',place_id:'ChIJabc'};
check('same place_id, different names -> one identity',
  BI.keyOf(a1)===BI.keyOf(a2), BI.keyOf(a1));
check('and the basis says place, not name', BI.identityOf(a1).basis==='place');
const b1={brand_name:'X',brand_key:'place:ChIJzzz'};
check('an existing place: brand_key is honoured, not discarded',
  BI.keyOf(b1)==='place:ChIJzzz', BI.keyOf(b1));
const b2={brand_name:'X',brand_key:'dom:https://www.foo.com/'};
check('an existing dom: brand_key is re-normalised', BI.keyOf(b2)==='dom:foo.com', BI.keyOf(b2));

console.log('\n4. What it MUST NOT collapse');
const NO=[
 [{brand_name:'Cahaba Brewing',market_key:'birmingham-al'},{brand_name:'Cahaba Cycles',market_key:'birmingham-al'},'different businesses, similar name'],
 [{brand_name:'Joe\'s Pizza',market_key:'birmingham-al'},{brand_name:'Joe\'s Pizza',market_key:'college-park-md'},'same name, different market'],
 [{brand_name:'X',website:'cahababrewing.com'},{brand_name:'X',website:'cahabacycles.com'},'different domains'],
 [{brand_name:'Company Bakery',market_key:'m'},{brand_name:'Bakery',market_key:'m'},'leading suffix word is not stripped'],
];
let kept=0;
for(const [x,y,why] of NO){
  const ok=BI.keyOf(x)!==BI.keyOf(y); if(ok)kept++;
  console.log('  '+(ok?'kept apart  ':'COLLAPSED   ')+pad(why,44)+BI.keyOf(x)+' vs '+BI.keyOf(y));
}
check('none of the must-not cases collapse', kept===NO.length, kept+'/'+NO.length);

console.log('\n5. dedupe() keeps the best and records the collapse');
const ranked=[
 {brand_name:'Cahaba Brewing Company',brand_key:'place:ChIJabc',pool:'shown',fit:90},
 {brand_name:'Trak Shak',brand_key:'name-only',pool:'market-pool',fit:80},
 {brand_name:'Cahaba Brewing Co.',brand_key:'Cahaba Brewing Co.',pool:'market-pool',fit:70},
 {brand_name:'Trak Shak Inc',brand_key:'Trak Shak Inc',pool:'market-pool',fit:60},
];
const r=BI.dedupe(ranked,{market:'birmingham-al'});
check('four candidates become two', r.kept.length===2, r.kept.map(c=>c.brand_name).join(', '));
check('the higher-ranked copy survives',
  r.kept[0].fit===90 && r.kept[1].fit===80, r.kept.map(c=>c.fit).join(','));
check('both collapses are recorded', r.collapses.length===2);
console.log('');
for(const c of r.collapses) console.log('  '+BI.describeCollapse(c,'slate'));
check('the log line names both names, both keys, both pools and the basis',
  r.collapses.every(c=>{const s=BI.describeCollapse(c,'slate');
    return /collapsed "/.test(s)&&/basis=/.test(s)&&/winner: key=/.test(s)&&/loser: key=/.test(s)&&/pool=/.test(s);}));

console.log('\n6. An unidentifiable candidate is never silently dropped');
const r2=BI.dedupe([{brand_name:''},{brand_name:''},{brand_name:'Real Co',market_key:'m'}]);
check('two nameless rows both survive', r2.kept.length===3, 'kept='+r2.kept.length);

const bad=out.filter(x=>!x.ok);
console.log('\n'+(out.length-bad.length)+'/'+out.length+' passed');
process.exit(bad.length?1:0);
