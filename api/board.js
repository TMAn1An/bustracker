// Public leaderboards, route reputation and public profiles (no sign-in needed).
//   GET  /api/board                 -> today / this week / all-time tops, champions, route reputation, seniors per route
//   GET  /api/board?route=<id>      -> the same tops for one route
//   GET  /api/board?u=<userId>      -> one rider's public profile (level, badges, contribution graph)
//   POST /api/board {action:'thank', busId}  -> send a thank-you to whoever is sharing that bus right now
import { db, ensureSchema } from './_lib.js';
import { top, finalizeWeeks, reputation, profile, bdNow, weekStart, pubUser, windows, legAt, ACTIVE_MS } from './_social.js';
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

  await finalizeWeeks();
  const today = bdNow().day, wk = weekStart(today), routeId = q.route ? String(q.route) : null;
  const data = await cached('b:' + (routeId || '*'), async () => {
    const [d, w, a, rep] = await Promise.all([
      top({ from: today, routeId, limit: 10 }), top({ from: wk, routeId, limit: 10 }), top({ from: '0000', routeId, limit: 20 }), reputation(),
    ]);
    const [champs, seniors] = await db().batch([
      { sql: `SELECT c.week, c.route_id, c.pts, u.id, u.username, u.emoji, u.color, u.avatar_v FROM champions c JOIN users u ON u.id = c.user_id
          ${routeId ? 'WHERE c.route_id = ?' : ''} ORDER BY c.week DESC LIMIT 12`, args: routeId ? [routeId] : [] },
      // the most senior active riders of each route (by admission batch) are the ones invited to treat the champion
      { sql: `SELECT * FROM (SELECT id, username, emoji, color, avatar_v, route_id, batch,
            ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY batch, created_at) AS rn
          FROM users WHERE batch IS NOT NULL AND route_id IS NOT NULL AND seen_at > ?) WHERE rn <= 5`, args: [Date.now() - ACTIVE_MS] },
    ], 'read');
    const sen = {};
    seniors.rows.forEach(x => (sen[x.route_id] ||= []).push(pubUser(x)));
    return {
      day: today, week: wk, today: d, weekTop: w, allTime: a, reputation: rep, seniors: sen,
      champions: champs.rows.map(x => ({ week: x.week, routeId: x.route_id, pts: Number(x.pts), user: pubUser(x) })),
    };
  });
  res.status(200).json(data);
}
