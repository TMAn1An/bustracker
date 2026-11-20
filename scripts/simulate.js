// ডেমো: আসল ফোনের মতো /api/track এ GPS পাঠায়, বাসগুলো রুট ধরে চলে। (শুধু টেস্ট/ডেমোর জন্য)
// চালান: node scripts/simulate.js [baseUrl]   (আগে npm run seed, npm run dev)
import { readFileSync } from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:3000';
const routes = JSON.parse(readFileSync('data/routes.json')).routes;
const tokens = JSON.parse(readFileSync('.bus-tokens.json'));
const SPEEDUP = 6, TICK = 3000;

const toM = (a, b) => [(b[0] - a[0]) * 102000, (b[1] - a[1]) * 111000];
const buses = routes.filter(r => tokens[r.busId]).map((r, i) => {
  const cum = [0];
  for (let k = 1; k < r.geometry.length; k++) { const [dx, dy] = toM(r.geometry[k - 1], r.geometry[k]); cum.push(cum[k - 1] + Math.hypot(dx, dy)); }
  return { r, cum, s: cum[cum.length - 1] * (0.15 + 0.13 * i), dir: i % 2 ? -1 : 1, kmh: 22 + (i * 3) % 12, dwell: 0, off: r.busId === '14' };
});
function at(b) {
  const { r, cum } = b; let k = 1; while (k < cum.length - 1 && cum[k] < b.s) k++;
  const t = (b.s - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1), A = r.geometry[k - 1], B = r.geometry[k];
  const [dx, dy] = toM(A, B);
  return { lng: A[0] + (B[0] - A[0]) * t, lat: A[1] + (B[1] - A[1]) * t, heading: ((Math.atan2(dx * b.dir, dy * b.dir) * 180 / Math.PI) + 360) % 360 };
}
async function tick() {
  for (const b of buses) {
    if (b.off) continue; // একটা বাস অফলাইন দেখানোর জন্য
    const total = b.cum[b.cum.length - 1];
    if (b.dwell > 0) b.dwell -= TICK / 1000; else b.s += b.dir * (b.kmh / 3.6) * (TICK / 1000) * SPEEDUP;
    if (b.s <= 0 || b.s >= total) { b.s = Math.max(0, Math.min(total, b.s)); b.dir *= -1; b.dwell = 12; }
    const p = at(b);
    fetch(`${BASE}/api/track`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokens[b.r.busId], lat: p.lat, lng: p.lng, heading: p.heading, speed: b.dwell > 0 ? 0 : b.kmh / 3.6, acc: 8 }) })
      .catch(e => console.error('send failed', e.message));
  }
}
console.log(`${buses.length} টা বাস সিমুলেট হচ্ছে → ${BASE}`); tick(); setInterval(tick, TICK);
