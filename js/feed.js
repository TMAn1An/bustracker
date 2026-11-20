/*
 * Feed — সার্ভার থেকে বাসের লোকেশন নেয় (প্রতি ৪ সেকেন্ডে), রুটের সাথে মিলিয়ে
 * দিক/অগ্রগতি/ETA হিসাব করে, আর ম্যাপের জন্য স্মুথ পজিশন দেয়।
 */
(function () {
  const POLL_MS = 4000, OFFLINE_S = 60, STOP_R = 60, MOVING = 1.0; // m/s
  const rad = Math.PI / 180;
  let lat0 = 23.8882, lng0 = 90.3906, kx = 111320 * Math.cos(lat0 * rad), ky = 110574;
  const xy = (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky];
  const ll = (x, y) => [lng0 + x / kx, lat0 + y / ky];
  const fmtMin = m => (m < 1 ? 'এখন' : Math.ceil(m) + ' মিনিট');
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

  function prep(r) {
    r.xy = r.geometry.map(([lng, lat]) => xy(lng, lat));
    r.cum = [0];
    for (let i = 1; i < r.xy.length; i++) r.cum.push(r.cum[i - 1] + Math.hypot(r.xy[i][0] - r.xy[i - 1][0], r.xy[i][1] - r.xy[i - 1][1]));
    r.length = r.cum[r.cum.length - 1];
    r.stops.forEach(s => { s.s = project(r, ...xy(s.lng, s.lat)).s; });
    r.stops.sort((a, b) => a.s - b.s);
  }
  // বিন্দুকে রুটের নিকটতম অংশে প্রজেক্ট করে: { s (মিটার), dist, x, y, bearing }
  function project(r, px, py) {
    let best = { dist: Infinity };
    for (let i = 1; i < r.xy.length; i++) {
      const [ax, ay] = r.xy[i - 1], [bx, by] = r.xy[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      const x = ax + dx * t, y = ay + dy * t, d = Math.hypot(px - x, py - y);
      if (d < best.dist) best = { dist: d, s: r.cum[i - 1] + t * Math.sqrt(l2), x, y, bearing: (Math.atan2(dx, dy) / rad + 360) % 360 };
    }
    return best;
  }

  const Feed = {
    campus: null, routes: [], offset: 0, ok: true, onAuthFail: () => {}, onStatus: () => {},
    state: new Map(), token: null, timer: null,

    async init() {
      const j = await (await fetch('data/routes.json')).json();
      this.campus = j.campus; lat0 = j.campus.lat; lng0 = j.campus.lng; kx = 111320 * Math.cos(lat0 * rad);
      this.routes = j.routes; this.routes.forEach(prep);
      this.routes.forEach(r => this.state.set(r.busId, { r, fix: null, dir: 1, ema: 22 / 3.6, disp: null }));
    },

    async login(id, password) {
      let res;
      try { res = await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password }) }); }
      catch { throw new Error('সার্ভারের সাথে সংযোগ হচ্ছে না। ইন্টারনেট দেখুন।'); }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'লগইন ব্যর্থ হয়েছে।');
      return j;
    },

    start(token) { this.token = token; this.poll(); clearInterval(this.timer); this.timer = setInterval(() => this.poll(), POLL_MS); },
    stop() { clearInterval(this.timer); this.token = null; this.state.forEach(s => { s.fix = null; s.disp = null; }); },

    async poll() {
      if (!this.token || document.hidden) return;
      try {
        const res = await fetch('api/buses', { headers: { Authorization: 'Bearer ' + this.token }, cache: 'no-store' });
        if (res.status === 401) { this.stop(); return this.onAuthFail(); }
        const j = await res.json();
        this.offset = j.now - Date.now();
        j.buses.forEach(f => this.ingest(f));
        if (!this.ok) { this.ok = true; this.onStatus(true); }
      } catch { if (this.ok) { this.ok = false; this.onStatus(false); } }
    },

    ingest(f) {
      const st = this.state.get(String(f.id)); if (!st) return;
      if (st.fix && f.ts <= st.fix.ts) return;
      const p = xy(f.lng, f.lat), pr = project(st.r, p[0], p[1]);
      // দিক: হেডিং থাকলে সেটা, নইলে আগের s এর সাথে তুলনা
      if (f.speed > MOVING && f.heading != null) st.dir = Math.abs(angDiff(f.heading, pr.bearing)) < 90 ? 1 : -1;
      else if (st.fix && Math.abs(pr.s - st.fix.s) > 15) st.dir = pr.s > st.fix.s ? 1 : -1;
      if (f.speed > 1.5) st.ema += (f.speed - st.ema) * 0.2;
      const onRoad = pr.dist < 50;
      const [lng, lat] = onRoad ? ll(pr.x, pr.y) : [f.lng, f.lat];
      st.fix = { ...f, s: pr.s, off: pr.dist, tLng: lng, tLat: lat, tHead: onRoad ? (st.dir > 0 ? pr.bearing : (pr.bearing + 180) % 360) : (f.heading ?? 0) };
      if (!st.disp) st.disp = { lng, lat, heading: st.fix.tHead };
    },

    /** প্রতি ফ্রেমে ডাকুন — স্মুথ পজিশন */
    positions(dt) {
      const k = 1 - Math.exp(-dt / 0.9), out = [];
      this.state.forEach((st, id) => {
        if (!st.fix || !st.disp) return;
        const d = st.disp, f = st.fix;
        d.lng += (f.tLng - d.lng) * k; d.lat += (f.tLat - d.lat) * k;
        d.heading = (d.heading + angDiff(f.tHead, d.heading) * k + 360) % 360;
        out.push({ id, lng: d.lng, lat: d.lat, heading: d.heading, color: st.r.color, routeId: st.r.id, status: this._status(st) });
      });
      return out;
    },

    _age(st) { return st.fix ? Math.max(0, (Date.now() + this.offset - st.fix.ts) / 1000) : Infinity; },
    _status(st) {
      if (!st.fix || this._age(st) > OFFLINE_S) return 'offline';
      return st.fix.speed != null && st.fix.speed < MOVING ? 'stopped' : 'running';
    },

    /** UI এর জন্য পূর্ণ তথ্য (১ সেকেন্ড পরপর) */
    snapshot() { return [...this.state.values()].map(st => this._describe(st)); },

    _describe(st) {
      const r = st.r, f = st.fix, status = this._status(st);
      const travel = st.dir > 0 ? r.stops : r.stops.slice().reverse();
      const from = travel[0].name, to = travel[travel.length - 1].name;
      const base = { id: r.busId, routeId: r.id, routeName: r.name, color: r.color, status, from, to,
        toCampus: st.dir > 0, speedKmh: 0, progress: 0, nextStop: null, destEta: 0, destEtaText: '—',
        nextEtaText: '—', atStop: null, lastUpdateSec: null,
        stops: travel.map(s => ({ name: s.name, state: 'upcoming', etaMin: 0 })) };
      if (!f) return { ...base, noData: true };

      const s = f.s, age = this._age(st);
      const v = Math.max(15 / 3.6, Math.min(40 / 3.6, st.ema)); // ETA এর জন্য ১৫–৪০ কিমি/ঘ
      const ahead = x => (st.dir > 0 ? x.s - s : s - x.s);
      let nextIdx = travel.findIndex(x => ahead(x) > 25);
      const here = status === 'stopped' ? travel.find(x => Math.abs(x.s - s) < STOP_R) : null;
      const stops = travel.map((x, i) => {
        let state = nextIdx === -1 || i < nextIdx ? 'passed' : i === nextIdx ? 'next' : 'upcoming';
        if (here === x) state = 'here';
        const eta = state === 'passed' || state === 'here' ? 0 : ahead(x) / v / 60 + Math.max(0, i - nextIdx) * 0.4;
        return { name: x.name, state, etaMin: eta };
      });
      const nextStop = nextIdx === -1 ? null : stops[nextIdx];
      const destEta = nextIdx === -1 ? 0 : stops[stops.length - 1].etaMin;
      return { ...base, stops, nextStop, destEta,
        speedKmh: status === 'offline' ? 0 : Math.round((f.speed || 0) * 3.6),
        progress: Math.max(0, Math.min(1, (st.dir > 0 ? s : r.length - s) / r.length)),
        destEtaText: status === 'offline' ? '—' : fmtMin(destEta),
        nextEtaText: nextStop ? fmtMin(nextStop.etaMin) : '—',
        atStop: here ? here.name : null, lastUpdateSec: Math.round(age), lng: f.lng, lat: f.lat };
    },
  };
  window.Feed = Feed;
})();
