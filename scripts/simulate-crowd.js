// Test/demo for crowd mode (LOCAL ONLY): five "riders" share location for Bus 11 and we print how the server judges them.
//   A honest rider moving with the bus      -> should become "verified" and move the bus
//   B sitting at home 40 m off the highway   -> should stay "checking" (never verified)
//   C 2 km away from the route               -> "off_route"
//   D location jumping around                -> "jump"
//   E moving rider, verified later, but far from A -> "disagree" (A was verified first)
// Run: npm run dev, then node scripts/simulate-crowd.js
import { db, ensureSchema } from '../api/_lib.js';
if (process.env.TURSO_DATABASE_URL) { console.error('Refusing to run against a remote database.'); process.exit(1); }
const BASE = process.argv[2] || 'http://localhost:3000', DURATION = 170e3, TICK = 3000;
await ensureSchema();

// test riders are contributor accounts (no password); sharing is opened all day for the test (restored at the end)
await db().execute(`DELETE FROM users WHERE username LIKE 'sim_rider_%'`);
await db().execute(`DELETE FROM positions WHERE bus_id='11'`);
await db().execute(`DELETE FROM share_sessions`); await db().execute(`DELETE FROM share_fixes`); await db().execute(`DELETE FROM trips WHERE bus_id='11'`);
const oldWin = (await db().execute(`SELECT value FROM settings WHERE key='win_am'`)).rows[0]?.value;
await db().execute(`INSERT INTO settings (key,value) VALUES ('win_am','00:00-23:59') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
const restore = async () => oldWin ? db().execute({ sql: `UPDATE settings SET value=? WHERE key='win_am'`, args: [oldWin] }) : db().execute(`DELETE FROM settings WHERE key='win_am'`);

const join = async k => (await (await fetch(BASE + '/api/me', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'join', username: 'sim_rider_' + k, emoji: '🦊', routeId: 'rajendrapur' }) })).json()).token;
const tokens = Object.fromEntries(await Promise.all(['a', 'b', 'c', 'd', 'e'].map(async k => [k, await join(k)])));
const cfg = await (await fetch(BASE + '/api/routes')).json();
const geo = cfg.routes.find(r => r.id === cfg.buses.find(b => b.id === '11').routeId).geometry;

const toM = (a, b) => [(b[0] - a[0]) * 102000, (b[1] - a[1]) * 111000];
const cum = [0]; for (let k = 1; k < geo.length; k++) { const [dx, dy] = toM(geo[k - 1], geo[k]); cum.push(cum[k - 1] + Math.hypot(dx, dy)); }
const at = s => { let k = 1; while (k < cum.length - 1 && cum[k] < s) k++; const t = (s - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1), A = geo[k - 1], B = geo[k];
  const [dx, dy] = toM(A, B), l = Math.hypot(dx, dy) || 1; return { lng: A[0] + (B[0] - A[0]) * t, lat: A[1] + (B[1] - A[1]) * t, nx: -dy / l, ny: dx / l }; };
const jitter = () => (Math.random() - 0.5) * 8 / 111000;
const t0 = Date.now(), v = 30 / 3.6;                 // bus at 30 km/h
const home = at(3000);                               // B's house: 40 m beside the road
const riders = {
  a: t => { const p = at(2000 + v * t); return { lat: p.lat + jitter(), lng: p.lng + jitter() }; },
  b: () => ({ lat: home.lat + home.ny * 40 / 111000 + jitter(), lng: home.lng + home.nx * 40 / 102000 + jitter() }),
  c: () => ({ lat: home.lat + 0.018, lng: home.lng + 0.012 }),
  d: t => { const p = at(2000 + v * t + (Math.floor(t / 3) % 2 ? 6000 : 0)); return { lat: p.lat, lng: p.lng }; },
  e: t => (t < 20 ? null : (() => { const p = at(6000 + v * t); return { lat: p.lat + jitter(), lng: p.lng + jitter() }; })()),
};
const last = {};
async function tick() {
  const t = (Date.now() - t0) / 1000;
  const line = [];
  for (const [k, f] of Object.entries(riders)) {
    const p = f(t); if (!p) { line.push(`${k.toUpperCase()}:-`); continue; }
    const r = await fetch(BASE + '/api/share', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tokens[k] },
      body: JSON.stringify({ busId: '11', lat: p.lat, lng: p.lng, acc: 10, speed: k === 'b' || k === 'c' ? 0 : v }) });
    const j = await r.json(); last[k] = j.status || j.error; line.push(`${k.toUpperCase()}:${last[k]}${j.xp ? `(${j.xp}xp)` : ''}`);
  }
  const pos = (await db().execute(`SELECT source, ts FROM positions WHERE bus_id='11'`)).rows[0];
  console.log(`t=${String(Math.round(t)).padStart(3)}s  ${line.join('  ')}  | bus: ${pos ? pos.source : 'no position'}`);
}
const iv = setInterval(tick, TICK); await tick();
setTimeout(async () => {
  clearInterval(iv); console.log('FINAL', last);
  console.log('Leaderboard today:', (await (await fetch(BASE + '/api/board')).json()).today.map(x => `${x.username} ${x.pts}xp`).join(', ') || '(empty)');
  await restore(); process.exit(0);
}, DURATION);
