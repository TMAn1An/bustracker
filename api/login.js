import { db, checkPassword, signSession, hashPassword } from './_lib.js';

const DUMMY = hashPassword('x'); // keeps timing equal whether or not the ID exists
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { id, password } = req.body || {};
  if (!id || !password || String(id).length > 40) return res.status(400).json({ error: 'Enter your student ID and password.' });
  const r = await db().execute({ sql: 'SELECT id, name, pass FROM students WHERE id = ?', args: [String(id).trim()] });
  const u = r.rows[0];
  const ok = checkPassword(String(password), u ? u.pass : DUMMY);
  if (!u || !ok) return res.status(401).json({ error: 'Incorrect student ID or password.' });
  res.status(200).json({ token: signSession('s:' + u.id), id: u.id, name: u.name });
}
