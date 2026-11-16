'use strict';
// ── THE DEMO SCHOOL (sales calls) ───────────────────────────────────────────
//
// Pinecrest State University: a made-up school with a working morning, for
// showing the university portal on a call. Teams with the school's own NIL
// deal rates, last night's pitches (paid NIL deals, with the booking link),
// businesses at every stage, two new bookings, and deals paid to athletes.
// Every name, business, email and phone number is invented (555 numbers,
// .example addresses).
//
// seed(pool) is idempotent: it wipes the demo school's rows and writes them
// again with dates relative to today, so the demo always looks like this
// morning. The nightly run never picks it (campusNightly.universitiesDue skips
// a "-demo" id), so it never spends a cent.
//
// UNIVERSITY TABLES ONLY.

const ID = 'univ-pinecrest-demo';
const NAME = 'Pinecrest State University';

const TEAMS = [
  // id, name, sport, season, roster, rate cents, what the business gets
  ['fb', 'Football', 'Football', 'Fall', 98, null, null],
  ['wvb', "Women's Volleyball", 'Volleyball', 'Fall', 17, 150000, '8 players: a two-hour appearance at your business and one Instagram post each'],
  ['wsoc', "Women's Soccer", 'Soccer', 'Fall', 28, 100000, '6 players: a one-hour appearance and one Instagram post each'],
  ['msoc', "Men's Soccer", 'Soccer', 'Fall', 27, null, null],
  ['mbb', "Men's Basketball", 'Basketball', 'Winter', 15, null, null],
  ['wbb', "Women's Basketball", 'Basketball', 'Winter', 15, 200000, '5 players: a two-hour appearance and one Instagram post each'],
  ['wsd', "Women's Swim & Dive", 'Swimming', 'Winter', 24, null, null],
  ['bsb', 'Baseball', 'Baseball', 'Spring', 36, 200000, '10 players: a two-hour appearance and one Instagram post each'],
  ['sb', 'Softball', 'Softball', 'Spring', 22, 120000, '8 players: a two-hour appearance and one Instagram post each'],
  ['mgolf', "Men's Golf", 'Golf', 'Spring', 9, 60000, '4 players: one Instagram post each and a photo at your business'],
  ['wten', "Women's Tennis", 'Tennis', 'Spring', 9, null, null],
  ['wtf', "Women's Track & Field", 'Track and Field', 'Spring', 42, null, null],
];

// Last night's pitches: team, business, kind, contact, title, why. New
// businesses; two were sent this morning (SENT_TODAY).
const CARDS = [
  ['wvb', 'Willowbrook Orthodontics', 'Orthodontist', 'Grace Moore', 'Practice Manager', 'Five minutes from the arena; parents of local kids are their patients and pass it on home match nights.'],
  ['wvb', 'Iron Oak Gym', 'Gym', 'Marcus Bell', 'General Manager', 'A gym a mile from campus; training and recovery are what players and fans care about.'],
  ['wsoc', 'Green Street Smoothies', 'Juice bar', 'Tasha Wynn', 'Owner', 'On the walk from the dorms to the soccer field; post-game food for players and fans.'],
  ['wbb', 'Pinecrest Credit Union', 'Credit union', 'Alan Price', 'Branch Manager', 'The closest branch to campus; students open their first accounts here.'],
  ['bsb', 'Pinecrest Batting Cages', 'Sports facility', 'Jo Lane', 'Owner', 'Youth players and parents who follow the team train here.'],
  ['bsb', 'Hometown Tire & Auto', 'Auto repair', 'Ray Dunn', 'Owner', 'On the main road to the ballpark; home games bring families past every weekend.'],
  ['sb', 'Sunrise Diner', 'Restaurant', 'Lucy Hart', 'Owner', 'Across from the softball complex; full on game days.'],
  ['mgolf', 'Fairway Golf Shop', 'Golf store', 'Ted Rowe', 'Store Manager', 'The nearest golf store to campus and the course the team plays.'],
  ['msoc', 'Main Street Barbers', 'Barber shop', 'Cal Ortiz', 'Owner', 'Two blocks from campus; a lot of the student body gets haircuts here.'],
  ['wsd', 'Aqua Swim School', 'Swim school', 'Nina Shaw', 'Director', 'Teaches local kids to swim, a mile from the natatorium.'],
];
const SENT_TODAY = ['Green Street Smoothies', 'Pinecrest Batting Cages'];

