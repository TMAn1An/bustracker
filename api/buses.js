import { db, getRev, ensureSchema } from './_lib.js';
import { bdNow } from './_social.js';
import { drain } from './_push.js';

// Public (open portal): the app polls this every 8 s while a bus is live (less often otherwise).
// Server time is returned too, so a wrong phone clock does not matter.
// trips: today's trip state per bus (waiting / live / arrived), riders sharing now, and thank-yous received.
export default async function handler(req, res) {
  await ensureSchema();
  const now = Date.now();
  const [pos, rev, trips, sharing, outbox] = await db().batch([
    'SELECT bus_id AS id, lat, lng, speed, heading, ts, source FROM positions',
    `SELECT value FROM settings WHERE key = 'rev'`,
    { sql: 'SELECT bus_id, leg, state, started_at, arrived_at, thanks, seats, seats_at, seats_s FROM trips WHERE day = ?', args: [bdNow(now).day] },
    { sql: `SELECT bus_id, COUNT(*) AS n FROM share_sessions WHERE last_ts > ? AND status IN ('verified','backup') GROUP BY bus_id`, args: [now - 30e3] },
    'SELECT EXISTS (SELECT 1 FROM push_msgs WHERE sent_at IS NULL) AS n',
  ], 'read');
  // Help the every-minute cron: when push messages are waiting (e.g. a big reminder batch), send a few after this response.
  if (Number(outbox.rows[0].n) && req.waitUntil) req.waitUntil(drain(8));
  const riders = Object.fromEntries(sharing.rows.map(x => [x.bus_id, Number(x.n)]));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    now, rev: rev.rows[0]?.value || '0', buses: pos.rows.map(x => ({ ...x })),
    trips: trips.rows.map(t => ({ bus: t.bus_id, leg: t.leg, state: t.state, startedAt: t.started_at, arrivedAt: t.arrived_at, thanks: Number(t.thanks),
      seats: t.seats && now - t.seats_at < 25 * 60e3 ? { level: t.seats, at: t.seats_at, s: t.seats_s } : null })), // gone at the next stop, or after 25 min at most
    riders,
  });
}
