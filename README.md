# IUBAT Bus Tracker

**Open to everyone** (no sign-in): see **all routes** and tap a route to follow its bus live on a 3D map: where it is coming from / going to
(both inbound to campus and outbound from campus), next stop, arrival time and the departure schedule.
Anyone on the bus can **share its location** from their phone (checked automatically), earn XP, badges and a place on the route leaderboard.
Admins manage buses (number, route, departure times), routes and stops, and publish **notices** that appear in every student app within seconds.

```
Bus phone (Android) --GPS every 3+ s--> /api/track --> Turso (one row per bus)
Student browser <--poll every 4 s-- /api/buses <--------┘
Admin dashboard  --> /api/admin  (bus numbers, routes, stops, tracker tokens)
Map: MapLibre + OpenFreeMap (OpenStreetMap data, free, no API key). Route snapping: OSRM.
```

## Run locally
```sh
npm install
npm run seed        # local.db + Rajendrapur route / Bus 11 + demo logins + tracker token (.bus-tokens.json)
npm run dev         # http://localhost:3000   (admin: /admin/)
npm run simulate    # another terminal: fake GPS from the bus phones, driving both directions
```
One dummy student login (`2025001` / `demo1234` locally) exists only to view the prototype. Remove it with `node db/seed.js --remove-dummy`.
Demo admin (local only): `admin` / `admin1234`.

## Install as an app
The site is a Progressive Web App: on Android, Chrome shows **Install app** (button in the top bar) and the tracker opens full-screen
from the home screen with the IUBAT icon; on iPhone use Share, then Add to Home Screen. MapLibre and three.js are served from `/vendor`,
so the app does not depend on third-party CDNs (only map tiles and fonts are external).

## Pages
| Path | What |
|---|---|
| `/` | Open app: routes, my-route countdown, bus detail, 3D map, leaderboard, profiles |
| `/admin/` | Admin dashboard: **Buses** (number, route, departure times, tracker token), **Routes** (stops on a map, saved snapped to roads), **Notices** (broadcast to all apps, optional expiry) |
| `/privacy.html` | What the app does with sign-in and location data |
| `/tracker/` | Lightweight page for the bus phone (geolocation + wake lock). Or use the **Traccar Client** app: Server URL `https://<site>/api/osmand`, device identifier = bus token |

## Admin: how to set up a bus
1. **Routes → New route** (or pick a route): add stops *in driving order from the far end*; the route always ends at IUBAT Campus.
   - **Add stops in bulk**: paste the stop list from the schedule sheet, one per line, with an optional pick-up time
     (e.g. `BIPSOT 6:32 AM`). Each stop is looked up on OpenStreetMap near the route (spelling variants are tried); found stops are
     marked **Check**, unfound ones **No location**: press 📍 **Place** and click the map. Drag any marker to correct it.
   - Or click the map, or search a place and press **Add as stop**.
   - Pick-up times are shown to students and make the "Estimated" position follow the real timetable stop by stop.
   - On save the route is snapped to roads; if it is implausibly long you get a warning (a stop is probably misplaced or out of order).
2. **Buses → Add bus**: enter the bus number, pick the route. A **tracker token** is shown once; open the link on the bus phone.
3. Changing a bus number or route in the table takes effect in student apps within a few seconds (no reload).

Route stops currently only include the **start point** of Rajendrapur (Bus 11); add the stoppages in the admin dashboard.

## Crowd mode: students share the bus location
A signed-in student on the bus can tap **Share location** on that bus's page. No extra bus device is needed; others then see the bus move.
Every fix is checked on the server (`api/share.js`) before anyone else sees it:
- GPS accuracy must be 60 m or better, and the phone must be within about 80 m of the route's road;
- it must travel at least 400 m along the route over at least 90 s at vehicle speed (8–120 km/h), so sharing from home beside the highway never qualifies;
- impossible jumps (over 120 km/h between fixes) are ignored; sitting still for 6 min (e.g. got off the bus) pauses the share;
- with several riders, the one verified first wins and a newcomer more than 500 m away from it is ignored;
- the official bus phone always has priority, and riders become a standby backup;
- other students never see who is sharing; the admin **Sharing** tab shows sharers and can block them or switch the mode off.
Limitation: a fake-GPS app that imitates a moving bus along the route cannot be fully detected from a web app; the rules above, first-verified-wins and admin blocking limit the damage.
Test locally: `npm run dev`, then `node scripts/simulate-crowd.js` (five simulated riders: honest, at home, off route, jumping, conflicting; prints XP and the leaderboard).

## Open portal: contributors, leaderboard and treats
The student database has not arrived yet, so the app is open to everyone. Viewing needs nothing; **sharing needs a username** (no password).

**Identity without a password** (`api/me.js`): joining creates a random 192-bit *device key*; the phone keeps it in localStorage,
the server stores only its SHA-256 and returns a signed 60-day session token (refreshed whenever the app opens). The device key is
also the **recovery code** (copy it, or a `/#restore=<code>` link, to move to a new phone). Abuse limits: 30 new accounts per hour
per network, optional Cloudflare Turnstile (set `TURNSTILE_SITEKEY` + `TURNSTILE_SECRET`), and XP only from server-verified sharing.
When the university provides student data, an account can later be linked to a student ID for a ✔ verified badge (see `api/_students.js`).

