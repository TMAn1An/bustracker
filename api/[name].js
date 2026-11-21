// Vercel: one function serves every /api/<name> endpoint (handlers live in server/).
import { API } from '../server/index.js';

export default async function handler(req, res) {
  const fn = API[String((req.query || {}).name || '')];
  if (!fn) return res.status(404).json({ error: 'Not found' });
  req.waitUntil = req.waitUntil || (p => p.catch(e => console.error(e)));
  return fn(req, res);
}
