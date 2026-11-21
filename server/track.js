import { saveFix } from './_lib.js';
import { deviceTrip } from './_social.js';

// The tracker page on the bus phone POSTs here: { token, lat, lng, speed (m/s), heading, acc, ts }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const r = await saveFix(req.body || {});
  if (r.bus) await deviceTrip(r.bus, Number(req.body.lat), Number(req.body.lng)); // trip live / arrived at campus
  res.status(r.status).json(r.error ? { error: r.error } : { ok: true });
}