**Usernames** follow variable-name rules: `^[A-Za-z_][A-Za-z0-9_]{2,19}$`, must contain a letter, case-insensitive unique,
reserved/rude words refused, changeable once a week. Avatar: an emoji, or a 128×128 photo (WebP/JPEG, ≤24 KB) served from `/api/avatar`.

**Sharing hours** (admin → Sharing, Bangladesh time): morning from **06:00 until the bus reaches campus** (hard stop 12:00), evening from
**17:00 until it reaches the end of its route** (hard stop 22:00). The trip must go the right way (to campus in the morning).
Each bus trip has a state per day (`trips`: waiting → live → arrived), set by the bus phone or by verified riders. Once arrived the app shows
**"✅ Reached campus at 8:12 AM"**, stops estimating, and closes sharing for that trip.

**Reminder**: star *My route* (and optionally *my stop*, if stops have pick-up times); the home card counts down from **20 min before departure**
and shows a notification while the app is open or installed. (Push to a closed app needs Web Push; see *next*.)

**XP**: 10 XP per km shared along the route (only while verified), +5 for the first rider of a trip, +15 for sharing a trip to the end,
half XP as a standby backup. Levels: Rookie Rider → Window Seat Scout → Stop Spotter → Route Captain → Highway Hero → Bus Legend → GOAT of the Road.
12 badges (Early Bird, Full Ride, On Fire streaks, 10 km Club, Weekly Champion, Generous Senior…). Profiles show a GitHub-style contribution graph.
Home shows **today's top** and **this week's best** contributor; the leaderboard has Today / This week / All time, per route or overall.
Waiting riders can send the sharer a 🙏 thank-you.

**Weekly champion and treat** (week = Sat–Fri): the first request of a new week crowns last week's #1 of each route (≥20 XP) and opens a
☕ *treat* invitation to the most senior riders of the route (by admission batch). Unclaimed treats add up (☕×2, ×3…) if the champion keeps winning.
- The champion confirms "I got my treat" with the giver's username → the giver earns 🫖 *Generous Senior*.
- If the champion never confirms, a majority of the route's active riders (≥3, accounts older than 2 days) can confirm instead ("I saw the treat happen").
- A treat pending for over 7 days is **overdue**: the route's *Generosity* rating (1–5 ★) drops, the route shows 🥲, and every **Sunday** the whole
  route sees a 24-hour "seniors are kipta" treat report.

**Moderation** (admin → Community): a single report sends a photo to the top of the review queue (red counter on the tab); the admin keeps
or removes it (optionally banning photo uploads). The reporter stops seeing that photo at once. Also: reset a username, block sharing
(also hides from leaderboards), settle or cancel treats.

**Badges are public**: every leaderboard row shows the rider's best badges, profiles show all 14 (earned ones in colour), and the home page
has a *Latest achievements* feed ("@rafi_21 unlocked 🔥 On Fire").

## University calendar (admin → Calendar)
Normal week: **open Saturday to Wednesday** (editable). Special days override it: **open** (exam, program: every bus runs that day) or
**closed** (holiday: no buses). Sharing, timetable estimates, "no bus today / next bus" texts, the route battle and push reminders all follow it.
Students see a banner for a special day today or tomorrow. A bus's own *Days* field can only narrow a normal open day.
The same tab sets an **XP boost** (e.g. *Exam week double XP*, 1.5×/2×/3× between two dates): extra XP is stored separately, so km stays honest.

## Push notifications (Web Push, free)
- Works without an account: tap the 🔔 on *My route* → *Turn on notifications* (choose *my stop* for the morning reminder).
  iPhone needs iOS 16.4+ and the app added to the Home Screen first; the app explains this.
- What is sent: ⏰ **20 min before the bus leaves** (your stop in the morning, campus in the evening; only on bus days),
  👑 Saturday 9 AM champion of the week, 📣 Sunday 9 AM treat report for routes that owe tea, ⚔️ route battle winner on the 1st,
  📢 transport notices when the admin ticks *Also send as push notification*. Each type can be switched off.
- How (`api/_push.js`): VAPID keys are created automatically on first use and kept in the settings table. Pushes carry **no payload**,
  so there is no message encryption: the server pings the browser's push service, the service worker (`sw.js`) fetches its messages from
  `/api/push` and shows them. A **Cloudflare Cron Trigger** (`wrangler.toml`, every minute) runs `tick()`: reminders, weekly/monthly announcements
  and the outbox (≈30 pushes per run; busy times also drain a few after `/api/buses` requests). Expired subscriptions are removed automatically.
- Optional `VAPID_SUBJECT` (var): contact URL or `mailto:` sent to push services (default: the site URL).
- Local test: `PUSH_TEST=1 npm run dev`, then `node scripts/test-push.js` (fake push service; checks the VAPID signature and the inbox).
  On Vercel there is no every-minute cron, so reminders only work on Cloudflare.

