// Push notification subscriptions. No account needed (a contributor's subscription is linked to them for champion news).
//   GET  /api/push                                   -> { key } (VAPID public key for pushManager.subscribe)
//   POST {action:'subscribe', subscription, routeId, stop, remind, treat, notices}
//   POST {action:'unsubscribe', endpoint}
//   POST {action:'inbox', endpoint}                  -> { messages }: called by the service worker when a push arrives
//   POST {action:'test', endpoint}                   -> sends "notifications are on"
import { db, ensureSchema, userFrom } from './_lib.js';
import { hit, ipOf } from './_ratelimit.js';
import { vapid, PUSH_HOST, enqueue, drain } from './_push.js';

const bad = (res, error, code = 400) => res.status(code).json({ error });
// (PUSH_TEST=1, local only: also accept a fake push service on 127.0.0.1 for scripts/test-push.js)
const okEndpoint = e => { try { const u = new URL(String(e)); return (u.protocol === 'https:' && PUSH_HOST.test(u.hostname)) || (process.env.PUSH_TEST === '1' && !process.env.PRODUCTION && u.hostname === '127.0.0.1') ? u.href : null; } catch { return null; } };

export default async function handler(req, res) {
  await ensureSchema();
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ key: (await vapid()).pub });
  if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
  const b = req.body || {}, now = Date.now();
  const endpoint = okEndpoint(b.action === 'subscribe' ? b.subscription?.endpoint : b.endpoint);
  if (!endpoint) return bad(res, 'This browser\'s push service is not supported.');

  switch (b.action) {
    case 'subscribe': {
      if (!(await hit('push:' + ipOf(req), 30, 3600e3))) return bad(res, 'Too many requests. Try again later.', 429);
      const route = b.routeId ? (await db().execute({ sql: 'SELECT id FROM routes WHERE id = ?', args: [String(b.routeId)] })).rows[0]?.id || null : null;
      // Only what the rider asked for: morning reminder at their stop (default on), evening reminder and route news (default off),
      // urgent transport notices (default on).
      const me = userFrom(req), flag = (v, def) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : def);
      await db().execute({
        sql: `INSERT INTO push_subs (endpoint, user_id, route_id, stop, remind, remind_pm, treat, notices, created_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(endpoint) DO UPDATE SET user_id = COALESCE(excluded.user_id, push_subs.user_id), route_id = excluded.route_id, stop = excluded.stop,
            remind = excluded.remind, remind_pm = excluded.remind_pm, treat = excluded.treat, notices = excluded.notices, seen_at = excluded.seen_at`,
        args: [endpoint, me ? me.id : null, route, b.stop ? String(b.stop).slice(0, 60) : null, flag(b.remind, 1), flag(b.remindPm, 0), flag(b.treat, 0), flag(b.notices, 1), now, now],
      });
      return res.status(200).json({ ok: true });
    }
    case 'unsubscribe':
      await db().batch([
        { sql: 'DELETE FROM push_msgs WHERE sub_id IN (SELECT id FROM push_subs WHERE endpoint = ?)', args: [endpoint] },
        { sql: 'DELETE FROM push_subs WHERE endpoint = ?', args: [endpoint] },
      ], 'write');
      return res.status(200).json({ ok: true });
    case 'inbox': {
      const r = await db().execute({ sql: `SELECT m.id, m.title, m.body, m.url, m.tag FROM push_msgs m JOIN push_subs s ON s.id = m.sub_id
          WHERE s.endpoint = ? AND m.read_at IS NULL AND m.created_at > ? ORDER BY m.id LIMIT 5`, args: [endpoint, now - 24 * 3600e3] });
      if (r.rows.length) await db().execute({ sql: `UPDATE push_msgs SET read_at = ? WHERE id IN (${r.rows.map(() => '?').join(',')})`, args: [now, ...r.rows.map(x => x.id)] });
      return res.status(200).json({ messages: r.rows.map(x => ({ title: x.title, body: x.body, url: x.url || '/', tag: x.tag })) });
    }
    case 'test': {
      if (!(await hit('pushtest:' + ipOf(req), 5, 3600e3))) return bad(res, 'Too many tests. Try again later.', 429);
      const n = await enqueue({ where: 's.endpoint = ?', args: [endpoint], title: '🔔 Notifications are on!', body: 'You will get a reminder 20 minutes before your bus leaves.', tag: 'test', ttl: 600 });
      if (!n) return bad(res, 'Subscription not found. Turn notifications off and on again.');
      await drain(5);
      return res.status(200).json({ ok: true });
    }
    default: return bad(res, 'Unknown action.');
  }
}
