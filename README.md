# Soccer Stats

Live stat tracking for soccer leagues. It's a static page (`index.html`, with `match.js` for the live tracker and `stats.js` for the stats engine and charts) backed by [Supabase](https://supabase.com) for accounts, league data and live updates. It's the soccer version of [Frisbee Stats](https://github.com/tjsprang/frisbee-stats) and shares its database: the same accounts work in both, and each app only shows its own sport's leagues.

## Features

- Email and password sign-in that stays signed in
- Leagues that are searchable, joined with a league password, with several admins each, for any size from 5-a-side to 11-a-side
- Live match tracking: lineups and goalkeepers, kickoff, half time and full time with a match clock (including stoppage time), goals with assists, penalties, own goals, shots (saved, off target, blocked), corners, fouls, offsides, yellow and red cards (a second yellow sends the player off), substitutions and undo
- Stats worked out from the timeline: appearances, starts, minutes played, goals, assists, shots, shot accuracy and conversion, penalties, cards, and goalkeeping (saves, save %, goals conceded, clean sheets, goals against per 90), plus per-90 numbers
- Seasons: end a season and start the next (from scratch or with the same teams), all-time stats across seasons, and a Hall of Fame
- Match pages (scorers, match stats side by side, score by minute, timeline, lineups), team pages (record and points, goals, clean sheets, when goals come, assist partnerships) and player pages
- Standings (3 points for a win, 1 for a draw; goal difference, goals scored, then head-to-head), and playoff brackets seeded from them, with penalty shootouts for level matches
- Public read-only links, player photos and bios, match availability (In / Maybe / Out), and CSV export
- Team admins, schedule creator, in-app notifications, and an installable app that works offline
- Practice scrimmages: split a team into Bibs and Shirts and track them live, with practice stats kept apart from league stats and visible only to that team
- Live updates on every device, and a save queue that keeps working through spotty signal

## Setup

This app uses the Frisbee Stats Supabase project. In the Supabase SQL Editor, run `supabase/017_soccer.sql` once (after `016`), and add this app's address under **Authentication → URL Configuration → Redirect URLs**.

For a brand-new Supabase project instead:

1. Create a Supabase project. In the SQL Editor, run the scripts in `supabase/` in order (`001` through `017`).
2. Put your project URL and publishable (anon) key into `SUPABASE_URL` and `SUPABASE_KEY` near the top of the script in `index.html`.
3. In Supabase, go to **Authentication → URL Configuration**. Set the **Site URL** to where the app is hosted, and add it under **Redirect URLs**.
4. Host the folder anywhere static over https, for example GitHub Pages (the service worker needs https).
