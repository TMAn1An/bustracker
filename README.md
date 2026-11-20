# IUBAT Bus Tracker

Students sign in and see live bus locations on a 3D map: bus number, where it is coming from / going to (both
inbound to campus and outbound from campus), and the estimated arrival time. Admins manage buses, routes and stops.

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

## Pages
| Path | What |
|---|---|
| `/` | Student app (sign in, bus list, bus detail, 3D map) |
| `/admin/` | Admin dashboard: **Buses** (number, route, tracker token) and **Routes** (stops on a map, saved snapped to roads) |
| `/tracker/` | Lightweight page for the bus phone (geolocation + wake lock). Or use the **Traccar Client** app: Server URL `https://<site>/api/osmand`, device identifier = bus token |

## Admin: how to set up a bus
1. **Routes → New route**: name it, search/click the map to add stops *in driving order from the far end*; the route always ends at IUBAT Campus. Save.
2. **Buses → Add bus**: enter the bus number, pick the route. A **tracker token** is shown once; open the link on the bus phone.
3. Changing a bus number or route in the table takes effect in student apps within a few seconds (no reload).

Route stops currently only include the **start point** of Rajendrapur (Bus 11); add the stoppages in the admin dashboard.

## Production (Vercel + Turso)
Env vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET` (long random string).
```sh
node db/seed.js --no-demo                     # tables, Rajendrapur route, Bus 11 (+ token in .bus-tokens.json), dummy student (override with DUMMY_STUDENT_ID / DUMMY_STUDENT_PASSWORD)
node db/seed.js --admin <username> <password> # create an admin (8+ chars)
node db/seed.js --students students.csv       # columns: id,name,password
```

## Known limitations / next
- No login rate-limiting yet (add before launch).
- Student login uses **one dummy account** for the prototype (`--remove-dummy` deletes it). When the university provides its student database, only `verifyStudent()` in `api/_students.js` needs to change (nothing else depends on where students are stored).
- A browser page on the bus phone can be paused by Android when the screen is off; keep it charging with screen on, or use Traccar Client.
