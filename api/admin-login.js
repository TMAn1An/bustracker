import { db, checkPassword, signSession, hashPassword } from './_lib.js';

const DUMMY = hashPassword('x');
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter username and password.' });
  const r = await db().execute({ sql: 'SELECT username, pass FROM admins WHERE username = ?', args: [String(username).trim()] });
  const u = r.rows[0];
  const ok = checkPassword(String(password), u ? u.pass : DUMMY);
  if (!u || !ok) return res.status(401).json({ error: 'Incorrect username or password.' });
  res.status(200).json({ token: signSession('a:' + u.username, 8), username: u.username });
}
