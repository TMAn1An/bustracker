// Public leaderboards, route reputation and public profiles (no sign-in needed).
//   GET  /api/board                 -> today / this week / all-time tops, champions, route reputation, seniors per route
//   GET  /api/board?route=<id>      -> the same tops for one route
//   GET  /api/board?u=<userId>      -> one rider's public profile (level, badges, contribution graph)
//   POST /api/board {action:'thank', busId}  -> send a thank-you to whoever is sharing that bus right now
import { db, ensureSchema } from './_lib.js';
import { top, finalizeWeeks, finalizeMonth, battle, reputation, profile, bdNow, weekStart, pubUser, windows, legAt, ACTIVE_MS } from './_social.js';
import { hit, ipOf } from './_ratelimit.js';

// Small per-isolate cache: leaderboards change slowly and many phones ask for the same thing.
const cache = new Map(), TTL = 20e3;
async function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.v;
  const v = await fn(); cache.set(key, { at: Date.now(), v });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return v;
}

export default async function handler(req, res) {
  await ensureSchema();
  const q = req.query || {};
  if (req.method === 'POST') {
    const body = req.body || {}, busId = String(body.busId || '');
    if (body.action !== 'thank' || !busId) return res.status(400).json({ error: 'Bad request' });
    const t = bdNow(), leg = legAt(await windows(), t.min);
    if (!leg) return res.status(400).json({ error: 'Nobody is sharing right now.' });
    if (!(await hit(`thank:${ipOf(req)}:${busId}:${t.day}:${leg}`, 3, 12 * 3600e3))) return res.status(200).json({ ok: true, dup: true });
    const r = await db().execute({ sql: `UPDATE trips SET thanks = thanks + 1 WHERE bus_id = ? AND day = ? AND leg = ? RETURNING thanks`, args: [busId, t.day, leg] });
    return res.status(200).json({ ok: true, thanks: r.rows[0] ? Number(r.rows[0].thanks) : 0 });
  }
  res.setHeader('Cache-Control', 'no-store');

  if (q.u) {
    const p = await cached('u:' + q.u, () => profile(String(q.u)));
    if (!p) return res.status(404).json({ error: 'Rider not found.' });
    return res.status(200).json({ profile: p.pub });
  }

  await finalizeWeeks(); await finalizeMonth();
  const today = bdNow().day, wk = weekStart(today), routeId = q.route ? String(q.route) : null;
  const data = await cached('b:' + (routeId || '*'), async () => {
    const [d, w, a, rep, war] = await Promise.all([
      top({ from: today, routeId, limit: 10 }), top({ from: wk, routeId, limit: 10 }), top({ from: '0000', routeId, limit: 20 }), reputation(), battle(),
    ]);
    const [champs, seniors, recent, wins] = await db().batch([
      { sql: `SELECT c.week, c.route_id, c.pts, u.id, u.username, u.emoji, u.color, u.avatar_v FROM champions c JOIN users u ON u.id = c.user_id
          ${routeId ? 'WHERE c.route_id = ?' : ''} ORDER BY c.week DESC LIMIT 12`, args: routeId ? [routeId] : [] },
      // the most senior active riders of each route (by admission batch) are the ones invited to treat the champion
      { sql: `SELECT * FROM (SELECT id, username, emoji, color, avatar_v, route_id, batch,
            ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY batch, created_at) AS rn
          FROM users WHERE batch IS NOT NULL AND route_id IS NOT NULL AND seen_at > ?) WHERE rn <= 5`, args: [Date.now() - ACTIVE_MS] },
      // latest badge unlocks (everyone sees them: motivation)
      `SELECT e.badge, e.at, u.id, u.username, u.emoji, u.color, u.avatar_v, u.route_id, u.badges FROM badge_events e JOIN users u ON u.id = e.user_id
        WHERE NOT EXISTS (SELECT 1 FROM share_blocks b WHERE b.student_id = u.id) ORDER BY e.at DESC LIMIT 8`,
      'SELECT month, route_id, pct FROM route_wins ORDER BY month DESC LIMIT 6',
    ], 'read');
    const sen = {};
    seniors.rows.forEach(x => (sen[x.route_id] ||= []).push(pubUser(x)));
    return {
      day: today, week: wk, today: d, weekTop: w, allTime: a, reputation: rep, seniors: sen, battle: war,
      battleWins: wins.rows.map(x => ({ month: x.month, routeId: x.route_id, pct: Number(x.pct) })),
      recent: recent.rows.map(x => ({ badge: x.badge, at: x.at, user: pubUser(x) })),
      champions: champs.rows.map(x => ({ week: x.week, routeId: x.route_id, pts: Number(x.pts), user: pubUser(x) })),
    };
  });
  res.status(200).json(data);
}
