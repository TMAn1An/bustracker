/*
 * Feed: polls bus positions every 4 s, matches them to the route to work out
 * direction (inbound/outbound), progress and ETA, and gives the map smooth positions.
 */
(function () {
  const POLL_MS = 4000, OFFLINE_S = 60, STOP_R = 60, MOVING = 1.0; // m/s
  const rad = Math.PI / 180;
  let lat0 = 23.8882, lng0 = 90.3906, kx = 111320 * Math.cos(lat0 * rad), ky = 110574;
  const xy = (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky];
  const ll = (x, y) => [lng0 + x / kx, lat0 + y / ky];
  const fmtMin = m => (m < 1 ? 'Now' : Math.ceil(m) + ' min');
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

  function prep(r, campus) {
    r.stops = [...r.stops, { name: campus.name, lat: campus.lat, lng: campus.lng }].map(x => ({ ...x }));
    r.xy = r.geometry.map(([lng, lat]) => xy(lng, lat));
    r.cum = [0];
    for (let i = 1; i < r.xy.length; i++) r.cum.push(r.cum[i - 1] + Math.hypot(r.xy[i][0] - r.xy[i - 1][0], r.xy[i][1] - r.xy[i - 1][1]));
    r.length = r.cum[r.cum.length - 1];
    r.stops.forEach(s => { s.s = project(r, ...xy(s.lng, s.lat)).s; });
    r.stops.sort((a, b) => a.s - b.s);
  }
  // Project a point onto the nearest part of the route: { s (metres), dist, x, y, bearing }
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
    campus: null, routes: [], notices: [], rev: null, offset: 0, ok: true, onAuthFail: () => {}, onStatus: () => {}, onRoutes: () => {},
    state: new Map(), token: null, timer: null,

    /** Load routes and bus->route assignment (needs a signed-in token). Safe to call again when `rev` changes. */
    async load(token) {
      const res = await fetch('api/routes', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (res.status === 401) throw Object.assign(new Error('auth'), { auth: true });
      const j = await res.json();
      this.campus = j.campus; this.rev = j.rev; lat0 = j.campus.lat; lng0 = j.campus.lng; kx = 111320 * Math.cos(lat0 * rad);
      const routes = j.routes.filter(r => r.geometry.length > 1);
      routes.forEach(r => prep(r, j.campus));
      this.routes = routes;
      const old = this.state, next = new Map();
      j.buses.forEach(b => {
        const r = routes.find(x => x.id === b.routeId) || null, prev = old.get(b.id);
        next.set(b.id, { id: b.id, r, fix: prev?.fix || null, dir: prev?.dir ?? 1, ema: prev?.ema ?? 22 / 3.6, disp: prev?.disp || null, routeChanged: prev && prev.r !== r });
        const st = next.get(b.id);
        st.schedule = { departStart: b.departStart, departCampus: b.departCampus, days: b.days };
        if (st.routeChanged && st.fix) { st.fix = null; st.disp = null; } // re-match on the next fix
      });
      this.state = next;
      this.notices = (j.notices || []).map(n => ({ ...n, expiresLocal: n.expiresAt ? n.expiresAt - (j.now - Date.now()) : null }));
      this.onRoutes(this);
    },

    async login(id, password) {
      let res;
      try { res = await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password }) }); }
      catch { throw new Error('Cannot reach the server. Check your internet connection.'); }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Sign-in failed.');
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
        if (j.rev !== this.rev) await this.load(this.token); // admin changed routes/buses
        j.buses.forEach(f => this.ingest(f));
        if (!this.ok) { this.ok = true; this.onStatus(true); }
      } catch (e) { if (e.auth) { this.stop(); return this.onAuthFail(); } if (this.ok) { this.ok = false; this.onStatus(false); } }
    },

    ingest(f) {
      const st = this.state.get(String(f.id)); if (!st) return;
      if (st.fix && f.ts <= st.fix.ts) return;
      if (!st.r) { // bus has no route assigned yet: show raw position only
        st.fix = { ...f, s: 0, off: 0, tLng: f.lng, tLat: f.lat, tHead: f.heading ?? 0 };
        if (!st.disp) st.disp = { lng: f.lng, lat: f.lat, heading: st.fix.tHead };
        return;
      }
      const p = xy(f.lng, f.lat), pr = project(st.r, p[0], p[1]);
      // direction: use GPS heading when moving, otherwise compare with the previous position along the route
      if (f.speed > MOVING && f.heading != null) st.dir = Math.abs(angDiff(f.heading, pr.bearing)) < 90 ? 1 : -1;
      else if (st.fix && Math.abs(pr.s - st.fix.s) > 15) st.dir = pr.s > st.fix.s ? 1 : -1;
      if (f.speed > 1.5) st.ema += (f.speed - st.ema) * 0.2;
      const onRoad = pr.dist < 50;
      const [lng, lat] = onRoad ? ll(pr.x, pr.y) : [f.lng, f.lat];
      st.fix = { ...f, s: pr.s, off: pr.dist, tLng: lng, tLat: lat, tHead: onRoad ? (st.dir > 0 ? pr.bearing : (pr.bearing + 180) % 360) : (f.heading ?? 0) };
      if (!st.disp) st.disp = { lng, lat, heading: st.fix.tHead };
    },

    /** Call every frame: smoothed positions */
    positions(dt) {
      const k = 1 - Math.exp(-dt / 0.9), out = [];
      this.state.forEach((st, id) => {
        if (!st.fix || !st.disp) return;
        const d = st.disp, f = st.fix;
        d.lng += (f.tLng - d.lng) * k; d.lat += (f.tLat - d.lat) * k;
        d.heading = (d.heading + angDiff(f.tHead, d.heading) * k + 360) % 360;
        out.push({ id, lng: d.lng, lat: d.lat, heading: d.heading, color: st.r ? st.r.color : '#6b766f', routeId: st.r ? st.r.id : null, status: this._status(st) });
      });
      return out;
    },

    _age(st) { return st.fix ? Math.max(0, (Date.now() + this.offset - st.fix.ts) / 1000) : Infinity; },
    _status(st) {
      if (!st.fix || this._age(st) > OFFLINE_S) return 'offline';
      return st.fix.speed != null && st.fix.speed < MOVING ? 'stopped' : 'running';
    },

    /** Full info for the UI (called once a second) */
    snapshot() { return [...this.state.values()].map(st => ({ ...this._describe(st), routeId: st.r ? st.r.id : null, schedule: st.schedule })); },
    activeNotices() { const now = Date.now(); return this.notices.filter(n => !n.expiresLocal || n.expiresLocal > now); },
    busList() { return [...this.state.keys()]; },

    _describe(st) {
      const r = st.r, f = st.fix, status = this._status(st);
      if (!r) return { id: st.id, routeName: 'No route assigned', color: '#6b766f', status, noRoute: true, from: '—', to: '—', toCampus: true, speedKmh: f ? Math.round((f.speed || 0) * 3.6) : 0,
        progress: 0, nextStop: null, destEta: 0, destEtaText: '—', nextEtaText: '—', atStop: null, stops: [], noData: !f,
        lastUpdateSec: f ? Math.round(this._age(st)) : null, lng: f?.lng, lat: f?.lat };
      const travel = st.dir > 0 ? r.stops : r.stops.slice().reverse();
      const from = travel[0].name, to = travel[travel.length - 1].name;
      const base = { id: st.id, routeId: r.id, routeName: r.name, color: r.color, status, from, to,
        toCampus: st.dir > 0, inbound: st.dir > 0, speedKmh: 0, progress: 0, nextStop: null, destEta: 0, destEtaText: '—',
        nextEtaText: '—', atStop: null, lastUpdateSec: null,
        stops: travel.map(s => ({ name: s.name, state: 'upcoming', etaMin: 0 })) };
      if (!f) return { ...base, noData: true };

      const s = f.s, age = this._age(st);
      const v = Math.max(15 / 3.6, Math.min(40 / 3.6, st.ema)); // ETA speed clamped to 15-40 km/h
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