## Seats, route battle, feedback
- **Seats**: a verified rider who is sharing taps 🟢 Plenty / 🟡 Few / 🔴 Packed; everyone sees it on the route for 25 minutes (+2 XP, max 3 per trip; 💺 Seat Scout badge after 5).
- **Route battle** (monthly): score = share of this month's scheduled bus trips (open days × buses × 2) that had a verified rider. Fair for
  big and small routes. The winner is crowned on the 1st; everyone who shared on it gets ⚔️ Route Warrior.
- **Feedback**: anyone can send feedback (route, topic, message, optional contact; sent as their username or anonymously). Only admins see it
  (admin → Feedback, filter by route, mark New / Seen / Done). The `attachments` column is reserved for photos/videos later.

## Student ID link (ready, not active)
`users.student_id` / `verified_at` columns, a ✔ verified tick in the UI, and the `linkStudent` action in `api/me.js` (returns *coming soon*)
are in place. When the university database arrives: implement `verifyStudent()` in `api/_students.js`, then make `linkStudent` call it and save
the student ID (and the batch from the ID). Nothing else needs to change.

**Free-plan budget**: viewing endpoints are public, so polling adapts: every 8 s while a bus is live, 15 s during trip hours, 60 s otherwise,
never while the app is hidden. Leaderboards are cached 20 s per Worker instance and 60 s on the phone. If daily traffic approaches Cloudflare's
100,000 requests/day, Workers Paid ($5/month, 10M requests) removes the limit.

## 3D buses and timetable estimates
- Buses are drawn as real 3D models (yellow IUBAT bus with windows, wheels, red stripe and lights) using three.js inside a MapLibre
  custom layer (`js/bus3d.js`). three.js loads after the map is ready; if it cannot load, simple 3D boxes are shown instead.
- When a bus has **no live signal**, the app estimates where it should be from its timetable (departure time and days set in the admin
  dashboard, Bangladesh time, about 22 km/h along the route). It is clearly labelled **Estimated** with `~` on times and a note,
  and any live signal (bus phone or rider) replaces it immediately.

## Free-tier budget
Everything runs on free plans (Vercel Hobby, Turso free). To stay inside Vercel's ~1M requests/month:
bus phones and riders send a position every **10 s**, the app polls every **8 s** (only while it is open and visible),
and between updates the app moves each bus along its route at its last speed (dead reckoning), so it still looks live.
Rough cost: one bus phone ≈ 360 requests/hour; one student with the app open ≈ 450 requests/hour.
A pilot (a few bus phones, a few hundred students a day) fits; the whole university at once needs a bigger plan or a free
always-on server (e.g. Oracle Cloud Always Free).

## Login protection
5 wrong passwords on one account lock it for 5 minutes (the wait doubles on further failures, max 60 min); 20 failures from one IP lock that IP the same way. A correct login resets the counter.

## Production (Cloudflare Workers + Turso, free plans)
Live: https://bustracker.iubat.workers.dev (admin: `/admin/`, bus phone: `/tracker/`).
The Cloudflare Worker `bustracker` is connected to this GitHub repo (Workers Builds): every push deploys automatically.
`worker.js` adapts the same `api/*` handlers; static files are served as Workers Static Assets (`.assetsignore` keeps code and
config private, `_headers` sets security/cache headers). Worker secrets: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`.
Optional: `TURNSTILE_SITEKEY` (var) and `TURNSTILE_SECRET` (secret) turn on a bot check when someone picks a username.
Cloudflare's free plan allows 100,000 API requests/day (static files are unlimited) and about 10 ms CPU per request,
which is why passwords use PBKDF2 (older scrypt hashes are still accepted).
Local Worker test: put the three secrets in `.dev.vars` (git-ignored) and run `npx wrangler dev`.

## Also on Vercel (same code, same database)
The original deployment (https://iubat-bustracker.vercel.app) still works from the same repo.

## Production setup details
The Vercel project is connected to this GitHub repo: every push to `ccr-31ad4227-axu7x6` deploys to production automatically.

Env vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET` (long random string).
```sh
node db/seed.js --no-demo                     # tables, Rajendrapur route, Bus 11 (+ token in .bus-tokens.json), dummy student (override with DUMMY_STUDENT_ID / DUMMY_STUDENT_PASSWORD)
node db/seed.js --admin <username> <password> # create an admin (8+ chars)
node db/seed.js --students students.csv       # columns: id,name,password
```

## Known limitations / next
- The student ID login (`api/login.js`, `verifyStudent()`) is kept but no longer used by the app. When the university provides its student database it can be used to link a contributor account to a real student (verified badge, real seniority for treats).
- Push needs a browser that supports Web Push (Chrome/Edge/Firefox on Android and desktop; Safari on iPhone only from the Home Screen app).
- A browser page on the bus phone can be paused by Android when the screen is off; keep it charging with screen on, or use Traccar Client.
