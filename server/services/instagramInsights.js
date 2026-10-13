'use strict';
// ── EVERYTHING INSTAGRAM ALLOWS, AND WHAT IT MEANS FOR A LOCAL PITCH ─────────
//
// services/instagramConnect reads the profile and the posts with
// instagram_business_basic. With instagram_business_manage_insights granted
// this reads the rest, every call on its own so one refusal never sinks the
// others:
//
//   account    period=day over the last 30 days, metric_type=total_value:
//              reach, views, accounts_engaged, total_interactions, likes,
//              comments, saves, shares, replies, follows_and_unfollows,
//              profile_links_taps. Never impressions (deprecated April 2025).
//   audience   follower_demographics and engaged_audience_demographics,
//              period=lifetime, last_30_days and last_90_days, by city,
//              country, age and gender. Instagram returns the top 45 rows and
//              only for accounts with 100+ followers; under 100 it is stored
//              as { available: false, reason: 'under 100 followers' }, never
//              as an empty breakdown.
//   posts      per-post insights for the last 25 posts (stories skipped):
//              feed reach, views, saved, shares, total_interactions,
//              profile_visits, follows; reels the same less the last two plus
//              ig_reels_avg_watch_time.
//
// RAW VALUES ARE STORED (instagram_stats.insights), so every derived number
// below can change without refetching. NEVER A ZERO THAT IS NOT REAL: a metric
// Instagram did not give us is null with the reason, not 0.
const GRAPH = 'https://graph.instagram.com';
const INSIGHTS_SCOPE = 'instagram_business_manage_insights';
const ACCOUNT_METRICS = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'replies',
  'follows_and_unfollows', 'profile_links_taps'];
const DEMO_METRICS = ['follower_demographics', 'engaged_audience_demographics'];
const DEMO_TIMEFRAMES = ['last_30_days', 'last_90_days'];
const DEMO_BREAKDOWNS = ['city', 'country', 'age', 'gender'];
const FEED_METRICS = ['reach', 'views', 'saved', 'shares', 'total_interactions', 'profile_visits', 'follows'];
const REEL_METRICS = ['reach', 'views', 'saved', 'shares', 'total_interactions', 'ig_reels_avg_watch_time'];
const DEMOGRAPHICS_MIN_FOLLOWERS = 100;
const DAY = 86400;

