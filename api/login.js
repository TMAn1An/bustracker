import { signSession } from './_lib.js';
import { verifyStudent } from './_students.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { id, password } = req.body || {};
  if (!id || !password || String(id).length > 40) return res.status(400).json({ error: 'Enter your student ID and password.' });
  const u = await verifyStudent(id, password);
  if (!u) return res.status(401).json({ error: 'Incorrect student ID or password.' });
  res.status(200).json({ token: signSession('s:' + u.id), id: u.id, name: u.name });
}
