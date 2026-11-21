// Profile photos: GET /api/avatar?id=<userId>&v=<version>. The version changes on every upload, so phones cache it for a year.
import { db, ensureSchema } from './_lib.js';

export default async function handler(req, res) {
  await ensureSchema();
  const id = String((req.query || {}).id || '');
  const r = await db().execute({ sql: 'SELECT mime, data FROM avatars WHERE user_id = ? AND hidden = 0', args: [id] });
  const a = r.rows[0];
  if (!a) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).json({ error: 'No photo' }); }
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(Buffer.from(a.data, 'base64'));
}
