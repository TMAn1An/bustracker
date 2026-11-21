// Feedback from riders (no account needed). Only admins can read it (admin dashboard -> Feedback).
// `attachments` is reserved for photos/videos later (JSON list of uploaded file ids).
import { db, ensureSchema, userFrom, sha256 } from './_lib.js';
import { hit, ipOf } from './_ratelimit.js';

const KINDS = ['bus', 'driver', 'schedule', 'app', 'idea', 'other'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  await ensureSchema();
  const b = req.body || {}, ip = ipOf(req);
  const message = String(b.message || '').trim();
  if (message.length < 5) return res.status(400).json({ error: 'Please write a little more (at least 5 characters).' });
  if (message.length > 1500) return res.status(400).json({ error: 'Too long: keep it under 1500 characters.' });
  if (!(await hit('feedback:' + ip, 8, 3600e3))) return res.status(429).json({ error: 'Too many messages from this network. Try again later.' });
  const route = b.routeId ? (await db().execute({ sql: 'SELECT id FROM routes WHERE id = ?', args: [String(b.routeId)] })).rows[0]?.id || null : null;
  const me = userFrom(req);
  await db().execute({
    sql: `INSERT INTO feedback (route_id, bus_id, kind, message, user_id, contact, attachments, created_at, ip_hash) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [route, b.busId ? String(b.busId).slice(0, 10) : null, KINDS.includes(b.kind) ? b.kind : 'other', message, me ? me.id : null,
      b.contact ? String(b.contact).trim().slice(0, 80) : null, null, Date.now(), sha256('fb:' + ip).slice(0, 16)],
  });
  res.status(200).json({ ok: true });
}
