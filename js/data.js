/*
 * IUBAT Bus Tracker — data layer (DEMO)
 * --------------------------------------------------------------
 * BusFeed এখন সিমুলেশন চালায়। পরে এই ফাইলের `BusFeed` এর ভেতরে শুধু
 * সার্ভার থেকে (REST/WebSocket) লোকেশন নেওয়ার কোড বসাতে হবে —
 * বাকি UI/3D ম্যাপ একই থাকবে।
 *
 * সার্ভারের প্রত্যাশিত ফরম্যাট (প্রতি বাস):
 *   { id:'11', lat, lng, speed, heading, updatedAt }
 * এখানে ম্যাপ লোকাল কোঅর্ডিনেটে (unit = ৮ মিটার) আঁকা হচ্ছে।
 */
(function () {
  const UNIT_M = 8;            // ১ ইউনিট = ৮ মিটার (ডেমো স্কেল)
  const SPEEDUP = 14;          // ডেমোতে বাস দ্রুত চলে
  const AVG_M_PER_MIN = 400;   // ETA হিসাবের গড় গতি (~২৪ কিমি/ঘণ্টা)
  const CAMPUS = 'IUBAT ক্যাম্পাস';

  // pts: [x, y, stopName?]  — নাম থাকলে সেটা স্টপ, না থাকলে রাস্তার বাঁক
  const ROUTES = [
    { id: '11', name: 'উত্তরা রুট', color: '#e2231a', pts: [
      [-540, 330, 'আজমপুর'], [-430, 285], [-330, 215, 'উত্তরা সেক্টর ৭'], [-250, 120],
      [-170, 95, 'হাউজ বিল্ডিং'], [-80, 40], [0, 0, CAMPUS]] },
    { id: '12', name: 'মিরপুর রুট', color: '#1d6fe0', pts: [
      [-540, -280, 'মিরপুর-১০'], [-420, -250], [-310, -160, 'মিরপুর-১২'], [-220, -110, 'কাজীপাড়া'],
      [-110, -60], [0, 0, CAMPUS]] },
    { id: '13', name: 'মহাখালী রুট', color: '#8a3ffc', pts: [
      [60, -560, 'মহাখালী'], [70, -450], [40, -340, 'বনানী'], [50, -230, 'কুড়িল বিশ্বরোড'],
      [20, -120], [0, 0, CAMPUS]] },
    { id: '14', name: 'গাজীপুর রুট', color: '#f08a00', pts: [
      [120, 560, 'গাজীপুর চৌরাস্তা'], [110, 450], [150, 340, 'টঙ্গী কলেজ গেট'], [100, 230],
      [60, 110, 'বোর্ডবাজার'], [0, 0, CAMPUS]] },
    { id: '15', name: 'টঙ্গী রুট', color: '#00a3a3', pts: [
      [560, 200, 'টঙ্গী স্টেশন'], [450, 170], [360, 110, 'আব্দুল্লাহপুর'], [240, 90],
      [130, 40, 'দিয়াবাড়ি'], [0, 0, CAMPUS]] },
    { id: '16', name: 'গুলশান রুট', color: '#0b7a1c', pts: [
      [520, -250, 'গুলশান-২'], [420, -200], [320, -150, 'বাড্ডা'], [210, -100, 'প্রগতি সরণী'],
      [100, -50], [0, 0, CAMPUS]] },
  ];

  function prep(route) {
    const cum = [0];
    for (let i = 1; i < route.pts.length; i++) {
      const a = route.pts[i - 1], b = route.pts[i];
      cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    route.cum = cum;
    route.length = cum[cum.length - 1];
    route.stops = route.pts
      .map((p, i) => (p[2] ? { name: p[2], s: cum[i], x: p[0], y: p[1] } : null))
      .filter(Boolean);
    route.points = route.pts.map(p => ({ x: p[0], y: p[1] }));
  }
  ROUTES.forEach(prep);

  function pointAt(route, s) {
    s = Math.max(0, Math.min(route.length, s));
    const c = route.cum;
    let i = 1;
    while (i < c.length - 1 && c[i] < s) i++;
    const a = route.pts[i - 1], b = route.pts[i];
    const t = (s - c[i - 1]) / ((c[i] - c[i - 1]) || 1);
    return {
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      dx: b[0] - a[0], dy: b[1] - a[1],
    };
  }

  // একটু ভিন্ন গতি/অবস্থান দিয়ে ৬টি বাস
  const SEEDS = [
    { id: '11', route: '11', s: 0.62, dir: 1, kmh: 28 },
    { id: '12', route: '12', s: 0.30, dir: -1, kmh: 25 },
    { id: '13', route: '13', s: 0.78, dir: 1, kmh: 31 },
    { id: '14', route: '14', s: 0.45, dir: 1, kmh: 0, offline: true },
    { id: '15', route: '15', s: 0.15, dir: -1, kmh: 27 },
    { id: '16', route: '16', s: 0.55, dir: -1, kmh: 24 },
  ];

  const buses = SEEDS.map(sd => {
    const route = ROUTES.find(r => r.id === sd.route);
    return {
      id: sd.id, route, s: sd.s * route.length, dir: sd.dir,
      baseKmh: sd.kmh, kmh: sd.kmh, dwell: 0, atStop: null,
      offline: !!sd.offline, lastSeenMin: sd.offline ? 7 : 0, updatedAt: Date.now(),
    };
  });

  const listeners = new Set();

  function step(dt) {
    buses.forEach(b => {
      if (b.offline) return;
      const r = b.route;
      if (b.dwell > 0) {
        b.dwell -= dt; b.kmh = 0;
        if (b.dwell <= 0) { b.dwell = 0; b.atStop = null; }
        return;
      }
      // গতি সামান্য ওঠানামা করে
      b.kmh += (b.baseKmh + Math.sin(Date.now() / 1800 + +b.id) * 5 - b.kmh) * Math.min(1, dt * 1.5);
      const v = (b.kmh * 1000 / 3600) / UNIT_M * SPEEDUP; // unit/s
      const prev = b.s;
      let next = prev + b.dir * v * dt;

      // স্টপ পেরোলে থামো
      for (const st of r.stops) {
        const crossed = (prev - st.s) * (next - st.s) < 0 ||
          (Math.abs(prev - st.s) < 0.01 && false);
        if (crossed && !(b.atStop === st)) {
          next = st.s; b.atStop = st; b.dwell = 3 + Math.random() * 2;
          break;
        }
      }
      // প্রান্তে পৌঁছালে ঘুরে যাও
      if (next <= 0 || next >= r.length) {
        next = next <= 0 ? 0 : r.length;
        b.dir *= -1; b.dwell = 6; b.atStop = r.stops[next === 0 ? 0 : r.stops.length - 1];
      }
      b.s = next;
      b.updatedAt = Date.now();
    });
  }

  function busPos(b) {
    const p = pointAt(b.route, b.s);
    const hx = p.dx * b.dir, hy = p.dy * b.dir;
    return { x: p.x, y: p.y, heading: Math.atan2(hy, hx) };
  }

  const fmtMin = m => (m < 1 ? 'এখন' : Math.ceil(m) + ' মিনিট');

  function describe(b) {
    const r = b.route, pos = busPos(b);
    const travel = b.dir > 0 ? r.stops : r.stops.slice().reverse();
    const from = travel[0].name, to = travel[travel.length - 1].name;
    const startS = b.dir > 0 ? 0 : r.length;
    const progress = Math.abs(b.s - startS) / r.length;
    const remainingTo = st => Math.abs(st.s - b.s);
    let nextIdx = travel.findIndex(st => b.dir > 0 ? st.s > b.s + 0.5 : st.s < b.s - 0.5);
    const atStop = b.dwell > 0 && b.atStop ? b.atStop : null;
    const stops = travel.map((st, i) => {
      let state = 'upcoming';
      if (nextIdx === -1 || i < nextIdx) state = 'passed';
      else if (i === nextIdx) state = 'next';
      if (atStop === st) state = 'here';
      const eta = state === 'passed' || state === 'here' ? 0
        : remainingTo(st) * UNIT_M / AVG_M_PER_MIN + Math.max(0, i - nextIdx) * 0.4;
      return { name: st.name, state, etaMin: eta };
    });
    const nextStop = nextIdx === -1 ? null : stops[nextIdx];
    const destEta = nextIdx === -1 ? 0 : stops[stops.length - 1].etaMin;
    const toCampus = to === CAMPUS;
    const status = b.offline ? 'offline' : (b.dwell > 0 ? 'stopped' : 'running');
    return {
      id: b.id, routeName: r.name, color: r.color, x: pos.x, y: pos.y, heading: pos.heading,
      status, speedKmh: Math.round(b.kmh), progress, from, to, toCampus,
      nextStop, destEta, destEtaText: status === 'offline' ? '—' : fmtMin(destEta),
      nextEtaText: nextStop ? fmtMin(nextStop.etaMin) : '—',
      atStop: atStop ? atStop.name : null, stops,
      lastUpdateSec: b.offline ? b.lastSeenMin * 60 : Math.max(1, Math.round((Date.now() - b.updatedAt) / 1000) + 1 + (+b.id % 3)),
    };
  }

  // ---- Public API ---------------------------------------------------------
  const BusFeed = {
    routes: ROUTES,
    campusName: CAMPUS,
    /** ফ্রেমে ফ্রেমে ডাকুন (বাসের স্মুথ মুভমেন্ট) */
    tick(dt) { step(dt); },
    /** ম্যাপের জন্য হালকা পজিশন তালিকা */
    positions() {
      return buses.map(b => {
        const p = busPos(b);
        return { id: b.id, x: p.x, y: p.y, heading: p.heading, color: b.route.color, routeName: b.route.name,
                 status: b.offline ? 'offline' : (b.dwell > 0 ? 'stopped' : 'running') };
      });
    },
    /** UI এর জন্য পূর্ণ তথ্য (১ সেকেন্ড পরপর) */
    snapshot() { return buses.map(describe); },
  };
  window.BusFeed = BusFeed;
})();
