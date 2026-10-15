'use strict';
// ── A BRAND'S NAMED CONTACT, AT A VERIFIED ADDRESS (MARKET_MIX_ON) ──────────
//
// The email route for a social or national card under the deal mix
// (services/dealMix): the person the name search found must be a
// partnerships, influencer or marketing contact, and their address at the
// brand's own domain must verify VALID (services/emailFinder, validOnly: a
// catch-all accepts any guess, so on a brand's domain it proves nothing).
// No desk inbox, no general inbox, no guessed address.
//
// The brand's domain is its website when the index holds one; otherwise the
// finder looks it up and the domain gate confirms it (emailFinder.findWebsite).
// A brand's own corporate domain is exactly where its partnerships lead is,
// so the local lane's corporate-domain refusal does not apply here.
//
// -> { ok, ladder, fin, why, fault, stage }

async function verifiedAddress({ pool, person, cand, agentId, athleteId, more }) {
  const DM = require('./dealMix');
  const EF = require('./emailFinder');
  const Q = require('./outreachQueue');
  const ONS = require('./ownerNameSearch');
  const t = DM.contactTitleOk(person && person.title);
  if (!t.ok) return { ok: false, stage: 'title', why: `${(person && person.name) || 'the contact'}: ${t.why}` };
  const ladder = ONS.attachToLadder({ tiers: [] }, person);
  let fin = null;
  try {
    const deps = { ...EF.liveDeps(pool, { agentId, athleteId, business: cand.brand_name, source: 'nightly' }), corporate: null };
    fin = await EF.finishLadder({ ladder, out: { website: cand.website || null }, ig: null, brand: cand.brand_name, region: '', place: null,
      more: !!more, smart: false, allowGeneral: false, validOnly: true }, deps);
  } catch (e) {
    return { ok: false, stage: 'email', fault: e.message, why: 'the email finder failed on our side: ' + e.message };
  }
  // The greeted person's own address, verified (the same test the local
  // lane's five use: jobs/outreachQueue.verifiedNamedEmail).
  const g = Q.greetRowOf(ladder);
  const inbox = Q.inboxOf(ladder);
  const verified = Q.channelFor(ladder, null) === 'email' && !!(g && inbox && g.email
    && String(g.email).toLowerCase() === String(inbox.email).toLowerCase() && g.emailVerify && g.emailVerify.pass);
  const f = (fin && fin.finder) || {};
  if (!verified) {
    return { ok: false, stage: 'email', ladder, fin,
      why: `no verified address for ${person.name} (${person.title}) at ${f.domain || cand.website || 'the brand\'s domain'}: `
        + (f.stop || (fin && fin.verify && fin.verify.why) || 'nothing passed') };
  }
  const gt = DM.contactTitleOk(g.title);
  if (!gt.ok) return { ok: false, stage: 'title', ladder, fin, why: `${g.name}: ${gt.why}` };
  return { ok: true, ladder, fin, why: null };
}

module.exports = { verifiedAddress };
