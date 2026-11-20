import { saveFix } from './_lib.js';

// বাসের ফোনের ট্র্যাকার পেজ এখানে POST করে: { token, lat, lng, speed(m/s), heading, acc, ts }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const r = await saveFix(req.body || {});
  res.status(r.status).json(r.error ? { error: r.error } : { ok: true });
}
