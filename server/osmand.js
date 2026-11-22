import { saveFix, db, ensureSchema } from './_lib.js';
import { deviceTrip } from './_social.js';
import { crowdFix } from './share.js';

// Traccar Client app (OsmAnd protocol). Two senders use it:
//   - the bus phone: id = the bus's device token
//   - a rider sharing with the screen off: id = their personal "r_..." ID (users.bg_token), for the bus they picked (users.bg_bus);
//     every fix goes through the same checks as sharing from the web app (on the route, moving like a bus, slots, windows).
// Older app versions send query parameters (/api/osmand?id=&lat=&lon=&speed=<knots>&bearing=&accuracy=&timestamp=),
// newer ones POST JSON: { device_id, location: { timestamp, coords: { latitude, longitude, accuracy, speed (m/s), heading } } }.
function parse(req) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const b = req.body && typeof req.body === 'object' ? req.body : null;
  const loc = b && (Array.isArray(b.location) ? b.location[b.location.length - 1] : b.location);
  if (loc && loc.coords) {
    const c = loc.coords, t = Date.parse(loc.timestamp);
    return { id: String(b.device_id || q.id || ''), lat: c.latitude, lng: c.longitude, acc: c.accuracy, heading: c.heading,
      speed: Number.isFinite(+c.speed) && +c.speed >= 0 ? +c.speed : null, ts: Number.isFinite(t) ? t : undefined };
  }
  const knots = Number(q.speed), ts = Number(q.timestamp);
  return { id: String(q.id || ''), lat: q.lat, lng: q.lon, acc: q.accuracy, heading: q.bearing,
    speed: Number.isFinite(knots) ? knots * 0.514444 : null, ts: q.timestamp ? ts * (ts < 1e12 ? 1000 : 1) : undefined };
}

export default async function handler(req, res) {
  const f = parse(req);
  if (f.id.startsWith('r_')) {
    // A rider's phone. Always answer 200: the app would otherwise queue and resend the fix forever.
    // Old queued fixes (sent late after the phone was offline) are ignored: the bus has moved on since.
    if (f.ts && Date.now() - f.ts > 120e3) return res.status(200).send('OK');
    await ensureSchema();
    const u = (await db().execute({ sql: 'SELECT id, bg_bus FROM users WHERE bg_token = ?', args: [f.id] })).rows[0];
    if (!u || !u.bg_bus) return res.status(200).send('Unknown ID');
    const r = await crowdFix(u.id, { busId: u.bg_bus, lat: f.lat, lng: f.lng, acc: f.acc ?? 30, speed: f.speed ?? undefined, heading: f.heading ?? undefined });
    return res.status(200).send(r.json.status || r.json.error || 'OK');
  }
  const r = await saveFix({ token: f.id, lat: f.lat, lng: f.lng, heading: f.heading, acc: f.acc, speed: f.speed, ts: f.ts });
  if (r.bus) await deviceTrip(r.bus, Number(f.lat), Number(f.lng));
  res.status(r.status).send(r.error || 'OK');
}
