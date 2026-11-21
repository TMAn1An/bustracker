// One-time data fixes for existing databases, run by the every-minute cron job (each runs until it succeeds once).
import { db, getSetting, setSetting, buildGeometry, bumpRev } from './_lib.js';

// The Rajendrapur bus starts at Pepsi Gate, Rajendrapur Bazar (on the Dhaka–Kapasia road), not at Rajendrapur Chowrastha.
// Position: Rajendrapur Bazar on OpenStreetMap; marked "approx" so the admin sees a Check flag and can drag it to the exact gate.
export const PEPSI_GATE = { name: 'Pepsi Gate, Rajendrapur Bazar', lat: 24.098211, lng: 90.451466, approx: true };

let done = false;
export async function runFixes() {
  if (done) return;
  if (await getSetting('fix_rajendrapur_start')) { done = true; return; }
  const row = (await db().execute(`SELECT stops FROM routes WHERE id = 'rajendrapur'`)).rows[0];
  if (row) {
    const stops = JSON.parse(row.stops);
    // only when the route still starts at the old seed start point and has no Pepsi Gate stop yet
    if (stops.length && /rajendrapur\s+chow?r/i.test(stops[0].name) && !stops.some(s => /pepsi/i.test(s.name))) {
      // the departure time moves to the new start; Chowrastha's pick-up time is set later by the admin
      const { time, ...chowrastha } = stops[0];
      const next = [{ ...PEPSI_GATE, ...(time ? { time } : {}) }, chowrastha, ...stops.slice(1)];
      const g = await buildGeometry(next);
      if (!g.snapped) return; // routing service unreachable: try again next minute rather than saving straight lines
      await db().execute({ sql: 'UPDATE routes SET stops = ?, geometry = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(next), JSON.stringify(g.geometry), Date.now(), 'rajendrapur'] });
      await bumpRev();
    }
  }
  await setSetting('fix_rajendrapur_start', '1'); done = true;
}
