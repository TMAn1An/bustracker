import { db, bearer, verifySession } from './_lib.js';

// স্টুডেন্ট অ্যাপ ৩-৫ সেকেন্ডে একবার এটা ডাকে। সার্ভারের সময়ও ফেরত যায় (ক্লায়েন্টের ঘড়ি ভুল হলেও চলবে)।
export default async function handler(req, res) {
  if (!verifySession(bearer(req))) return res.status(401).json({ error: 'লগইন করুন।' });
  const r = await db().execute('SELECT bus_id AS id, lat, lng, speed, heading, ts FROM positions');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ now: Date.now(), buses: r.rows.map(x => ({ ...x })) });
}
