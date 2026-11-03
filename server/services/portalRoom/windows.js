'use strict';
// THE WINDOWS, 2026-27 football. Kept here so the page and the morning report
// say the same thing.
const WINDOWS = {
  football: {
    main: { opens: '2027-01-02', closes: '2027-01-16', text: 'The football portal window is Jan 2 to 16, 2027.' },
    postseason: 'A player whose team is still playing gets 5 days after his last game.',
    // NCAA, Oct 2025: 15 days, opening 5 days after the new head coach is
    // named (it was 30 days from the change).
    coachingChange: 'When his head coach leaves, he gets a 15-day window to enter the portal, starting 5 days after the school names the new head coach.',
  },
};

module.exports = WINDOWS;
