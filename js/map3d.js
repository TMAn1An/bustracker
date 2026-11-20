/*
 * Map3D — ডিপেন্ডেন্সি-ছাড়া ক্যানভাস 3D ম্যাপ।
 * পারসপেক্টিভ ক্যামেরা, এক্সট্রুডেড বিল্ডিং, 3D বাস, রুট হাইলাইট।
 * ড্র্যাগ = ঘোরানো, শিফট/ডান-ক্লিক-ড্র্যাগ বা দুই আঙুল = প্যান, হুইল/পিঞ্চ = জুম।
 */
(function () {
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function rng(seed) {
    let s = seed % 2147483647; if (s <= 0) s += 2147483646;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  }
  function shade(hex, f) { // f: 0..2 (1 = অপরিবর্তিত)
    const n = parseInt(hex.slice(1), 16);
    const c = i => clamp(Math.round(((n >> i) & 255) * f), 0, 255);
    return `rgb(${c(16)},${c(8)},${c(0)})`;
  }
  function segDist(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = clamp(((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
  }

  class Map3D {
    constructor(canvas, routes, opts = {}) {
      this.cv = canvas; this.ctx = canvas.getContext('2d');
      this.routes = routes; this.onSelect = opts.onSelect || (() => {});
      this.padBottom = 0; this.buses = []; this.selected = null; this.follow = true; this.hit = [];
      this.cam = { yaw: 0.55, pitch: 0.92, dist: 1250, tx: 0, ty: 0 };
      this.goal = { ...this.cam };
      this.t0 = performance.now();
      this.logo = new Image(); this.logo.src = opts.logo || '';
      this._build();
      this._bind();
      this._resize();
      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
      requestAnimationFrame(() => this._frame());
    }

    /* ---------- পাবলিক API ---------- */
    setBuses(list) { this.buses = list; }
    select(id) {
      this.selected = id; this.follow = !!id;
      if (!id) { this.goal.tx = 0; this.goal.ty = 0; }
    }
    setView(mode) { // '3d' | 'top'
      this.goal.pitch = mode === 'top' ? 1.5 : 0.92;
      return mode;
    }
    isTop() { return this.goal.pitch > 1.3; }
    rotate(d) { this.goal.yaw += d; }
    zoom(f) { this.goal.dist = clamp(this.goal.dist * f, 380, 2300); }
    recenter() {
      this.follow = true;
      if (!this.selected) { this.goal.tx = 0; this.goal.ty = 0; this.goal.dist = 1250; }
    }

    /* ---------- দুনিয়া তৈরি ---------- */
    _build() {
      const R = rng(7);
      this.segs = [];
      this.routes.forEach(r => {
        for (let i = 1; i < r.points.length; i++) this.segs.push([r.points[i - 1], r.points[i]]);
      });
      const nearRoad = (x, y, m) => this.segs.some(([a, b]) => segDist(x, y, a, b) < m);
      this.lake = [];
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * TAU, w = 1 + Math.sin(a * 3) * 0.08;
        this.lake.push({ x: 330 + Math.cos(a) * 150 * w, y: -480 + Math.sin(a) * 90 * w });
      }
      const inLake = (x, y) => ((x - 330) / 165) ** 2 + ((y + 480) / 105) ** 2 < 1;
      this.parks = [
        { x: -330, y: -430, w: 180, h: 120 }, { x: 260, y: 330, w: 150, h: 110 },
        { x: -120, y: 260, w: 120, h: 90 },
      ];
      const inPark = (x, y, m = 0) => this.parks.some(p => Math.abs(x - p.x) < p.w / 2 + m && Math.abs(y - p.y) < p.h / 2 + m);

      this.objs = [];
      const tones = ['#e3e8df', '#ece4d4', '#dbe3ec', '#efe0d8', '#e6e0ee', '#f1ead2'];
      for (let gx = -760; gx <= 760; gx += 46) {
        for (let gy = -700; gy <= 700; gy += 46) {
          const x = gx + (R() - 0.5) * 22, y = gy + (R() - 0.5) * 22;
          if (Math.hypot(x, y) < 120 || nearRoad(x, y, 46) || inLake(x, y) || inPark(x, y, 20)) continue;
          if (R() > 0.5) continue;
          const w = 16 + R() * 18, l = 16 + R() * 18;
          const dist = Math.hypot(x, y);
          const h = 8 + R() * (dist < 450 ? 52 : 30);
          this.objs.push({ type: 'building', x, y, w, l, h, rot: Math.round(R() * 3) * 0.2 - 0.2, c: tones[(R() * tones.length) | 0] });
        }
      }
      for (let i = 0; i < 260; i++) {
        const x = (R() - 0.5) * 1500, y = (R() - 0.5) * 1400;
        const park = inPark(x, y);
        if (!park && R() > 0.18) continue;
        if (nearRoad(x, y, 14) || inLake(x, y) || Math.hypot(x, y) < 100) continue;
        if (!park && this.objs.some(o => o.type === 'building' && Math.abs(o.x - x) < 26 && Math.abs(o.y - y) < 26)) continue;
        this.objs.push({ type: 'tree', x, y, h: 10 + R() * 8 });
      }
      // ক্যাম্পাস ভবন
      [
        { x: -8, y: 78, w: 64, l: 26, h: 40, c: '#0b7a1c', roof: '#075a14', rot: 0 },
        { x: 96, y: 76, w: 38, l: 30, h: 28, c: '#f4ecd0', roof: '#e2231a', rot: 0 },
        { x: 70, y: -92, w: 44, l: 26, h: 24, c: '#ffd500', roof: '#c9a800', rot: 0 },
        { x: -92, y: -22, w: 22, l: 40, h: 20, c: '#f4ecd0', roof: '#0b7a1c', rot: 0 },
      ].forEach(b => this.objs.push({ type: 'building', campus: true, ...b }));
    }

    /* ---------- প্রজেকশন ---------- */
    _p(x, y, z = 0) {
      const c = this.cam, dx = x - c.tx, dy = y - c.ty;
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
      const rx = dx * cy - dy * sy, ry = dx * sy + dy * cy;
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const up = z * cp + ry * sp;
      const depth = Math.max(40, ry * cp - z * sp + c.dist);
      const s = this.f / depth;
      return { x: this.W / 2 + rx * s, y: (this.H - this.padBottom) * 0.56 - up * s, d: depth, s };
    }

    _resize() {
      const p = this.cv.parentElement, dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.W = p.clientWidth; this.H = p.clientHeight;
      this.cv.width = this.W * dpr; this.cv.height = this.H * dpr;
      this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
      this.dpr = dpr; this.f = Math.max(this.H, this.W * 0.7) * 1.05;
    }

    /* ---------- ইনপুট ---------- */
    _bind() {
      const cv = this.cv, ptrs = new Map();
      let moved = 0, pinch = 0;
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey });
        moved = 0; pinch = 0;
      });
      cv.addEventListener('pointermove', e => {
        const p = ptrs.get(e.pointerId);
        if (!p) { this._hover(e); return; }
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        moved += Math.abs(dx) + Math.abs(dy);
        if (ptrs.size === 2) {
          const [a, b] = [...ptrs.values()];
          const dNow = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch) this.zoom(pinch / dNow);
          pinch = dNow;
          p.x = e.clientX; p.y = e.clientY;
          this._pan(dx / 2, dy / 2);
          return;
        }
        p.x = e.clientX; p.y = e.clientY;
        if (p.b === 2 || p.shift) this._pan(dx, dy);
        else {
          this.goal.yaw -= dx * 0.006;
          this.goal.pitch = clamp(this.goal.pitch + dy * 0.004, 0.5, 1.5);
        }
      });
      const up = e => {
        const was = ptrs.get(e.pointerId);
        ptrs.delete(e.pointerId); pinch = 0;
        if (was && moved < 6 && e.type === 'pointerup') this._click(e);
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('wheel', e => {
        e.preventDefault(); this.zoom(Math.exp(e.deltaY * 0.0012));
      }, { passive: false });
    }
    _pan(dx, dy) {
      this.follow = false;
      const g = this.goal, u = g.dist / this.f;
      const cp = Math.sin(g.pitch) || 1;
      const rx = -dx * u, ry = dy * u / cp;
      const cy = Math.cos(g.yaw), sy = Math.sin(g.yaw);
      g.tx += rx * cy + ry * sy; g.ty += -rx * sy + ry * cy;
      g.tx = clamp(g.tx, -900, 900); g.ty = clamp(g.ty, -900, 900);
    }
    _pick(e) {
      const r = this.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 34;
      this.hit.forEach(h => { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.id; } });
      return best;
    }
    _hover(e) { this.cv.style.cursor = this._pick(e) ? 'pointer' : 'grab'; }
    _click(e) { const id = this._pick(e); if (id) this.onSelect(id); }

    /* ---------- রেন্ডার ---------- */
    _frame() {
      const c = this.cam, g = this.goal, k = 0.12;
      const sel = this.buses.find(b => b.id === this.selected);
      if (sel && this.follow) { g.tx = sel.x; g.ty = sel.y; }
      c.tx += (g.tx - c.tx) * k; c.ty += (g.ty - c.ty) * k;
      c.yaw += (g.yaw - c.yaw) * k; c.pitch += (g.pitch - c.pitch) * k;
      c.dist += (g.dist - c.dist) * k;
      this._draw((performance.now() - this.t0) / 1000);
      requestAnimationFrame(() => this._frame());
    }

    _poly(pts, fill, stroke, lw) {
      const ctx = this.ctx; ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
    }

    _draw(t) {
      const ctx = this.ctx, W = this.W, H = this.H;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      // আকাশ
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#cfe6dd'); sky.addColorStop(0.45, '#e8f1e2'); sky.addColorStop(1, '#e8f1e2');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

      // মাটি
      const E = 1000;
      const gcorners = [[-E, -E], [E, -E], [E, E], [-E, E]].map(([x, y]) => this._p(x, y, 0));
      this._poly(gcorners, '#f0f4ea', 'rgba(11,122,28,.25)', 2);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(11,122,28,.07)';
      for (let v = -E; v <= E; v += 100) {
        let a = this._p(v, -E), b = this._p(v, E);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        a = this._p(-E, v); b = this._p(E, v);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // পার্ক, লেক
      this.parks.forEach(p => this._poly([
        this._p(p.x - p.w / 2, p.y - p.h / 2), this._p(p.x + p.w / 2, p.y - p.h / 2),
        this._p(p.x + p.w / 2, p.y + p.h / 2), this._p(p.x - p.w / 2, p.y + p.h / 2)], '#d5ebc8'));
      this._poly(this.lake.map(q => this._p(q.x, q.y)), '#b9dcee', '#9ccbe3', 2);
      // ক্যাম্পাস প্রাঙ্গণ
      const cb = [[-120, -120], [120, -120], [120, 120], [-120, 120]].map(([x, y]) => this._p(x, y));
      this._poly(cb, '#e1f0d6', 'rgba(11,122,28,.45)', 2);

      // রাস্তা
      this._roads(t);
      // স্টপ
      this._stops();

      // ৩D অবজেক্ট (পেছন থেকে সামনে)
      const list = [];
      this.objs.forEach(o => list.push({ d: this._p(o.x, o.y, 0).d, o }));
      this.buses.forEach(b => list.push({ d: this._p(b.x, b.y, 0).d - 0.5, bus: b }));
      list.push({ d: this._p(0, 0, 0).d, sign: true });
      list.sort((a, b) => b.d - a.d);
      list.forEach(it => {
        if (it.bus) this._bus(it.bus, t);
        else if (it.sign) this._sign();
        else if (it.o.type === 'building') this._building(it.o);
        else this._tree(it.o);
      });

      // লেবেল (সবার উপরে)
      this.hit = [];
      const bl = this.buses.map(b => ({ b, p: this._p(b.x, b.y, 22) })).sort((a, b) => b.p.d - a.p.d);
      this._stopLabels();
      bl.forEach(({ b, p }) => this._busLabel(b, p, t));
    }

    _roads(t) {
      const ctx = this.ctx;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const stroke = (r, w, col, dash) => {
        ctx.setLineDash(dash || []);
        for (let i = 1; i < r.points.length; i++) {
          const a = r.points[i - 1], b = r.points[i];
          const pa = this._p(a.x, a.y), pb = this._p(b.x, b.y);
          const s = (pa.s + pb.s) / 2;
          ctx.lineWidth = Math.max(1, w * s); ctx.strokeStyle = col;
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        }
      };
      this.routes.forEach(r => stroke(r, 17, '#c9d1c4'));
      this.routes.forEach(r => stroke(r, 13, '#fbfcf8'));
      const sel = this.buses.find(b => b.id === this.selected);
      this.routes.forEach(r => {
        const on = sel && sel.routeName === r.name;
        if (on) {
          stroke(r, 9, r.color + 'cc');
          ctx.setLineDash([]);
          const s0 = this._p(0, 0).s;
          ctx.lineDashOffset = -t * 40 * s0;
          stroke(r, 2.4, '#ffffff', [10 * s0, 12 * s0]);
          ctx.lineDashOffset = 0;
        }
      });
      ctx.setLineDash([]);
      // ক্যাম্পাস প্লাজা
      const pc = this._p(0, 0);
      ctx.beginPath(); ctx.ellipse(pc.x, pc.y, 30 * pc.s, 30 * pc.s * Math.sin(this.cam.pitch), 0, 0, TAU);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#0b7a1c'; ctx.lineWidth = 3 * pc.s; ctx.stroke();
    }

    _stops() {
      const ctx = this.ctx, sel = this.buses.find(b => b.id === this.selected);
      this.routes.forEach(r => {
        const on = sel && sel.routeName === r.name;
        r.stops.forEach(s => {
          if (s.name.startsWith('IUBAT')) return;
          const p = this._p(s.x, s.y);
          const rad = (on ? 8 : 5.5) * p.s;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, rad, rad * Math.max(0.45, Math.sin(this.cam.pitch)), 0, 0, TAU);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = Math.max(2, 3 * p.s); ctx.strokeStyle = r.color; ctx.stroke();
        });
      });
    }

    _stopLabels() {
      const sel = this.buses.find(b => b.id === this.selected);
      if (!sel) return;
      const r = this.routes.find(q => q.name === sel.routeName);
      r.stops.forEach(s => {
        const p = this._p(s.x, s.y, 3);
        this._pill(s.name, p.x, p.y - 12, { size: 11.5, bg: '#fff', fg: '#14201a', border: r.color });
      });
    }

    _pill(text, x, y, o = {}) {
      const ctx = this.ctx, size = o.size || 12;
      ctx.font = `${o.weight || 600} ${size}px "Hind Siliguri","Noto Sans Bengali",system-ui,sans-serif`;
      const w = ctx.measureText(text).width + (o.padX ?? 10) * 2, h = size + 9;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h, w, h, h / 2);
      ctx.fillStyle = o.bg || '#fff'; ctx.fill();
      ctx.lineWidth = o.bw || 1.5; ctx.strokeStyle = o.border || 'rgba(0,0,0,.18)'; ctx.stroke();
      ctx.fillStyle = o.fg || '#14201a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y - h / 2 + 0.5);
      return { w, h };
    }

    _box(cx, cy, z0, hx, hy, h, ang, top, side, onSide) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const loc = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const lx = a * hx, ly = b * hy;
        return [cx + lx * ca - ly * sa, cy + lx * sa + ly * ca];
      });
      const bot = loc.map(([x, y]) => this._p(x, y, z0));
      const tp = loc.map(([x, y]) => this._p(x, y, z0 + h));
      const faces = [0, 1, 2, 3].map(i => {
        const j = (i + 1) % 4;
        const mid = (bot[i].d + bot[j].d) / 2;
        // আলোর দিক: ওয়ার্ল্ডে নির্দিষ্ট
        const nx = (loc[i][1] - loc[j][1]), ny = (loc[j][0] - loc[i][0]);
        const l = Math.hypot(nx, ny) || 1;
        const lit = 0.78 + 0.28 * ((nx / l) * -0.5 + (ny / l) * 0.6);
        return { i, j, d: mid, lit };
      }).sort((a, b) => b.d - a.d);
      const ctx = this.ctx;
      faces.forEach(f => {
        const q = [bot[f.i], bot[f.j], tp[f.j], tp[f.i]];
        // শুধু ক্যামেরামুখী ফেস: স্ক্রিন-স্পেস ওয়াইন্ডিং
        const area = (q[1].x - q[0].x) * (q[2].y - q[0].y) - (q[1].y - q[0].y) * (q[2].x - q[0].x);
        if (area > 0) return;
        this._poly(q, shade(side, f.lit), 'rgba(0,0,0,.12)', 0.8);
        if (onSide) onSide(q, f);
      });
      this._poly(tp, top, 'rgba(0,0,0,.12)', 0.8);
      return { bot, tp };
    }

    _building(o) {
      const side = o.c, top = o.roof || shade(o.c, 1.07);
      const r = this._box(o.x, o.y, 0, o.w / 2, o.l / 2, o.h, o.rot || 0, top, side, o.campus ? (q) => {
        // জানালা সারি
        const ctx = this.ctx;
        for (let k = 1; k <= Math.floor(o.h / 12); k++) {
          const v = k * 12 / o.h;
          if (v > 0.85) break;
          const a = lerp2(q[0], q[3], v), b = lerp2(q[1], q[2], v);
          const a2 = lerp2(q[0], q[3], v + 0.09), b2 = lerp2(q[1], q[2], v + 0.09);
          this._poly([lerp2(a, b, 0.1), lerp2(a, b, 0.9), lerp2(a2, b2, 0.9), lerp2(a2, b2, 0.1)], 'rgba(255,255,255,.55)');
        }
      } : null);
    }

    _tree(o) {
      const ctx = this.ctx, b = this._p(o.x, o.y, 0), t = this._p(o.x, o.y, o.h);
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = '#8a6a3b'; ctx.lineWidth = Math.max(1, 1.6 * b.s); ctx.stroke();
      const r = 6.5 * b.s;
      ctx.beginPath(); ctx.arc(t.x, t.y - r * 0.2, r, 0, TAU);
      ctx.fillStyle = '#58b05a'; ctx.fill();
      ctx.beginPath(); ctx.arc(t.x - r * .25, t.y - r * .45, r * .6, 0, TAU);
      ctx.fillStyle = '#74c476'; ctx.fill();
    }

    _sign() {
      // ক্যাম্পাসের লোগো-সাইন
      const ctx = this.ctx, b = this._p(0, 0, 0), t = this._p(0, 0, 54);
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = '#14201a'; ctx.lineWidth = Math.max(2, 2.4 * b.s); ctx.stroke();
      const sz = 44 * t.s;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0b7a1c'; ctx.lineWidth = Math.max(2, 2.5 * t.s);
      ctx.beginPath(); ctx.roundRect(t.x - sz * .62, t.y - sz * 1.2, sz * 1.24, sz * 1.1, 6 * t.s); ctx.fill(); ctx.stroke();
      if (this.logo.complete && this.logo.naturalWidth) {
        const iw = sz * 1.05, ih = iw * (this.logo.naturalHeight / this.logo.naturalWidth);
        ctx.drawImage(this.logo, t.x - iw / 2, t.y - sz * 0.65 - ih / 2, iw, ih);
      }
    }

    _bus(b, t) {
      const ctx = this.ctx, L = 20, Wd = 8, Hh = 10; // অর্ধ-দৈর্ঘ্য/প্রস্থ — স্পষ্টতার জন্য বড় করা
      const off = b.status === 'offline';
      const body = off ? '#b9bfb6' : '#f7c600';
      // ছায়া
      const sh = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => {
        const lx = a * (L + 2), ly = c * (Wd + 2), ca = Math.cos(b.heading), sa = Math.sin(b.heading);
        return this._p(b.x + lx * ca - ly * sa + 3, b.y + lx * sa + ly * ca - 3, 0);
      });
      this._poly(sh, 'rgba(20,32,26,.22)');
      // সিলেক্টেড রিং
      if (b.id === this.selected) {
        const p = this._p(b.x, b.y, 0), pulse = (t % 1.6) / 1.6, rad = (26 + pulse * 22) * p.s;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, rad, rad * Math.max(.45, Math.sin(this.cam.pitch)), 0, 0, TAU);
        ctx.strokeStyle = b.color; ctx.globalAlpha = 1 - pulse; ctx.lineWidth = 3; ctx.stroke(); ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 24 * p.s, 24 * p.s * Math.max(.45, Math.sin(this.cam.pitch)), 0, 0, TAU);
        ctx.fillStyle = b.color + '33'; ctx.fill();
      }
      // চাকা
      const wheelAt = (lx, ly) => {
        const ca = Math.cos(b.heading), sa = Math.sin(b.heading);
        const p = this._p(b.x + lx * ca - ly * sa, b.y + lx * sa + ly * ca, 1.8);
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.6 * p.s, 0, TAU); ctx.fillStyle = '#1b1f1c'; ctx.fill();
      };
      // বডি
      this._box(b.x, b.y, 2, L, Wd, Hh, b.heading, shade(body, 1.08), body, (q, f) => {
        const a = lerp2(q[0], q[3], 0.52), c = lerp2(q[1], q[2], 0.52);
        const a2 = lerp2(q[0], q[3], 0.86), c2 = lerp2(q[1], q[2], 0.86);
        this._poly([lerp2(a, c, 0.06), lerp2(a, c, 0.94), lerp2(a2, c2, 0.94), lerp2(a2, c2, 0.06)],
          off ? '#8d948b' : '#27405e');
        const s0 = lerp2(q[0], q[3], 0.18), s1 = lerp2(q[1], q[2], 0.18);
        const s2 = lerp2(q[0], q[3], 0.28), s3 = lerp2(q[1], q[2], 0.28);
        this._poly([s0, s1, s3, s2], off ? '#8d948b' : '#14201a');
      });
      const ca = Math.cos(b.heading), sa = Math.sin(b.heading);
      // সামনের লাইট
      [-1, 1].forEach(sd => {
        const p = this._p(b.x + L * ca - sd * Wd * .6 * -sa, b.y + L * sa + sd * Wd * .6 * ca, 4.5);
        if (!off) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.4 * p.s, 0, TAU); ctx.fillStyle = '#fffbe0'; ctx.fill(); }
      });
    }

    _busLabel(b, p, t) {
      const sel = b.id === this.selected, off = b.status === 'offline';
      const size = sel ? 17 : 14;
      const y = p.y - 8;
      const ctx = this.ctx;
      // পিন-লেজ
      ctx.beginPath(); ctx.moveTo(p.x - 5, y); ctx.lineTo(p.x + 5, y); ctx.lineTo(p.x, y + 8); ctx.closePath();
      ctx.fillStyle = off ? '#9aa196' : '#14201a'; ctx.fill();
      const m = this._pill(off ? b.id + ' ✕' : b.id, p.x, y + 1, {
        size, weight: 800, padX: sel ? 13 : 10, bg: off ? '#d8dcd3' : '#ffd500', fg: '#14201a',
        border: sel ? b.color : '#14201a', bw: sel ? 3 : 2,
      });
      this.hit.push({ id: b.id, x: p.x, y: y + 8 - m.h / 2 });
    }
  }

  function lerp2(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, d: a.d + (b.d - a.d) * t, s: a.s }; }

  window.Map3D = Map3D;
})();