// ── WHAT A META ERROR MEANS, IN PLAIN WORDS ─────────────────────────────────
//   permission_blocked  code 200 / 10 / "API access blocked": the app is not
//                       approved for this, or the athlete is not a tester
//   personal_account    the account is not a Creator or Business account
//   token_expired       code 190: the athlete must reconnect
//   under_100           Instagram keeps demographics for 100+ followers only
//   missing_scope       insights were not granted on this connection
//   other               anything else, with Instagram's own words kept
const KIND_WORDS = {
  permission_blocked: 'Instagram blocked the request: the NILDash app is not approved for this yet, or this athlete is not a tester on it',
  personal_account: 'a personal Instagram account: it must be switched to Creator or Business to connect',
  token_expired: 'the Instagram connection expired: the athlete needs a new link',
  under_100: 'Instagram only shares audience details for accounts with 100 or more followers',
  missing_scope: 'connected before NILDash asked for insights: the athlete needs a new link',
  other: 'Instagram returned an error',
};
function classify(err) {
  const e = err || {};
  const code = Number(e.code != null ? e.code : (String(e.error || '').match(/\b(\d{1,4})\b/) || [])[1]);
  const msg = String(e.message || e.error || '');
  if (code === 190 || e.invalidToken || /\b190\b|session has expired|token.*(expired|invalid)|has been revoked/i.test(msg)) return 'token_expired';
  if (/professional account|not a (business|creator)|personal account|account_type.*personal|business or creator account|must be a business/i.test(msg)) return 'personal_account';
  if (/(at least|fewer than|less than|under) 100 followers|not enough followers|100 followers/i.test(msg)) return 'under_100';
  if (code === 200 || code === 10 || /API access blocked|access blocked|permission|not authorized|insufficient (permission|developer role)|\(#10\)|\(#200\)/i.test(msg)) return 'permission_blocked';
  return 'other';
}

// One GET, Instagram's error kept with its code. fetchFn injectable (tests).
async function _get(fetchFn, path, params) {
  const f = fetchFn || globalThis.fetch;
  const url = `${GRAPH}${path}?${new URLSearchParams(params)}`;
  let res, text = '', body = null;
  try {
    res = await f(url, { signal: AbortSignal.timeout(20000) });
    text = await res.text();
    try { body = JSON.parse(text); } catch (_) { body = null; }
  } catch (e) { return { ok: false, error: `could not reach Instagram: ${e.message}`, kind: 'other', fault: true }; }
  if (!res.ok || (body && body.error)) {
    const er = (body && body.error) || {};
    const message = typeof er === 'string' ? er : `${er.type || ''} ${er.code || ''}: ${er.message || ''}`.trim() || `HTTP ${res.status} ${text.slice(0, 160)}`;
    const k = classify({ code: er.code, message });
    return { ok: false, error: message, code: er.code || null, kind: k, fault: res.status >= 500 || res.status === 429 };
  }
  return { ok: true, body };
}

// A metric's value from an insights response, whichever shape it came in.
function valueOf(body, name) {
  const d = ((body && body.data) || []).find((x) => !name || x.name === name) || (body && body.data && body.data[0]);
  if (!d) return null;
  if (d.total_value && d.total_value.value !== undefined) return Number(d.total_value.value);
  if (Array.isArray(d.values) && d.values.length) {
    const vs = d.values.map((v) => Number(v.value)).filter(Number.isFinite);
    return vs.length ? vs.reduce((a, b) => a + b, 0) : null;
  }
  return null;
}

// Breakdown rows: [{ key, value }], largest first.
function breakdownRows(body) {
  const d = body && body.data && body.data[0];
  const b = d && d.total_value && Array.isArray(d.total_value.breakdowns) && d.total_value.breakdowns[0];
  const rows = (b && Array.isArray(b.results) ? b.results : []).map((r) => ({
    key: Array.isArray(r.dimension_values) ? r.dimension_values.join(' / ') : String(r.dimension_values || ''), value: Number(r.value) }))
    .filter((r) => r.key && Number.isFinite(r.value));
  return rows.sort((a, b2) => b2.value - a.value);
}

// opts: { fetch, now, followers, posts }. -> the raw insights object.
async function fetchInsights(accessToken, igUserId, opts = {}) {
  const now = Math.floor((opts.now ? new Date(opts.now).getTime() : Date.now()) / 1000);
  const since = now - 30 * DAY, until = now;
  const id = igUserId || 'me';
  const out = { fetchedAt: new Date(now * 1000).toISOString(), window: { since: new Date(since * 1000).toISOString(), until: new Date(until * 1000).toISOString() },
    account: {}, demographics: null, posts: [], errors: [] };
  const kinds = new Set();

  // ── the account, each metric on its own ─────────────────────────────────
  for (const m of ACCOUNT_METRICS) {
    const r = await _get(opts.fetch, `/${id}/insights`, { metric: m, period: 'day', metric_type: 'total_value', since: String(since), until: String(until), access_token: accessToken });
    if (r.ok) out.account[m] = valueOf(r.body, m);
    else { out.account[m] = null; out.errors.push({ part: 'account', metric: m, kind: r.kind, error: r.error }); kinds.add(r.kind); }
  }

  // ── the audience ────────────────────────────────────────────────────────
  const followers = Number(opts.followers);
  if (Number.isFinite(followers) && followers < DEMOGRAPHICS_MIN_FOLLOWERS) {
    out.demographics = { available: false, reason: 'under 100 followers' };
  } else {
    const demo = { available: true };
    let any = false, under = false;
    for (const metric of DEMO_METRICS) {
      demo[metric] = {};
      for (const tf of DEMO_TIMEFRAMES) {
        demo[metric][tf] = {};
        for (const bd of DEMO_BREAKDOWNS) {
          const r = await _get(opts.fetch, `/${id}/insights`, { metric, period: 'lifetime', timeframe: tf, breakdown: bd, metric_type: 'total_value', access_token: accessToken });
          if (r.ok) { const rows = breakdownRows(r.body); demo[metric][tf][bd] = rows.length ? rows : null; if (rows.length) any = true; }
          else {
            demo[metric][tf][bd] = null;
            if (r.kind === 'under_100') under = true;
            out.errors.push({ part: 'demographics', metric, timeframe: tf, breakdown: bd, kind: r.kind, error: r.error }); kinds.add(r.kind);
          }
        }
      }
    }
    out.demographics = any ? demo : { available: false, reason: under ? 'under 100 followers' : 'Instagram returned no audience breakdown' };
  }

  // ── the posts ───────────────────────────────────────────────────────────
  for (const p of (opts.posts || []).slice(0, 25)) {
    const product = String(p.media_product_type || '').toUpperCase();
    if (product === 'STORY') continue;
    const metrics = product === 'REELS' ? REEL_METRICS : FEED_METRICS;
    const r = await _get(opts.fetch, `/${p.id}/insights`, { metric: metrics.join(','), access_token: accessToken });
    if (!r.ok) {
      out.posts.push({ id: p.id, insights: null, error: r.error, kind: r.kind });
      if (r.kind !== 'other') kinds.add(r.kind);
      continue;
    }
    const ins = {};
    for (const m of metrics) ins[m] = valueOf(r.body, m);
    out.posts.push({ id: p.id, insights: ins });
  }
  out.errorKinds = [...kinds];
  return out;
}

// ── DERIVED NUMBERS, FROM THE STORED RAW VALUES ─────────────────────────────
const _city = (s) => String(s || '').toLowerCase().split(',')[0].replace(/[^a-z ]/g, '').trim();
const _pct = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 10);

// The share of followers in a city, and in its area (a set of city names)
// when we know one. From follower_demographics by city; null when Instagram
// gave no city breakdown.
// The share is of ALL followers: the city's count over the follower count
// (Instagram lists only the top 45 cities, so dividing by their total would
// overstate it). A screenshot's rows are already percentages of all followers.
function localShare(insights, { city, areaCities, timeframe, followers } = {}) {
  const demo = insights && insights.demographics;
  if (!demo || !demo.available) return null;
  const fd = demo.follower_demographics || {};
  const rows = (fd[timeframe || 'last_30_days'] && fd[timeframe || 'last_30_days'].city) || (fd.last_90_days && fd.last_90_days.city) || null;
  if (!rows || !rows.length || !city) return null;
  const pct = insights.source === 'screenshot';
  const f = Number(followers);
  const total = pct ? 100 : (Number.isFinite(f) && f > 0 ? f : rows.reduce((a, r) => a + r.value, 0));
  if (!total) return null;
  const want = _city(city);
  const inCity = rows.filter((r) => _city(r.key) === want).reduce((a, r) => a + r.value, 0);
  const area = Array.isArray(areaCities) && areaCities.length ? new Set(areaCities.map(_city).concat(want)) : null;
  const inArea = area ? rows.filter((r) => area.has(_city(r.key))).reduce((a, r) => a + r.value, 0) : null;
  return { city: String(city).split(',')[0].trim(), cityShare: inCity / total, areaShare: area ? inArea / total : null,
    areaCities: area ? [...area] : null, basis: total };
}

function top(rows, n, pct) {
  if (!rows || !rows.length) return null;
  const total = pct ? 100 : rows.reduce((a, r) => a + r.value, 0);
  return rows.slice(0, n).map((r) => ({ key: r.key, value: r.value, share: total ? r.value / total : null }));
}

// stats: an instagram_stats row ({ followers_count, posts, insights }). ctx: { city, areaCities }.
function derive(stats, ctx = {}) {
  const ins = (stats && stats.insights) || null;
  const followers = stats && stats.followers_count !== null && stats.followers_count !== undefined ? Number(stats.followers_count) : null;
  const acct = (ins && ins.account) || {};
  const posts = ((ins && ins.posts) || []).filter((p) => p.insights);
  const avg = (k) => { const v = posts.map((p) => p.insights[k]).filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const reach30 = Number.isFinite(acct.reach) ? acct.reach : null;
  const inter30 = Number.isFinite(acct.total_interactions) ? acct.total_interactions : null;
  const fd = ins && ins.demographics && ins.demographics.available ? (ins.demographics.follower_demographics || {}) : null;
  const pctMode = !!(ins && ins.source === 'screenshot');
  const tf = (bd) => (fd && ((fd.last_30_days && fd.last_30_days[bd]) || (fd.last_90_days && fd.last_90_days[bd]))) || null;
  return {
    followers,
    engagementByFollowers: stats && stats.engagement_rate !== null && stats.engagement_rate !== undefined ? Number(stats.engagement_rate) : null,
    engagementByReach: reach30 && inter30 !== null ? inter30 / reach30 : null,
    reach30, views30: Number.isFinite(acct.views) ? acct.views : null,
    avgReachPerPost: avg('reach'), avgViewsPerPost: avg('views'), postsWithInsights: posts.length,
    local: localShare(ins, { ...ctx, followers }),
    topCities: top(tf('city'), 5, pctMode), topCountries: top(tf('country'), 5, pctMode), ageBands: top(tf('age'), 10, pctMode), gender: top(tf('gender'), 3, pctMode),
    demographicsAvailable: !!(ins && ins.demographics && ins.demographics.available),
    demographicsReason: ins && ins.demographics && !ins.demographics.available ? ins.demographics.reason : null,
  };
}

// ── FOR THE PITCH WRITER (services/pitchWriter) ─────────────────────────────
// The latest numbers from a CONNECTED Instagram only (never a screenshot, never
// a typed count): followers, average reach and views per post, engagement by
// followers, and the follower-by-city rows so the writer can say the share for
// the business's own city. null when not connected.
async function verifiedFor(pool, athleteId) {
  const row = await require('./instagramConnect').latestFor(pool, athleteId);
  if (!row || row.followers_count === null || row.followers_count === undefined) return null;
  const d = derive(row, {});
  const fd = row.insights && row.insights.demographics && row.insights.demographics.available ? row.insights.demographics.follower_demographics : null;
  const cityRows = fd ? ((fd.last_30_days && fd.last_30_days.city) || (fd.last_90_days && fd.last_90_days.city) || null) : null;
  return {
    asOf: new Date(row.fetched_at).toISOString().slice(0, 10), followers: Number(row.followers_count),
    avgReachPerPost: d.avgReachPerPost === null ? null : Math.round(d.avgReachPerPost),
    avgViewsPerPost: d.avgViewsPerPost === null ? null : Math.round(d.avgViewsPerPost),
    engagementPct: d.engagementByFollowers === null ? null : Math.round(d.engagementByFollowers * 1000) / 10,
    cityRows,
  };
}

// The share of followers in a business's city, from verifiedFor's rows: { city, pct } or null.
function shareForCity(v, city) {
  if (!v || !v.cityRows || !city) return null;
  const l = localShare({ demographics: { available: true, follower_demographics: { last_30_days: { city: v.cityRows } } } }, { city, followers: v.followers });
  return l && l.cityShare > 0 ? { city: l.city, pct: Math.round(l.cityShare * 100) } : null;
}

module.exports = { verifiedFor, shareForCity, fetchInsights, derive, localShare, classify, valueOf, breakdownRows, KIND_WORDS, INSIGHTS_SCOPE, ACCOUNT_METRICS,
  DEMO_METRICS, DEMO_TIMEFRAMES, DEMO_BREAKDOWNS, FEED_METRICS, REEL_METRICS, DEMOGRAPHICS_MIN_FOLLOWERS, _pct };
