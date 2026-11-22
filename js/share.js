/*
 * Share: lets a student on the bus share their phone's location for that bus (crowd mode).
 * The server verifies every fix (on the route, moving like a vehicle, no jumps) before it is shown to others.
 */
(function () {
  const NATIVE = window.AndroidBridge || null; // set by the IUBAT Bus Android app
  const SEND_MS = 10000; // every 10 s: enough for the map (the app fills the gaps) and kind to the free hosting quota
  const Share = {
    busId: null, status: null, message: '', error: null, xp: 0, thanks: 0, onChange: () => {}, onXp: () => {},
    watch: null, wake: null, pending: null, lastPos: null, timer: null, last: 0, token: null, startedAt: 0, gpsIssue: null, progress: null, probing: false,
    /** For the share bar: "GPS ±12 m · 3 s ago" (null before the first fix) */
    get gps() { const p = this.lastPos; return p ? { acc: Math.round(p.coords.accuracy), age: Math.max(0, Math.round((Date.now() - p.timestamp) / 1000)) } : null; },

    get active() { return NATIVE ? !!this.nativeOn : this.watch !== null; },
    /** Inside the Android app the phone shares from a background service (works with the screen off). */
    native: !!NATIVE, nativeOn: false,

    start(busId, token) {
      if (NATIVE) { // the app asks for permissions, starts the background service and reports back through _native()
        this.busId = busId; this.token = token; this.status = 'starting'; this.message = 'Starting…'; this.error = null; this.xp = 0; this.thanks = 0; this.lastPos = null;
        this.nativeOn = true; this.onChange(this);
        try { NATIVE.startShare(String(busId), token, location.origin); } catch (e) { this.nativeOn = false; this._set(null, 'Could not start sharing: ' + e.message, true); }
        return;
      }
      if (!('geolocation' in navigator)) { this._set(null, 'Location is not available on this device.', true); return; }
      this.stop(true);
      this.busId = busId; this.token = token; this.status = 'starting'; this.message = 'Getting your location…'; this.error = null; this.xp = 0; this.thanks = 0;
      this.lastPos = null; this.startedAt = Date.now(); this.gpsIssue = null; this.progress = null;
      // GPS can take 30-60 s to get its first fix inside a moving bus: keep watching, and tell the rider exactly what is wrong.
      this.watch = navigator.geolocation.watchPosition(p => {
        this.pending = p; this.lastPos = p; this.gpsIssue = null;
        if (this.status === 'starting' || this.status === 'no_gps') this._set('starting', p.coords.accuracy > 100 ? this._coarse(p) : 'GPS found. Checking that you are on the bus…');
        this._flush();
      }, e => {
        if (e.code === 1) { this.stop(); this._set(null, 'Location permission is blocked for this site. Tap the 🔒 next to the address → Permissions → Location → Allow, then try again.', true); return; }
        if (e.code === 2) { this.gpsIssue = 'off'; this._set('no_gps', 'Your phone\'s Location is off or unavailable. Turn on Location (GPS) in quick settings; sharing starts by itself.'); return; }
        this.gpsIssue = 'slow'; this._probe();
        if (!this.lastPos) this._set('no_gps', `Still looking for GPS (${Math.round((Date.now() - this.startedAt) / 1000)} s)… Keep the screen on, near a window.`);
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
      this.timer = setInterval(() => { this._flush(); if (!this.lastPos && Date.now() - this.startedAt > 15000) this._probe(); }, 1000);
      this._lock();
      // Phones pause GPS and timers while the browser is in the background: when the rider comes back, send at once and say so.
      document.addEventListener('visibilitychange', this._vis = () => {
        if (!this.active) return;
        if (document.visibilityState === 'hidden') { this.hiddenAt = Date.now(); return; }
        this._lock();
        const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0; this.hiddenAt = 0;
        if (away > 15000) this._set(this.status, `Sharing paused for ${Math.round(away / 1000)} s while the app was in the background. Sending again now.`);
        this.last = 0; this._flush();
      });
      this.onChange(this);
    },

    async stop(silent) {
      if (NATIVE) {
        if (this.nativeOn) try { NATIVE.stopShare(); } catch {}
        this.nativeOn = false; this.lastPos = null;
        if (!silent) { this.busId = null; this.status = null; this.message = ''; this.onChange(this); }
        return;
      }
      const was = this.active, bus = this.busId, token = this.token;
      if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
      this.watch = null; clearInterval(this.timer); this.pending = null; this.lastPos = null;
      try { this.wake && this.wake.release(); } catch {} this.wake = null;
      if (this._vis) document.removeEventListener('visibilitychange', this._vis);
      if (was && token) fetch('api/share', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'stop', busId: bus }) }).catch(() => {});
      if (!silent) { this.busId = null; this.status = null; this.message = ''; this.onChange(this); }
    },

    /** No precise fix yet: ask once for any location, to tell "Location off" from "only approximate location" from "slow GPS". */
    _probe() {
      if (this.probing || this.lastPos || !this.active) return; this.probing = true;
      navigator.geolocation.getCurrentPosition(p => {
        this.probing = false; if (this.lastPos || !this.active) return;
        this._set('no_gps', p.coords.accuracy > 100 ? this._coarse(p) : 'GPS is warming up… keep the screen on, near a window.');
      }, e => {
        this.probing = false; if (this.lastPos || !this.active) return;
        if (e.code === 2) { this.gpsIssue = 'off'; this._set('no_gps', 'Your phone\'s Location is off. Turn on Location (GPS) in quick settings; sharing starts by itself.'); }
      }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 });
    },
    _coarse(p) { return `Your phone only gives an approximate location (±${Math.round(p.coords.accuracy)} m). Turn on precise location: phone Settings → Apps → your browser → Permissions → Location → "Use precise location".`; },
    async _lock() { try { if ('wakeLock' in navigator) this.wake = await navigator.wakeLock.request('screen'); } catch {} },
    /** State pushed by the Android app's background service: {active, busId, status, message, error, xp, thanks, progress, lat, lng, acc, speed, fixAt, sentAt} */
    _native(s) {
      if (typeof s === 'string') try { s = JSON.parse(s); } catch { return; }
      if (!s) return;
      const was = this.nativeOn;
      this.nativeOn = !!s.active;
      if (s.busId) this.busId = s.busId;
      if (s.xp != null && s.xp > this.xp) { const gain = s.xp - this.xp; this.xp = s.xp; if (was) this.onXp(gain, s.xp); }
      if (s.thanks != null) this.thanks = s.thanks;
      this.progress = s.progress ?? null; this.last = s.sentAt || 0;
      this.lastPos = s.lat != null ? { coords: { latitude: s.lat, longitude: s.lng, accuracy: s.acc ?? 0, speed: s.speed ?? null, heading: null }, timestamp: s.fixAt || Date.now() } : null;
      if (this.nativeOn && s.status === 'verified' && s.lat != null && window.Feed && s.sentAt !== this._ingested) {
        this._ingested = s.sentAt;
        Feed.ingest({ id: this.busId, lat: s.lat, lng: s.lng, speed: s.speed ?? null, heading: null, ts: Date.now() + Feed.offset - 3000, source: 'crowd' });
      }
      if (!this.nativeOn && !s.message) { this.busId = null; this.status = null; this.message = ''; this.error = null; return this.onChange(this); }
      this.status = this.nativeOn ? s.status || 'starting' : null; this.message = s.message || ''; this.error = !!s.error;
      this.onChange(this);
    },
    _set(status, message, isError) { this.status = status; this.message = message; this.error = !!isError; this.onChange(this); },

    async _flush() {
      // A phone that is not moving gets no new GPS events, so re-send the last position:
      // the server needs it to show a bus waiting in traffic and to notice a rider who got off.
      const pos = this.pending || this.lastPos, fresh = !!this.pending;
      if (!pos || Date.now() - this.last < SEND_MS) return;
      const { coords: c } = pos; this.pending = null; this.last = Date.now();
      // No new GPS event since the last send = the phone (bus) is standing still: send speed 0, never the old speed,
      // or the map would keep pushing the bus forward in a traffic jam.
      const speed = fresh ? (c.speed ?? undefined) : 0;
      try {
        const res = await fetch('api/share', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + this.token },
          body: JSON.stringify({ busId: this.busId, lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed, heading: c.heading ?? undefined }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { this.stop(); this._set(null, j.error || 'Sharing stopped.', true); return; }
        if (j.xp != null && j.xp > this.xp) { const gain = j.xp - this.xp; this.xp = j.xp; this.onXp(gain, j.xp); }
        if (j.thanks != null) this.thanks = j.thanks;
        this.progress = j.status === 'checking' && j.progress != null ? j.progress : null;
        if (j.status === 'arrived') { await this.stop(true); this.busId = null; this._set(null, `${j.message}${this.xp ? ` You earned ${this.xp} XP on this ride.` : ''}`); return; }
        if (j.status === 'verified' && window.Feed) { // your fix is now the bus's position: show it at once instead of waiting for the next poll
          Feed.ingest({ id: this.busId, lat: c.latitude, lng: c.longitude, speed: j.speed ?? speed ?? null, heading: c.heading ?? null, ts: Date.now() + Feed.offset - 3000, source: 'crowd' });
          Feed.poll();
        }
        this._set(j.status, j.message);
      } catch { this._set(this.status, 'Network problem, retrying…'); }
    },
  };
  window.Share = Share;
  // The app was reopened while its background service is still sharing: pick up where it is.
  if (NATIVE) try { const s = JSON.parse(NATIVE.state() || 'null'); if (s && s.active) setTimeout(() => Share._native(s), 0); } catch {}
})();
