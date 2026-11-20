import { db, checkPassword, signSession, hashPassword } from './_lib.js';

const DUMMY = hashPassword('x'); // টাইমিং সমান রাখতে — আইডি আছে কি নেই বোঝা না যাক
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { id, password } = req.body || {};
  if (!id || !password || String(id).length > 40) return res.status(400).json({ error: 'আইডি ও পাসওয়ার্ড দিন।' });
  const r = await db().execute({ sql: 'SELECT id, name, pass FROM students WHERE id = ?', args: [String(id).trim()] });
  const u = r.rows[0];
  const ok = checkPassword(String(password), u ? u.pass : DUMMY);
  if (!u || !ok) return res.status(401).json({ error: 'আইডি বা পাসওয়ার্ড ভুল।' });
  res.status(200).json({ token: signSession(u.id), id: u.id, name: u.name });
}
