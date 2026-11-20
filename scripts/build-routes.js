// এক-বারের টুল: স্টপ কোঅর্ডিনেট → OSRM দিয়ে রাস্তা-মেলানো জিওমেট্রি → data/routes.json
// চালান: node scripts/build-routes.js   (ইন্টারনেট লাগে; রানটাইমে এটা দরকার নেই)
import { writeFileSync } from 'node:fs';
const UA = { 'User-Agent': 'iubat-bus-tracker-setup/0.1' };
const CAMPUS = { name: 'IUBAT ক্যাম্পাস', lat: 23.8882231, lng: 90.3906409 };
// স্টপের কোঅর্ডিনেট আনুমানিক (প্লেসহোল্ডার) — আসল স্টপ বসিয়ে আবার চালান। [নাম, lat, lng]
const ROUTES = [
  { id: '11', name: 'উত্তরা রুট', color: '#e2231a', stops: [['আজমপুর', 23.8640, 90.4005], ['উত্তরা সেক্টর ৭', 23.8725, 90.3985], ['হাউজ বিল্ডিং', 23.8800, 90.3960]] },
  { id: '12', name: 'মিরপুর রুট', color: '#1d6fe0', stops: [['মিরপুর-১০', 23.8069, 90.3687], ['মিরপুর-১২', 23.8281, 90.3646]] },
  { id: '13', name: 'মহাখালী রুট', color: '#8a3ffc', stops: [['মহাখালী', 23.7781, 90.4056], ['বনানী', 23.7937, 90.4066], ['কুড়িল বিশ্বরোড', 23.8205, 90.4212]] },
  { id: '14', name: 'গাজীপুর রুট', color: '#f08a00', stops: [['গাজীপুর চৌরাস্তা', 23.9993, 90.4203], ['বোর্ডবাজার', 23.9365, 90.3985]] },
  { id: '15', name: 'টঙ্গী রুট', color: '#00a3a3', stops: [['টঙ্গী স্টেশন', 23.8999, 90.4048], ['আব্দুল্লাহপুর', 23.8790, 90.4000]] },
  { id: '16', name: 'গুলশান রুট', color: '#0b7a1c', stops: [['গুলশান-২', 23.7925, 90.4141], ['বারিধারা', 23.8040, 90.4220]] },
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 102);

const out = [];
for (const r of ROUTES) {
  const stops = [];
  for (const [name, lat, lng] of r.stops) stops.push({ name, lat, lng });
  // বাইরে থেকে ক্যাম্পাসের দিকে সাজাও (দূরেরটা আগে)
  stops.sort((a, b) => km(b, CAMPUS) - km(a, CAMPUS));
  stops.push(CAMPUS);
  const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
  const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`, { headers: UA });
  const j = await res.json();
  if (!j.routes?.[0]) { console.warn('  ! OSRM ব্যর্থ', r.id, j.code); continue; }
  const geo = j.routes[0].geometry.coordinates.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
  console.log(r.id, r.name, stops.map(s => s.name).join(' → '), (j.routes[0].distance / 1000).toFixed(1) + 'km', geo.length + 'pts');
  out.push({ id: r.id, busId: r.id, name: r.name, color: r.color, stops, geometry: geo });
  await sleep(500);
}
writeFileSync('data/routes.json', JSON.stringify({ campus: CAMPUS, routes: out }, null, 1));
console.log('data/routes.json লেখা হয়েছে');