const PIPE = [
  // business, team, stage, days ago, what they said / last touch
  ['Riverside Auto Group', 'bsb', 'deal_signed', 3, 'Signed: 10 players at the opening weekend, posts that week.'],
  ['Harbor Lane Dental', 'wvb', 'deal_signed', 9, 'Signed: appearance at the open house, posts on the same day.'],
  ['Magnolia Coffee', 'sb', 'deal_signed', 16, 'Signed: 8 players for the spring kickoff.'],
  ['Peak Physical Therapy', 'wsoc', 'deal_signed', 34, 'Signed: 6 players, recovery clinic day.'],
  ['First Pinecrest Bank', 'wbb', 'in_talks', 1, 'Wants it the week of the home opener. Sending the terms in the marketplace.'],
  ['Southside Fitness', 'wvb', 'in_talks', 2, 'Asked if the players can do a class at the gym.'],
  ['Lakeside Outfitters', 'mgolf', 'replied', 1, 'Interested. Asked what the posts would look like.'],
  ['Corner Grill', 'wbb', 'replied', 2, 'Likes it. Wants to talk after the weekend.'],
  ['Green Street Smoothies', 'wsoc', 'contacted', 0, 'Pitched by email'],
  ['Pinecrest Batting Cages', 'bsb', 'contacted', 0, 'Pitched by email'],
  ['Elm Street Florist', 'wten', 'contacted', 8, 'Pitched by email'],
  ['Valley Chiropractic', 'wtf', 'contacted', 6, 'Pitched by email'],
  ['Lakeview Pizza', 'fb', 'declined', 12, 'Not this season. Try again in the fall.'],
];
const DEALS = [
  ['Riverside Auto Group', 'bsb', 200000, '10 players: two-hour appearance and one post each', 3],
  ['Harbor Lane Dental', 'wvb', 150000, '8 players: two-hour appearance and one post each', 9],
  ['Magnolia Coffee', 'sb', 120000, '8 players: two-hour appearance and one post each', 16],
  ['Peak Physical Therapy', 'wsoc', 100000, '6 players: one-hour appearance and one post each', 34],
];
const BOOKINGS = [
  ['Willow Creek Vet Clinic', 'wvb', 'Amy Ford', 'amy@willowcreekvet.example', '(555) 010-2231', true, 'A Saturday in March', 'We sponsor the youth league too.', 0.2],
  ['Blue Door Bakery', 'sb', 'Ben Ross', null, '(555) 010-4410', false, 'Before the home opener', 'Thinking about a post with our new menu.', 0.6],
];

const day = (n) => new Date(Date.now() - n * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function body(card, team, link) {
  const [, biz, , contact, , why] = card;
  const first = contact.split(' ')[0];
  const rate = team[5] ? `${team[6].replace(/^(\d+) players/, '$1 of our players')}, for $${(team[5] / 100).toLocaleString('en-US')} paid to the players` : null;
  return `Hi ${first},\n\n${why} We would like to offer ${biz} a paid NIL deal with the ${team[1]} team: ${rate || 'an appearance at your business or a few posts on the players\' own accounts, and we will send a few options with prices'}. It is set up and paid through our NIL marketplace, so it is simple and handled properly. Would you be open to a short call this week?\n\nSee the options and pick a date: ${link}\n\nRiley Morgan\nNIL Coordinator\n${NAME} Athletics`;
}

async function seed(pool) {
  await require('./campusPool').ensureTables(pool);
  await require('./teamScan').ensureTables(pool);
  await require('./universityBook').ensureTables(pool);
  const UB = require('./universityBook');
  for (const t of ['university_bookings', 'university_deals', 'university_touches', 'university_crm', 'university_drafts', 'university_inventory', 'university_teams']) {
    await pool.query(`DELETE FROM ${t} WHERE university_id = $1`, [ID]);
  }
  await pool.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,$2,'Pinecrest State','Pinecrest, GA')
                    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name`, [ID, NAME]);
  const tid = (k) => `${ID}:${k}`;
  for (const [k, name, sport, season, roster, cents, what] of TEAMS) {
    await pool.query(`INSERT INTO university_teams (id, university_id, name, sport, season, roster_size, home_dates, nil_rate_cents, nil_rate_what)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tid(k), ID, name, sport, season, roster, 8, cents, what]);
  }
  const teamOf = (k) => TEAMS.find((t) => t[0] === k);
  const night = iso(new Date());
  let n = 0;
  for (const c of CARDS) {
    const team = teamOf(c[0]);
    const link = UB.bookUrl(ID, tid(c[0]));
    const sentToday = SENT_TODAY.includes(c[1]);
    await pool.query(
      `INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, subject, body, kind, night, status, why, contact_name, contact_title,
                                      contact_email, contact_phone, channel, lane, sent_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pitch',$8,'awaiting_approval',$9,$10,$11,$12,$13,'email','local',$14,$15)`,
      [`demo_${ID}_${n++}`, ID, tid(c[0]), slug(c[1]), c[1], `${team[1]} players at ${c[1]}`, body(c, team, link), night, c[5], c[3], c[4],
        `${c[3].split(' ')[0].toLowerCase()}@${slug(c[1])}.example`, `(555) 010-${String(1000 + n * 37).slice(0, 4)}`, sentToday ? new Date(Date.now() - 2 * 3600000) : null, new Date()]);
  }
  for (const [biz, k, stage, ago, said] of PIPE) {
    await pool.query(`INSERT INTO university_crm (university_id, brand, stage, last_touch_at, last_touch_by, updated_at) VALUES ($1,$2,$3,$4,'Riley Morgan',$4)`,
      [ID, biz, stage, day(ago)]);
    await pool.query(`INSERT INTO university_touches (university_id, brand, user_name, channel, direction, team_id, summary, stage_after, at)
                      VALUES ($1,$2,'Riley Morgan','email','out',$3,'Pitched by email','contacted',$4)`, [ID, biz, tid(k), stage === 'contacted' ? day(ago) : day(ago + 4)]);
    if (stage !== 'contacted') {
      await pool.query(`INSERT INTO university_touches (university_id, brand, user_name, channel, direction, team_id, summary, stage_after, at)
                        VALUES ($1,$2,$2,'email','in',$3,$4,$5,$6)`, [ID, biz, tid(k), said, stage, day(ago)]);
    }
  }
  for (const [biz, k, cents, what, ago] of DEALS) {
    await pool.query(`INSERT INTO university_deals (university_id, brand, team_id, value_cents, description, signed_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,'demo')`,
      [ID, biz, tid(k), cents, what, iso(day(ago))]);
  }
  for (const [biz, k, contact, email, phone, rated, dates, note, ago] of BOOKINGS) {
    const team = teamOf(k);
    await pool.query(`INSERT INTO university_bookings (university_id, team_id, business, contact_name, email, phone, deal, price_cents, wants_options, dates, note, created_at)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ID, tid(k), biz, contact, email, phone, rated ? team[6] : null, rated ? team[5] : null, !rated, dates, note, day(ago)]);
    await pool.query(`INSERT INTO university_crm (university_id, brand, stage, last_touch_at, last_touch_by, updated_at) VALUES ($1,$2,'in_talks',$3,$4,$3)
                      ON CONFLICT (university_id, brand) DO NOTHING`, [ID, biz, day(ago), contact]);
    await pool.query(`INSERT INTO university_touches (university_id, brand, user_name, channel, direction, team_id, summary, stage_after, at)
                      VALUES ($1,$2,$3,'other','in',$4,$5,'in_talks',$6)`,
      [ID, biz, contact, tid(k), `Booked from your link: ${team[1]}, ${rated ? `${team[6]} at $${(team[5] / 100).toLocaleString('en-US')}` : 'asked for options with prices'}. When: ${dates}.`, day(ago)]);
  }
  return { ok: true, id: ID, teams: TEAMS.length, cards: CARDS.length, deals: DEALS.length, bookings: BOOKINGS.length,
    paidCents: DEALS.reduce((a, d) => a + d[2], 0), bookUrl: UB.bookUrl(ID) };
}

module.exports = { seed, ID, NAME };
