(function () {
  const $ = s => document.querySelector(s);
  const local = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = Social;
  const STATUS = { running: 'Running', stopped: 'Stopped', offline: 'Offline', estimated: 'Estimated' };
  const isMobile = () => matchMedia('(max-width: 860px)').matches;
  const ICON_BUS = '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r=".6" fill="currentColor"/><circle cx="15.5" cy="14.5" r=".6" fill="currentColor"/></svg>';
  const ICON_BACK = '<svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
  const ICON_CHEV = '<svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  const ICON_CLOCK = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const REMIND_MIN = 20;
  // Small line icons for headings and labels (emoji stay for the fun parts: badges, treats, achievements)
  const REPO = 'https://github.com/TMAn1An/bustracker';
  const IC = {
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z"/>',
    crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    cup: '<path d="M4 8h13v5a6 6 0 0 1-12 0z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17M8 2v3M12 2v3"/>',
    swords: '<path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 6.5L14 2h3v3l-4.5 4.5M5 14l-2 2 3 3 2-2"/>',
    medal: '<circle cx="12" cy="15" r="6"/><path d="M8.5 10.5L6 2h4l2 5 2-5h4l-2.5 8.5"/>',
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-11 6"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  };
  const ico = n => `<svg class="i" viewBox="0 0 24 24">${IC[n]}</svg>`;
  const rankBadge = i => `<span class="rk rk${i < 3 ? i + 1 : 'n'}">${i + 1}</span>`;

  // view: home | route {routeId, busId} | notices | board | me | user {userId}
  let map = null, view = { name: 'home' }, snap = [], seenNotices = new Set(local.get('iubat_seen_notices') || []), knownNotices = null;
  let myRoute = S.me?.routeId || local.get('iubat_myroute') || null;
  const myStops = local.get('iubat_mystop') || {};           // routeId -> stop name (for the morning reminder)
  let remind = !!local.get('iubat_remind');
  let boardTab = 'week', boardRoute = null;
  const P = S.Push; P.route = myRoute; P.stop = myRoute ? myStops[myRoute] || null : null;
  const pushOn = () => P.prefs.on && 'Notification' in window && Notification.permission === 'granted';

  /* ================= start: no sign-in, the app opens straight away ================= */
  async function start() {
    renderMe();
    try { await Feed.load(); }
    catch { $('#panelBody').innerHTML = '<p class="muted-p">Cannot reach the server. Check your internet connection; retrying…</p>'; return setTimeout(start, 5000); }
    boot(); Feed.start(); map.resize();
    S.refresh(); loadBoard();
    const m = /#restore=([\w-]+)/.exec(location.hash);
    if (m) { history.replaceState(null, '', location.pathname); openRestore(m[1]); }
    else openHash(location.hash);
    // a tapped push notification opens its screen (#route=…, #me, #board)
    navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open') openHash(new URL(e.data.url).hash); });
    // links opened while the app is already open (restore link, #route=…)
    addEventListener('hashchange', () => {
      const k = /#restore=([\w-]+)/.exec(location.hash);
      if (k) { history.replaceState(null, '', location.pathname); openRestore(k[1]); } else openHash(location.hash);
    });
    P.sync(false).catch(() => {}); // keep the server's copy of my route / stop up to date
  }
  function openHash(h) {
    const r = /^#route=([\w-]+)/.exec(h || '');
    if (r && Feed.routes.some(x => x.id === r[1])) openRoute(r[1]);
    else if (h === '#me' && S.joined) go({ name: 'me' });
    else if (h === '#board') go({ name: 'board' });
    else return;
    history.replaceState(null, '', location.pathname);
  }

  function boot() {
    Feed.onStatus = ok => { $('#conn').hidden = ok; };
    map = createMap();
    Feed.onRoutes = f => {
      map.setRoutes(f.routes);
      if (view.name === 'route' && view.routeId && !f.routes.some(r => r.id === view.routeId)) go({ name: 'home' });
      checkNewNotices(); refresh();
    };
    checkNewNotices();
    Share.onChange = () => render();
    Share.onXp = gain => pop(`+${gain} XP`);
    S.onChange = () => { if (S.me?.routeId) setMyRoute(S.me.routeId, true); renderMe(); celebrateNew(); if (!LIVE.has(view.name)) render(); };
    let last = performance.now();
    (function loop(now) {
      const dt = Math.min(0.2, (now - last) / 1000); last = now;
      map.setBuses(Feed.positions(dt));
      requestAnimationFrame(loop);
    })(last);
    refresh(); setInterval(refresh, 1000);
    setInterval(() => { if (!document.hidden) loadBoard(); }, 90e3);

    $('#panelBody').addEventListener('click', onClick);
    $('#panelBody').addEventListener('change', onChange);
    $('#panelBody').addEventListener('submit', onSubmit);
    $('#notices').addEventListener('click', e => {
      if (e.target.closest('[data-all]')) return go({ name: 'notices' });
      const x = e.target.closest('[data-dismiss]'); if (x) { markSeen([+x.dataset.dismiss]); renderNotices(); }
    });
    $('#bell').addEventListener('click', () => go(view.name === 'notices' ? { name: 'home' } : { name: 'notices' }));
    $('#pnav').addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b) { if (b.dataset.nav === 'board') boardTab = 'week'; go({ name: b.dataset.nav }); } });
    $('#meBtn').addEventListener('click', () => (S.joined ? go(view.name === 'me' ? { name: 'home' } : { name: 'me' }) : openJoin()));
    $('#handle').addEventListener('click', () => setSheet(!$('#panel').classList.contains('open')));
    setSheet(true);
    addEventListener('resize', pad); pad();

    const tView = $('#tView');
    tView.addEventListener('click', () => { const top = map.isTop(); map.setView(top ? '3d' : 'top'); tView.textContent = top ? '3D' : '2D'; });
    $('#tRotL').addEventListener('click', () => map.rotate(-45));
    $('#tRotR').addEventListener('click', () => map.rotate(45));
    $('#tZin').addEventListener('click', () => map.zoom(0.5));
    $('#tZout').addEventListener('click', () => map.zoom(2));
    $('#tLoc').addEventListener('click', () => map.recenter());
  }

  /* ---------- map (loads in the background) ---------- */
  function createMap() {
    const msg = $('#mapMsg');
    const show = (text, isErr) => { msg.textContent = text; msg.className = 'map-msg' + (isErr ? ' err' : ''); msg.hidden = false; };
    show('Loading map…');
    let m;
    try { m = new BusMap($('#map'), { routes: Feed.routes, campus: Feed.campus, onSelect: openBus }); }
    catch (e) {
      show('This browser cannot show the map. Live bus times in the list still work.', true);
      const noop = () => {};
      return { setRoutes: noop, setBuses: noop, select: noop, selectRoute: noop, setPadding: noop, isTop: () => false, setView: noop, rotate: noop, zoom: noop, recenter: noop, resize: noop };
    }
    const slow = setTimeout(() => show('The map is slow to load on this connection. Live bus info in the list works meanwhile.', true), 15000);
    m.ready.then(() => { clearTimeout(slow); msg.hidden = true; });
    return m;
  }

  /* ---------- navigation ---------- */
  const LIVE = new Set(['home', 'route']); // views redrawn every second (the others only when their data changes)
  function go(v) {
    const prev = view; view = v;
    if (v.name !== 'route' && prev.name === 'route') map.select(null);
    if (v.name === 'notices') markSeen(Feed.activeNotices().map(n => n.id));
    if (v.name === 'board') loadBoard(boardRoute, true);
    if (v.name === 'me') S.refresh();
    if (v.name === 'user') S.user(v.userId).then(() => view === v && render()).catch(e => toast(e.message));
    if (isMobile()) setSheet(true);
    $('#meBtn').classList.toggle('on', v.name === 'me');
    const tab = { route: 'home', notices: 'home', notify: 'home', feedback: 'home', user: 'board', me: '' }[v.name] ?? v.name;
    document.querySelectorAll('#pnav [data-nav]').forEach(b => b.toggleAttribute('aria-current', b.dataset.nav === tab));
    if (v.name === 'treats') loadBoard(null, true);
    render(); $('#panelBody').scrollTop = 0;
  }
  function busesOn(routeId) { return snap.filter(b => b.routeId === routeId); }
  function bestBus(list) {
    const rank = b => ({ running: 0, stopped: 1, estimated: 2 }[b.status] ?? 3);
    return list.slice().sort((a, b) => rank(a) - rank(b) || (a.lastUpdateSec ?? 1e9) - (b.lastUpdateSec ?? 1e9))[0];
  }
  function openRoute(routeId, busId) {
    snap = Feed.snapshot();
    const bus = busId ? snap.find(b => b.id === busId) : bestBus(busesOn(routeId));
    go({ name: 'route', routeId, busId: bus ? bus.id : null });
    map.selectRoute(routeId, bus ? bus.id : null);
    loadBoard(routeId);
  }
  function openBus(busId) {
    snap = Feed.snapshot();
    const b = snap.find(x => x.id === busId); if (!b) return;
    if (b.routeId) return openRoute(b.routeId, busId);
    go({ name: 'route', routeId: null, busId }); map.select(busId);
  }
  function setSheet(open) {
    $('#panel').classList.toggle('open', open);
    $('#handle').setAttribute('aria-expanded', open);
    $('#handleLabel').textContent = open ? 'Show map' : (view.name === 'route' ? 'Show bus details' : 'Show routes');
    pad();
  }
  function pad() { if (map) map.setPadding(!isMobile() ? 0 : ($('#panel').classList.contains('open') ? innerHeight * 0.62 : 64)); }

  function refresh() {
    snap = Feed.snapshot();
    if (LIVE.has(view.name)) render(); else renderNotices();
    checkReminder();
  }
  function render() {
    renderNotices();
    const body = $('#panelBody'), top = body.scrollTop;
    const html = shareBar() + ({ route: routeView, notices: noticesView, board: boardView, treats: treatsView, me: meView, user: userView, notify: notifyView, feedback: feedbackView }[view.name] || homeView)();
    if (body._html !== html) { if (body._view === view) morph(body, html); else body.innerHTML = html; body._html = html; body._view = view; }
    body.scrollTop = top;
  }
  /**
   * Update the panel in place (only what changed) instead of replacing it: live views refresh every second,
   * and replacing the buttons could swallow a tap that lands mid-refresh. Also keeps <details> open/closed as the user left them.
   */
  function morph(el, html) { const t = document.createElement('template'); t.innerHTML = html; patch(el, t.content); }
  function patch(a, b) {
    const an = [...a.childNodes], bn = [...b.childNodes];
    bn.forEach((y, i) => {
      const x = an[i];
      if (!x) return a.appendChild(y);
      if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return a.replaceChild(y, x);
      if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
      for (const { name } of [...x.attributes]) if (!y.hasAttribute(name) && !(name === 'open' && x.tagName === 'DETAILS')) x.removeAttribute(name);
      for (const { name, value } of [...y.attributes]) if (x.getAttribute(name) !== value && !(name === 'open' && x.tagName === 'DETAILS')) x.setAttribute(name, value);
      patch(x, y);
    });
    for (let i = an.length - 1; i >= bn.length; i--) a.removeChild(an[i]);
  }
  async function loadBoard(routeId, force) {
    try { await S.board(null, force); if (routeId) await S.board(routeId, force); if (!LIVE.has(view.name) || view.name === 'home') render(); }
    catch { /* offline: keep the cached board */ }
  }

  /* ---------- clicks, changes, forms inside the panel ---------- */
  async function onClick(e) {
    const t = e.target, q = s => t.closest(s);
    if (q('[data-back]')) return go(view.from || { name: 'home' });
    if (q('[data-user]')) return go({ name: 'user', userId: q('[data-user]').dataset.user, from: { ...view } });
    if (q('[data-route]')) return openRoute(q('[data-route]').dataset.route);
    if (q('[data-bus]')) return openBus(q('[data-bus]').dataset.bus);
    if (q('[data-share]')) return askShare(q('[data-share]').dataset.share);
    if (q('[data-unshare]')) return Share.stop();
    if (q('[data-gosh]')) return openBus(Share.busId);
    if (q('[data-board]')) { boardTab = q('[data-board]').dataset.board; return go({ name: 'board' }); }
    if (q('[data-gotreats]')) return go({ name: 'treats' });
    if (q('[data-treatroute]')) { document.getElementById('tb-' + q('[data-treatroute]').dataset.treatroute)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (q('[data-tab]')) { boardTab = q('[data-tab]').dataset.tab; return render(); }
    if (q('[data-star]')) return setMyRoute(myRoute === q('[data-star]').dataset.star ? null : q('[data-star]').dataset.star);
    if (q('[data-remind]')) return go({ name: 'notify', from: { ...view } });
    if (q('[data-pushon]')) return run(async () => { await P.enable(); remind = true; local.set('iubat_remind', true); }, '🔔 Notifications on. Try "Send a test".');
    if (q('[data-pushoff]')) return run(() => P.disable(), 'Notifications off');
    if (q('[data-pushtest]')) return run(() => P.test(), 'Test sent: it should pop up in a few seconds.');
    if (q('[data-inapp]')) return toggleRemind();
    if (q('[data-seats]')) return reportSeats(q('[data-seats]').dataset.seats);
    if (q('[data-feedback]')) return go({ name: 'feedback', routeId: q('[data-feedback]').dataset.feedback || view.routeId || myRoute, from: { ...view } });
    if (q('[data-student]')) return toast('Coming soon: link your student ID for a ✔ verified badge once the university database is connected.');
    if (q('[data-join]')) return openJoin();
    if (q('[data-me]')) return go({ name: 'me' });
    if (q('[data-thank]')) return thank(q('[data-thank]').dataset.thank);
    if (q('[data-vouch]')) return run(() => S.act('vouch', { treatIds: q('[data-vouch]').dataset.vouch.split(',').map(Number) }), 'Thanks! Your confirmation is counted. ✋', true);
    if (q('[data-report]')) {
      const id = q('[data-report]').dataset.report;
      if (confirm('Report this photo to the transport office? They will check it and remove it if it is inappropriate. It is hidden for you right away.'))
        run(async () => { await S.act('report', { userId: id }); S.hideAvatar(id); }, 'Sent to the transport office. Thank you for keeping it friendly.');
      return;
    }
    if (q('[data-showkey]')) return showKey();
    if (q('[data-newkey]')) { if (confirm('Make a new recovery code? The old one stops working.')) run(async () => { await S.act('newKey'); showKey(); }); return; }
    if (q('[data-restore]')) return openRestore();
    if (q('[data-removephoto]')) return run(() => S.act('removePhoto'), 'Photo removed');
    if (q('[data-signout]')) { if (confirm('Sign out on this phone? You need your recovery code to get this account back.')) { S.signOut(); go({ name: 'home' }); } return; }
    if (q('[data-delete]')) { if (confirm('Delete your account, XP and badges for good? This cannot be undone.')) run(async () => { await S.remove(); go({ name: 'home' }); }, 'Account deleted'); return; }
    const em = q('[data-emoji]'); if (em) { em.closest('.emojis').querySelectorAll('[data-emoji]').forEach(x => x.setAttribute('aria-checked', x === em)); return; }
  }
  function onChange(e) {
    const t = e.target;
    if (t.matches('[data-myroute]')) return setMyRoute(t.value || null);
    if (t.matches('[data-mystop]')) {
      myStops[t.dataset.mystop] = t.value || undefined; local.set('iubat_mystop', myStops);
      if (t.dataset.mystop === myRoute) { P.stop = t.value || null; P.sync(false).catch(() => {}); }
      return render();
    }
    if (t.matches('[data-pushpref]')) { P.prefs[t.dataset.pushpref] = t.checked; P._save(); return run(() => P.sync(false), 'Saved'); }
    if (t.matches('[data-boardroute]')) { boardRoute = t.value || null; loadBoard(boardRoute); return render(); }
    if (t.matches('#photoIn')) {
      const f = t.files[0]; t.value = '';
      return run(async () => S.act('photo', { data: await S.makePhoto(f) }), 'Photo updated 📸');
    }
  }
  function onSubmit(e) {
    e.preventDefault();
    const f = e.target, v = n => f.elements[n]?.value;
    if (f.dataset.form === 'profile') {
      const name = v('username').trim(), bad = S.checkName(name);
      if (bad) return toast(bad);
      const emoji = f.querySelector('[data-emoji][aria-checked="true"]')?.dataset.emoji;
      return run(() => S.act('update', { username: name, emoji, routeId: v('route') || null, batch: v('batch').trim() }), 'Profile saved');
    }
    if (f.dataset.form === 'feedback') {
      return run(async () => {
        await S._api('feedback', { routeId: v('route') || null, kind: v('kind'), message: v('message'), contact: v('contact') });
        go(view.from || { name: 'home' });
      }, '💬 Thanks! Your feedback went to the transport office.');
    }
    if (f.dataset.form === 'claim') {
      return run(() => S.act('claimTreat', { routeId: f.dataset.route, giver: v('giver') }), 'Enjoy! ☕ The route\'s reputation goes up.', true);
    }
  }
  async function run(fn, ok, reloadBoard) {
    try { await fn(); if (ok) toast(ok); if (reloadBoard) loadBoard(view.routeId || null, true); render(); }
    catch (e) { toast(e.message, true); }
  }

  /* ---------- my route + departure reminder ---------- */
  function setMyRoute(id, quiet) {
    if (myRoute === id) return;
    myRoute = id; local.set('iubat_myroute', id);
    P.route = id; P.stop = id ? myStops[id] || null : null; P.sync(false).catch(() => {});
    if (!quiet && S.joined) S.act('update', { routeId: id }).catch(() => {});
    if (!quiet) toast(id ? '⭐ Saved as your route' : 'Route removed from your home');
    render();
  }
  async function toggleRemind() {
    remind = !remind; local.set('iubat_remind', remind);
    if (remind && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
    toast(remind ? `We'll remind you ${REMIND_MIN} min before your bus leaves while the app is open` : 'In-app reminder off');
    render();
  }
  function checkReminder() {
    if (!(remind || pushOn()) || !myRoute) return;
    const r = Feed.routes.find(x => x.id === myRoute), b = r && bestBus(busesOn(r.id));
    const st = b && tripStatus(b, r);
    if (!st || st.kind !== 'soon') return;
    const key = 'iubat_rem_' + Feed.now().day + st.leg + new Date().toDateString(), done = local.get('iubat_reminded') || {};
    if (done[key]) return;
    done[key] = 1; local.set('iubat_reminded', Object.fromEntries(Object.entries(done).slice(-20)));
    const text = `Bus ${b.id} leaves ${st.where} in ${st.mins} min (${st.at}).`;
    flash({ level: 'info', message: '⏰ ' + text });
    if (!pushOn() && 'Notification' in window && Notification.permission === 'granted') { // with push on, the server sends it
      navigator.serviceWorker?.ready.then(reg => reg.showNotification('⏰ Your bus leaves soon', { body: text, icon: '/assets/icons/icon-192.png', tag: key }))
        .catch(() => { try { new Notification('⏰ Your bus leaves soon', { body: text }); } catch {} });
    }
  }
  const t12 = v => { if (!v) return null; const [h, m] = v.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const m12 = min => t12(`${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`);
  const clock = ms => new Date(ms + Feed.tz * 3600e3).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }); // campus time
  const short = n => n.replace(/^IUBAT /, '');

  /** What is this bus doing today? live / soon (leaves within 20 min) / next / due / done (arrived) / off */
  function tripStatus(b, r) {
    if (!b) return { kind: 'none', title: 'No bus assigned yet' };
    const t = Feed.now(), sc = b.schedule || {}, runs = Feed.busRuns(sc), special = Feed.special();
    const am = Feed.trip(b.id, 'am'), pm = Feed.trip(b.id, 'pm'), first = r ? short(r.stops[0].name) : 'the first stop';
    const stopName = r && myStops[r.id], stop = stopName && r.stops.find(s => s.name === stopName && s.time);
    const pmDep = Feed.hm(sc.departCampus);
    if (b.status === 'running' || b.status === 'stopped')
      return { kind: 'live', title: b.inbound ? `🟢 On the way to campus · ${b.destEtaText}` : `🟢 Heading to ${short(b.to)} · ${b.destEtaText}`, sub: b.nextStop ? `Next stop ${b.nextStop.name} · ${b.nextEtaText}` : '' };
    if (pm?.state === 'arrived') return { kind: 'done', title: `✅ Reached ${first} at ${clock(pm.arrivedAt)}`, sub: 'Evening trip done. See you tomorrow!' };
    if (am?.state === 'arrived' && !(pmDep != null && t.min >= pmDep - REMIND_MIN))
      return { kind: 'done', title: `✅ Reached campus at ${clock(am.arrivedAt)}`, sub: sc.departCampus ? `Leaves campus at ${t12(sc.departCampus)}` : '' };
    if (!runs) return { kind: 'off', title: special && !special.open ? `🏖️ ${special.note || 'Holiday'}: no bus today` : '😴 No bus today', sub: nextBusDay(sc) };
    const legs = [
      { leg: 'am', dep: stop ? Feed.hm(stop.time) : Feed.hm(sc.departStart), where: stop ? stop.name : first, trip: am },
      { leg: 'pm', dep: pmDep, where: 'campus', trip: pm },
    ];
    for (const L of legs) {
      if (L.dep == null || L.trip?.state === 'arrived') continue;
      const mins = L.dep - t.min, at = m12(L.dep);
      if (mins > REMIND_MIN) return { kind: 'next', leg: L.leg, title: `Next: leaves ${L.where} at ${at}`, sub: L.leg === 'am' ? 'Morning trip to campus' : 'Evening trip home' };
      if (mins > 0) return { kind: 'soon', leg: L.leg, mins: Math.ceil(mins), where: L.where, at, title: `⏰ Leaves ${L.where} in ${Math.ceil(mins)} min`, sub: `at ${at} · ${L.leg === 'am' ? 'to campus' : 'from campus'}` };
      if (mins > -100) return { kind: 'due', leg: L.leg, title: b.status === 'estimated' ? `On the way (estimated) · ${b.destEtaText}` : `Should have left ${L.where} at ${at}`, sub: 'No live signal yet. On the bus? Share its location!' };
    }
    return { kind: 'off', title: 'No more trips today', sub: nextBusDay(sc, sc.departStart ? ` · leaves ${first} at ${t12(sc.departStart)}` : '') };
  }
  /** "Next bus: Sat 28 Nov" using the university calendar */
  function nextBusDay(sc, extra = '') {
    for (let i = 1; i <= 14; i++) {
      const d = Feed.date(i);
      if (Feed.busRuns(sc, d)) return `Next bus: ${i === 1 ? 'tomorrow' : new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}${extra}`;
    }
    return '';
  }

  /* ---------- notices ---------- */
  function markSeen(ids) { ids.forEach(i => seenNotices.add(i)); local.set('iubat_seen_notices', [...seenNotices].slice(-200)); }
  function checkNewNotices() {
    const list = Feed.activeNotices(), ids = new Set(list.map(n => n.id));
    if (knownNotices) { const fresh = list.filter(n => !knownNotices.has(n.id)); if (fresh.length) flash(fresh[0]); }
    knownNotices = ids;
  }
  let flashT;
  function flash(n) {
    const t = $('#ntoast');
    t.className = 'ntoast ' + n.level; const title = n.title ?? (n.level === 'urgent' ? 'Urgent notice' : 'New notice');
    t.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}${esc(n.message)}`;
    t.hidden = false; clearTimeout(flashT); flashT = setTimeout(() => (t.hidden = true), 8000);
  }
  const toast = (message, bad) => flash({ level: bad ? 'urgent' : 'info', title: bad ? 'Oops' : '', message });
  function renderNotices() {
    const list = Feed.activeNotices(), unread = list.filter(n => !seenNotices.has(n.id));
    const cnt = $('#bellCount'); cnt.hidden = !unread.length; cnt.textContent = unread.length;
    $('#bell').classList.toggle('on', view.name === 'notices');
    const n = unread[0];
    const html = (!n || view.name === 'notices') ? '' :
      `<div class="notice ${n.level}"><div><b>${n.level === 'urgent' ? 'Urgent' : 'Notice'}</b><p>${esc(n.message)}</p>${list.length > 1 ? `<button class="link" data-all>View all ${list.length} notices</button>` : ''}</div><button class="x" data-dismiss="${n.id}" aria-label="Dismiss notice">&times;</button></div>`;
    const el = $('#notices'); if (el.innerHTML !== html) el.innerHTML = html;
  }
  function noticesView() {
    const list = Feed.activeNotices();
    return `<button class="ghost back" data-back>${ICON_BACK} Home</button><div class="section-title">Notices</div>` +
      (list.length ? list.map(n => `<article class="nitem ${n.level}"><span class="pill ${n.level === 'urgent' ? 'urgent' : 'info'}">${n.level === 'urgent' ? 'Urgent' : 'Notice'}</span><p>${esc(n.message)}</p><time>${when(n.createdAt)}</time></article>`).join('')
        : '<p class="muted-p">No notices right now.</p>');
  }
  const when = ts => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

  /* ---------- formatting ---------- */
  const fmt = m => (m < 1 ? 'Now' : Math.ceil(m) + ' min');
  const lastSeen = b => b.lastUpdateSec == null ? 'No data yet' : b.lastUpdateSec < 90 ? b.lastUpdateSec + ' s ago' : Math.round(b.lastUpdateSec / 60) + ' min ago';
  function schedLine(b) {
    const s = b.schedule || {}, parts = [];
    if (s.departStart) parts.push(`Leaves ${esc(short(b.from === Feed.campus.name ? b.to : b.from))} ${t12(s.departStart)}`);
    if (s.departCampus) parts.push(`Leaves campus ${t12(s.departCampus)}`);
    if (!parts.length) return '';
    return parts.join(' · ') + (s.days ? ` · ${esc(s.days)}` : '');
  }
  const dirText = b => (b.inbound ? 'Inbound · to campus' : 'Outbound · from campus');
  const routeName = id => Feed.routes.find(r => r.id === id)?.name || '';
  const at = u => `<b class="uname">@${esc(u.username)}</b>`;

  /* ---------- crowd sharing ---------- */
  function askShare(busId) {
    if (!S.joined) return openJoin(() => askShare(busId));
    const dlg = $('#shareDlg');
    dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'yes') Share.start(busId, S.token); };
    dlg.showModal();
  }
  const SH_CLASS = { verified: 'ok', backup: 'ok', checking: 'wait', starting: 'wait', weak_gps: 'wait', paused: 'wait', off_route: 'bad', jump: 'bad', disagree: 'bad', wrong_way: 'bad' };
  function shareBar() {
    if (!Share.active && !Share.message) return '';
    if (!Share.active) return `<div class="sharebar ${Share.error ? 'bad' : 'ok'}"><p>${esc(Share.message)}</p></div>`;
    const cls = SH_CLASS[Share.status] || 'wait';
    const fun = Share.xp || Share.thanks ? `<span class="sb-fun">${Share.xp ? `⚡ ${Share.xp} XP this ride` : ''}${Share.thanks ? ` · 🙏 ${Share.thanks} thanks` : ''}</span>` : '';
    const seatsUi = cls === 'ok' ? `<div class="seatq"><span>Seats now?</span>${SEATS.map(([k, e, l]) => `<button data-seats="${k}" class="${seatsOf(Share.busId)?.level === k ? 'on' : ''}">${e} ${l}</button>`).join('')}</div>` : '';
    return `<div class="sharebar ${cls}"><div><b>Sharing for Bus ${esc(Share.busId)}</b><p>${esc(Share.message)}</p>${fun}${seatsUi}</div>
      <span class="sb-act">${view.name !== 'route' || view.busId !== Share.busId ? '<button class="link" data-gosh>View</button>' : ''}<button class="btn-stop" data-unshare>Stop</button></span></div>`;
  }
  /* ---------- seats ---------- */
  const SEATS = [['plenty', '🟢', 'Plenty'], ['few', '🟡', 'Few'], ['full', '🔴', 'Packed']];
  const seatsOf = busId => { const leg = Feed.legNow(); return leg ? Feed.trip(busId, leg)?.seats || null : null; };
  function seatsPill(busId) {
    const s = seatsOf(busId); if (!s) return '';
    const [, e, l] = SEATS.find(x => x[0] === s.level), ago = Math.max(1, Math.round((Date.now() + Feed.offset - s.at) / 60e3));
    return `<span class="pill seats ${s.level}">💺 ${e} ${l === 'Packed' ? 'Packed' : l + ' seats'} · ${ago} min ago</span>`;
  }
  async function reportSeats(level) {
    try {
      const r = await fetch('api/share', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + S.token }, body: JSON.stringify({ action: 'seats', level, busId: Share.busId }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not save.');
      const tr = Feed.trip(Share.busId, Feed.legNow()); if (tr) tr.seats = { level, at: Date.now() + Feed.offset };
      pop('💺 +2 XP'); render();
    } catch (e) { toast(e.message, true); }
  }

  function shareCta(b) {
    if (!Feed.crowdEnabled || b.noRoute || Share.active) return '';
    if (!Feed.busRuns(b.schedule)) { const sp = Feed.special(); return `<div class="sharecta off"><p>${sp && !sp.open ? `🏖️ ${esc(sp.note || 'Holiday')}: ` : '😴 '}no bus today, so sharing is closed.</p></div>`; }
    const leg = Feed.legNow(), w = Feed.windows;
    if (!leg) return `<div class="sharecta off"><p>📍 Riders can share this bus from <b>${m12(w.am[0])}</b> until it reaches campus, and from <b>${m12(w.pm[0])}</b> until it reaches the end of its route.</p></div>`;
    const tr = Feed.trip(b.id, leg);
    if (tr?.state === 'arrived') return `<div class="sharecta off"><p>✅ This trip is done (${leg === 'am' ? 'reached campus' : 'reached the end of the route'} at ${clock(tr.arrivedAt)}). Sharing opens again ${leg === 'am' ? `at ${m12(w.pm[0])}` : 'tomorrow morning'}.</p></div>`;
    const riders = Feed.riders[b.id] || 0;
    return `<div class="sharecta"><div><b>On this bus? Be the hero 🦸</b><p>${riders ? `${riders} rider${riders > 1 ? 's are' : ' is'} sharing. Join as backup and earn XP.` : `Share your location so everyone can see where Bus ${esc(b.id)} is${b.status === 'offline' || b.status === 'estimated' ? ' (no live signal right now)' : ''}. Earn XP!`}</p></div><button class="btn primary sm" data-share="${esc(b.id)}">Share location</button></div>`;
  }
  function thankBtn(b) {
    const leg = Feed.legNow(), tr = leg && Feed.trip(b.id, leg);
    if (!tr || !(Feed.riders[b.id] > 0) || Share.busId === b.id) return '';
    const mine = (local.get('iubat_thanked') || {})[`${b.id}:${Feed.now().day}:${leg}`];
    return `<button class="thank ${mine ? 'done' : ''}" data-thank="${esc(b.id)}" ${mine ? 'disabled' : ''}>🙏 ${mine ? 'Thanked' : 'Thank the rider sharing'} <b>${tr.thanks || 0}</b></button>`;
  }
  async function thank(busId) {
    const k = `${busId}:${Feed.now().day}:${Feed.legNow()}`, t = local.get('iubat_thanked') || {};
    if (t[k]) return;
    t[k] = 1; local.set('iubat_thanked', Object.fromEntries(Object.entries(t).slice(-30)));
    try { const j = await S.thank(busId); const tr = Feed.trip(busId, Feed.legNow()); if (tr && j.thanks) tr.thanks = j.thanks; pop('🙏'); } catch (e) { toast(e.message, true); }
    render();
  }
  const srcText = b => (b.source === 'crowd' ? 'via a rider on board' : b.source === 'schedule' ? 'estimated from the timetable' : 'via bus GPS');

  /* ================= Home ================= */
  function homeView() {
    // Home stays simple: special notices first, then my bus, then all routes. Ranking and treats have their own tabs.
    return dayBanner() + (myRoute ? treatBanner(myRoute, true) : '') + myRouteCard() + routesList()
      + `<button class="fbtn" data-feedback>${ico('chat')}Send feedback to the transport office</button>` + footer();
  }
  // Open source: lets students of other universities find the project (and see who built it)
  function footer() {
    return `<footer class="pfoot"><a href="${REPO}" target="_blank" rel="noopener">${ico('git')}Open source · build one for your university</a>
      <span><a href="/privacy.html">Privacy</a> · <a href="${REPO}#use-it-at-your-university" target="_blank" rel="noopener">How to fork</a> · <a href="${REPO}" target="_blank" rel="noopener">⭐ Star on GitHub</a></span></footer>`;
  }
  /** Special days (exam / program / holiday) today or tomorrow, and double-XP events */
  function dayBanner() {
    let html = '';
    for (const [i, label] of [[0, 'Today'], [1, 'Tomorrow']]) {
      const sp = Feed.special(Feed.date(i)); if (!sp) continue;
      html += `<div class="daybar ${sp.open ? 'open' : 'closed'}">${ico('cal')}<span><b>${label}:</b> ${esc(sp.note || (sp.open ? 'Special open day' : 'Holiday'))} · ${sp.open ? 'buses run' : 'no buses'}</span></div>`;
    }
    const bo = Feed.boostNow(), up = !bo && Feed.boost;
    if (bo) html += `<div class="daybar boost">${ico('bolt')}<span><b>${esc(bo.label)}</b> · every km earns ${bo.mult}× XP until ${new Date(bo.to + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></div>`;
    else if (up) html += `<div class="daybar boost soon">${ico('bolt')}<span>Coming: <b>${esc(up.label)}</b> (${up.mult}× XP) from ${new Date(up.from + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></div>`;
    return html;
  }
  const monthName = m => new Date(m + '-01T00:00:00Z').toLocaleString('en', { month: 'long', timeZone: 'UTC' });
  function battleRows(list, max) {
    return list.slice(0, max).map((x, i) => { const r = Feed.routes.find(y => y.id === x.routeId); if (!r) return '';
      return `<button class="brow2" data-route="${esc(r.id)}" style="--route:${esc(r.color)}"><span class="bn">${rankBadge(i)}${esc(r.name)}</span>
        <span class="bbar"><i style="width:${x.pct}%"></i></span><b>${x.pct}%</b></button>`; }).join('');
  }
  function achievements() {
    const list = S.cachedBoard(null)?.recent || []; if (!list.length) return '';
    return `<div class="section-title">Latest achievements</div><ul class="ach">${list.slice(0, 5).map(a => { const B = S.BADGES[a.badge]; if (!B) return '';
      return `<li><button data-user="${esc(a.user.id)}">${S.avatar(a.user, 28)}<span>${at(a.user)} unlocked <b>${B[0]} ${esc(B[1])}</b></span><em>${ago(a.at)}</em></button></li>`; }).join('')}</ul>`;
  }
  const ago = ts => { const m = Math.round((Date.now() - ts) / 60e3); return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  function myRouteCard() {
    const r = myRoute && Feed.routes.find(x => x.id === myRoute);
    if (!r) return `<label class="pickroute"><span><b>⭐ My route</b><small>Countdown and a reminder ${REMIND_MIN} min before it leaves</small></span>
      <select data-myroute aria-label="My route"><option value="">Choose…</option>${Feed.routes.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>`;
    const b = bestBus(busesOn(r.id)), st = tripStatus(b, r);
    return `<div class="mycard ${st.kind}" style="--route:${esc(r.color)}">
      <button class="mc-main" data-route="${esc(r.id)}"><small>⭐ My route · ${esc(r.name)}${b ? ` · Bus ${esc(b.id)}` : ''}</small>
        <strong>${esc(st.title)}</strong>${st.sub ? `<span>${esc(st.sub)}</span>` : ''}${st.kind === 'soon' ? `<i class="mc-bar" style="--p:${(1 - st.mins / REMIND_MIN) * 100}%"></i>` : ''}</button>
      <button class="mc-bell ${remind || pushOn() ? 'on' : ''}" data-remind title="Notifications">${remind || pushOn() ? '🔔' : '🔕'}</button></div>`;
  }
  function routesList() {
    const routes = Feed.routes;
    if (!routes.length && !snap.length) return '<p class="section-title">No routes have been set up yet.</p>';
    const live = snap.filter(b => b.status === 'running' || b.status === 'stopped').length;
    const rep = S.cachedBoard(null)?.reputation || {};
    let html = `<div class="section-title">Routes · ${live} bus${live === 1 ? '' : 'es'} live</div>`;
    html += routes.map(r => {
      const list = busesOn(r.id), b = bestBus(list), st = b && tripStatus(b, r), riders = list.reduce((n, x) => n + (Feed.riders[x.id] || 0), 0);
      const origin = r.stops[0]?.name || r.name, R = rep[r.id];
      let liveLine = !b ? '<span class="muted-s">No bus assigned yet</span>'
        : st.kind === 'done' ? `<span class="pill done">${esc(st.title)}</span>`
        : st.kind === 'soon' ? `<span class="pill soon">${esc(st.title)}</span>`
        : b.status === 'offline' ? `<span class="pill offline">Bus ${esc(b.id)} · Offline</span>`
        : b.status === 'estimated' ? `<span class="pill estimated">Bus ${esc(b.id)} · Estimated</span><span class="muted-s">${dirText(b)} · ${b.destEtaText}</span>`
        : `<span class="pill ${b.status}">Bus ${esc(b.id)} · ${STATUS[b.status]}</span><span class="muted-s">${dirText(b)}${b.destEtaText !== '—' ? ' · ' + b.destEtaText : ''}</span>`;
      if (riders) liveLine += `<span class="pill riders">👥 ${riders} sharing</span>`;
      if (b) liveLine += seatsPill(b.id);
      const sched = b ? schedLine(b) : '';
      return `<button class="rcard${r.id === myRoute ? ' mine' : ''}" data-route="${esc(r.id)}" style="--route:${esc(r.color)}">
        <span class="rbar"></span>
        <span class="rmain">
          <h3>${r.id === myRoute ? '⭐ ' : ''}${esc(r.name)}${R && R.stingy ? ' <span class="kipta" title="Treat overdue">🥲</span>' : ''}</h3>
          <span class="rsub">${esc(short(origin))} <span class="arrow">⇄</span> Campus${list.length ? ` · Bus ${list.map(x => esc(x.id)).join(', ')}` : ''}</span>
          ${sched ? `<span class="rsched">${ICON_CLOCK}${sched}</span>` : ''}
          <span class="rlive">${liveLine}</span>
        </span>
        <span class="chev">${ICON_CHEV}</span>
      </button>`;
    }).join('');
    const loose = snap.filter(b => !b.routeId);
    if (loose.length) html += `<div class="section-title">Other buses</div>` + loose.map(b => `
      <button class="rcard" data-bus="${esc(b.id)}" style="--route:#9aa29b"><span class="rbar"></span>
        <span class="rmain"><h3>Bus ${esc(b.id)}</h3><span class="rsub">No route assigned yet</span><span class="rlive"><span class="pill ${b.status}">${STATUS[b.status]}</span></span></span>
        <span class="chev">${ICON_CHEV}</span></button>`).join('');
    return html;
  }

  /* ---------- treats: champion's tea/coffee, route reputation ---------- */
  const stars = n => `<span class="stars" style="--p:${(n / 5) * 100}%" aria-label="${n} out of 5">★★★★★</span>`;
  const repLabel = n => (n >= 4.5 ? 'Royal seniors 👑' : n >= 3.5 ? 'Decent seniors 🙂' : n >= 2.5 ? 'Hmm… 🤨' : 'Kipta alert 🥲');
  function treatBanner(routeId, homeOnly) {
    const B = S.cachedBoard(null), R = B?.reputation?.[routeId];
    if (!R || !R.owed.length) return '';
    const r = Feed.routes.find(x => x.id === routeId), me = S.me;
    const member = me && me.routeId === routeId;
    return R.owed.map(o => {
      // invited: the most senior riders of the route, senior to the champion when the champion's batch is known
      const seniors = (B.seniors[routeId] || []).filter(s => s.id !== o.champion.id && (o.champion.batch == null || s.batch < o.champion.batch)).slice(0, 3);
      const days = Math.floor((Date.now() - o.since) / 864e5), mine = me && me.id === o.champion.id;
      if (homeOnly && !mine && !(o.overdue && R.roast)) return ''; // home: only my own treat, or the Sunday treat report
      if (homeOnly && !mine) return `<button class="daybar roast" data-gotreats>${ico('cup')}<span><b>Treat report:</b> ${esc(r?.name || '')} seniors still owe ${at(o.champion)} ☕×${o.cups} 🥲</span>${ICON_CHEV}</button>`;
      const vote = member && !mine ? `<button class="btn ghost-b sm" data-vouch="${o.treatIds.join(',')}">✋ I saw the treat happen <b>${o.votes}/${R.needed}</b></button>` : '';
      if (mine) return `<div class="treat me"><span class="tbig">👑</span><div><b>You're the champion of ${esc(r?.name || '')}!</b>
        <p>☕×${o.cups} invitation waiting from the most senior riders. Got treated? Confirm it in your profile.</p><button class="btn primary sm" data-me>Claim my treat</button></div></div>`;
      if (o.overdue && (R.roast || member))
        return `<div class="treat roast"><span class="tbig">📣</span><div><b>Weekly treat report · ${esc(r?.name || '')}</b>
          <p>Seniors of this route are kipta (stingy) 🥲 holding a junior's treat hostage: ${at(o.champion)} still waits for ☕×${o.cups} after ${days} days.
          Generosity ${stars(R.rating)} <b>${R.rating.toFixed(1)}</b></p>${seniors.length ? `<p class="small">Seniors on duty: ${seniors.map(s => `${at(s)} <span class="muted-s">(Batch ${s.batch})</span>`).join(', ')}</p>` : ''}${vote}</div></div>`;
      return `<div class="treat"><span class="tbig">☕</span><div><b>${at(o.champion)} is ${esc(r?.name || '')}'s champion!</b>
        <p>Invitation: tea or coffee ×${o.cups} from the most senior rider on the bus${seniors.length ? `, e.g. ${seniors.map(s => `${at(s)} <span class="muted-s">(Batch ${s.batch})</span>`).join(', ')}` : ''}. Seniors, it's cha time!</p>${vote}</div></div>`;
    }).join('');
  }
  function reputationLine(routeId) {
    const R = S.cachedBoard(null)?.reputation?.[routeId];
    if (!R) return `<button class="repline" data-gotreats>${stars(5)} <span>Generosity 5.0 · no treats due yet</span>${ICON_CHEV}</button>`;
    return `<button class="repline ${R.stingy ? 'bad' : ''}" data-gotreats>${stars(R.rating)} <span>Generosity ${R.rating.toFixed(1)} · ${repLabel(R.rating)}${R.good ? ` · ${R.good} treat${R.good > 1 ? 's' : ''} given` : ''}</span>${ICON_CHEV}</button>`;
  }

  /* ================= One route ================= */
  function routeView() {
    const back = `<button class="ghost back" data-back>${ICON_BACK} Home</button>`;
    const r = view.routeId && Feed.routes.find(x => x.id === view.routeId);
    const list = r ? busesOn(r.id) : snap.filter(b => b.id === view.busId);
    const b = list.find(x => x.id === view.busId) || bestBus(list);
    const title = r ? esc(r.name) : `Bus ${esc(view.busId)}`;
    let html = back + `<div class="r-head" style="--route:${r ? esc(r.color) : '#9aa29b'}"><span class="rbar"></span><div class="grow1"><h2>${title}</h2>
      <span class="rsub">${r ? `${esc(short(r.stops[0].name))} <span class="arrow">⇄</span> IUBAT Campus` : 'No route assigned yet'}</span></div>
      ${r ? `<button class="star ${myRoute === r.id ? 'on' : ''}" data-star="${esc(r.id)}" aria-pressed="${myRoute === r.id}">${myRoute === r.id ? '★ My route' : '☆ My route'}</button>` : ''}</div>`;
    if (r) html += reputationLine(r.id) + treatBanner(r.id);
    if (list.length > 1) html += `<div class="seg" role="tablist">${list.map(x => `<button role="tab" data-bus="${esc(x.id)}" aria-selected="${x.id === b.id}"><i class="dot ${({ running: 'run', stopped: 'stop', estimated: 'est' })[x.status] || 'off'}"></i>Bus ${esc(x.id)}</button>`).join('')}</div>`;
    if (!b) return html + `<p class="muted-p">No bus is assigned to this route yet.</p>` + (r ? stopsOnly(r) : '');
    const sched = schedLine(b), st = tripStatus(b, r);
    if (sched) html += `<div class="sched">${ICON_CLOCK}<span>${sched}</span></div>`;
    if (st.kind === 'soon' || st.kind === 'done') html += `<div class="tripchip ${st.kind}"><b>${esc(st.title)}</b>${st.sub ? `<span>${esc(st.sub)}</span>` : ''}</div>`;
    if (r && myRoute === r.id) html += remindRow(r);
    return html + busDetail(b, r) + (r ? routeTop(r.id) : '') + `<button class="fbtn" data-feedback="${r ? esc(r.id) : ''}">${ico('chat')}Feedback about this route</button>`;
  }
  function remindRow(r) {
    const timed = r.stops.filter(s => s.time);
    const on = remind || pushOn();
    return `<div class="remindrow"><button class="mc-bell ${on ? 'on' : ''}" data-remind>${on ? '🔔' : '🔕'}</button>
      <span>${pushOn() ? `Push reminder ${REMIND_MIN} min before it leaves` : on ? `In-app reminder ${REMIND_MIN} min before` : `Remind me ${REMIND_MIN} min before it leaves`}</span>
      ${timed.length ? `<select data-mystop="${esc(r.id)}" aria-label="My stop"><option value="">from the first stop</option>${timed.map(s => `<option ${myStops[r.id] === s.name ? 'selected' : ''} value="${esc(s.name)}">at ${esc(s.name)} (${t12(s.time)})</option>`).join('')}</select>` : ''}</div>`;
  }
  function routeTop(routeId) {
    const B = S.cachedBoard(routeId); if (!B) return '';
    const list = B.weekTop.slice(0, 3);
    return `<div class="section-title">This week on this route</div>` + (list.length ? `<ol class="mini">${list.map((u, i) => `<li><button data-user="${esc(u.id)}">${rankBadge(i)} ${S.avatar(u, 28)} ${at(u)}<span>${u.pts} XP</span></button></li>`).join('')}</ol>`
      : '<p class="muted-p">Nobody has shared this week yet. First come, first crowned 👑</p>') + `<button class="link more" data-board="week">Full leaderboard ›</button>`;
  }
  const stopsOnly = r => `<div class="section-title">Route stops</div><ol class="timeline">${r.stops.map(s => `<li class="upcoming"><i></i><div class="nm"><span>${esc(s.name)}</span><span class="tm">${s.time ? t12(s.time) : ''}</span></div></li>`).join('')}</ol>`;

  function busDetail(b, r) {
    const head = `<div class="d-head"><span class="badge ${b.status}">${esc(b.id)}</span><div><h2>Bus ${esc(b.id)}</h2><span class="pill ${b.status}">${STATUS[b.status]}${b.atStop && b.status === 'stopped' ? ' · ' + esc(b.atStop) : ''}</span>${(b.noRoute || b.noData) ? '' : ` <span class="pill dir">${dirText(b)}</span>`}</div></div>`;
    if (b.noData) return head + shareCta(b) + `<p class="muted-p">No live location yet. It appears as soon as the bus phone or a rider on board shares.</p>` + (r ? stopsOnly(r) : '');
    if (b.noRoute) return head + `<p class="muted-p">No route assigned yet. Live position is shown on the map.</p>`;
    const off = b.status === 'offline', est = b.status === 'estimated';
    const next = off ? 'Offline' : (b.nextStop ? esc(b.nextStop.name) : 'Arrived');
    const estNote = est ? `<div class="estnote"><b>No live signal right now.</b> This position is estimated from the timetable (left ${esc(short(b.from))} at ${t12(b.estDepart)}${b.estByStops ? ', following the stop pick-up times' : ', assuming about 22 km/h'}). The real bus may be ahead or behind.</div>` : '';
    return `${head}${estNote}
      <div class="journey">
        <div class="j-ends"><div><small>From</small><b>${esc(b.from)}</b></div><div class="to"><small>To</small><b>${esc(b.to)}</b></div></div>
        <div class="track" aria-hidden="true"><div class="fill" style="width:${(b.progress * 100).toFixed(1)}%"></div><div class="bus" style="left:${(b.progress * 100).toFixed(1)}%">${ICON_BUS}</div></div>
        <div class="j-foot">${off ? '<b>No signal</b> · last seen ' + lastSeen(b) : '<b>' + (b.inbound ? 'Heading to campus' : 'Leaving campus') + '</b> · ' + srcText(b)}</div>
      </div>
      ${seatsPill(b.id) ? `<div class="seatline">${seatsPill(b.id)}</div>` : ''}${thankBtn(b)}${shareCta(b)}
      <div class="stats">
        <div class="stat hot"><small>Arrives in</small><strong>${b.destEtaText}</strong></div>
        <div class="stat warm"><small>Next stop</small><strong style="font-size:16px">${next}</strong>${!off && b.nextStop ? `<em> · ${b.nextEtaText}</em>` : ''}</div>
        <div class="stat"><small>Speed</small><strong>${est ? '—' : `${b.speedKmh} <em>km/h</em>`}</strong></div>
        <div class="stat"><small>${est ? 'Last live signal' : 'Last update'}</small><strong style="font-size:16px">${lastSeen(b)}</strong></div>
      </div>
      <div class="section-title">Route stops</div>
      <ol class="timeline">
        ${b.stops.map(s => `
          <li class="${s.state}"><i></i>
            <div class="nm"><span>${esc(s.name)}${s.state === 'here' ? ' <span class="tag">Here</span>' : ''}${s.state === 'next' ? ' <span class="tag">Next</span>' : ''}${r && myStops[r.id] === s.name ? ' <span class="tag mine">My stop</span>' : ''}${s.time && b.inbound ? `<small class="sched-t">${t12(s.time)}</small>` : ''}</span>
              <span class="tm">${s.state === 'passed' ? 'Passed' : s.state === 'here' ? 'Now' : off ? '' : fmt(s.etaMin)}</span></div>
          </li>`).join('')}
      </ol>`;
  }

  /* ================= Leaderboard ================= */
  function boardView() {
    const B = S.cachedBoard(boardRoute);
    const tabs = [['today', 'Today'], ['week', 'Week'], ['all', 'All time'], ['battle', 'Routes']];
    let html = `<div class="bhead"><h2>${ico('trophy')}Leaderboard</h2><select data-boardroute aria-label="Route"><option value="">All routes</option>${Feed.routes.map(r => `<option value="${esc(r.id)}" ${boardRoute === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div class="seg tabs3" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${boardTab === k}">${l}</button>`).join('')}</div>`;
    if (!B) return html + '<p class="muted-p">Loading…</p>';
    if (boardTab === 'battle') return html + battleView();
    const list = { today: B.today, week: B.weekTop, all: B.allTime }[boardTab] || [];
    html += list.length ? `<ol class="board">${list.map((u, i) => {
      const L = S.level(u.xp), me = S.me && S.me.id === u.id;
      return `<li class="${me ? 'me' : ''} ${i < 3 ? 'top' + (i + 1) : ''}"><button data-user="${esc(u.id)}">
        ${rankBadge(i)}${S.avatar(u, 40)}
        <span class="who"><b>@${esc(u.username)}${u.verified ? ' <span class="vf" title="Verified student">✔</span>' : ''}${me ? ' <em>you</em>' : ''}</b><small>Lv ${L.n} · ${esc(L.name)}</small>
          <small>${!boardRoute && u.routeId ? esc(routeName(u.routeId)) + ' · ' : ''}${u.km} km shared</small>${S.badgeRow(u.badges)}</span>
        <span class="pts"><b>${u.pts}</b><small>XP</small></span></button></li>`;
    }).join('')}</ol>` : `<div class="emptyboard"><span>🏁</span><p>${boardTab === 'today' ? 'Nobody has shared today yet.' : 'No contributions yet.'} Share your bus location to take the #1 spot!</p></div>`;
    if (!S.joined) html += `<div class="joincta"><div><b>Want your name here?</b><p>Pick a username, share your bus, earn XP. No password needed.</p></div><button class="btn primary sm" data-join>Join</button></div>`;
    html += `<details class="howto"><summary>How do I earn XP?</summary><ul>
      <li>⚡ <b>10 XP per km</b> you share while the bus moves (checked automatically).</li>
      <li>🚩 <b>+5</b> for being the first rider to share a trip; 🏁 <b>+15</b> for sharing it to the end.</li>
      <li>🛟 Half XP while you are a backup (bus phone or another rider is already live).</li>
      <li>👑 The weekly #1 of each route (Sat–Fri) wins a badge and a ☕ invitation from the most senior riders.</li></ul></details>`;
    if (B.champions.length) html += `<div class="section-title">Hall of champions</div><ol class="mini">${B.champions.slice(0, 8).map(c => `<li><button data-user="${esc(c.user.id)}">${S.avatar(c.user, 28)} ${at(c.user)}<span>${esc(routeName(c.routeId))} · week of ${new Date(c.week + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></button></li>`).join('')}</ol>`;
    html += achievements();
    return html;
  }

  function battleView() {
    const B = S.cachedBoard(null) || {}, list = B.battle || [];
    let html = `<div class="battle big"><div class="bt-head"><b>${ico('swords')}Route battle · ${monthName((B.day || Feed.date()).slice(0, 7))}</b></div>
      <p class="small">Which route keeps its bus live? Score = share of this month's bus trips where at least one rider shared. Every trip counts, big or small route.</p>
      ${list.length ? battleRows(list, 20) : '<p class="muted-p">No trips yet this month.</p>'}
      ${list.length ? `<small>${list.map(x => `${esc(routeName(x.routeId))}: ${x.covered}/${x.scheduled} trips · ${x.riders} rider${x.riders === 1 ? '' : 's'}`).join(' · ')}</small>` : ''}</div>`;
    html += `<p class="small muted-p">🏆 The winner is announced on the 1st. Everyone who shared on the winning route gets the ⚔️ Route Warrior badge.</p>`;
    if (B.battleWins?.length) html += `<div class="section-title">Past winners</div><ol class="mini">${B.battleWins.map(w => `<li><button data-route="${esc(w.routeId)}">🏆 ${esc(routeName(w.routeId))}<span>${monthName(w.month)} · ${Math.round(w.pct)}%</span></button></li>`).join('')}</ol>`;
    return html;
  }

  /* ================= Treat board: every route's weekly treat status and reputation ================= */
  function treatsView() {
    const B = S.cachedBoard(null);
    let html = `<div class="bhead"><h2>${ico('cup')}Treat board</h2></div>
      <p class="lede">Each route's weekly #1 contributor (Sat–Fri) is owed a tea or coffee by the route's most senior riders. Here everyone can see who treated, who didn't, and each route's reputation.</p>`;
    if (!B) return html + '<p class="muted-p">Loading…</p>';
    const rows = Feed.routes.map(r => ({ r, R: B.reputation?.[r.id] || null }))
      .sort((a, b) => (b.R?.stingy ? 1 : 0) - (a.R?.stingy ? 1 : 0) || (a.R ? a.R.rating : 5) - (b.R ? b.R.rating : 5) || a.r.name.localeCompare(b.r.name));
    html += `<div class="section-title">Route reputation</div><ol class="replist">${rows.map(({ r, R }) => {
      const rating = R ? R.rating : 5;
      return `<li><button data-treatroute="${esc(r.id)}" style="--route:${esc(r.color)}"><i class="rdot"></i><b>${esc(r.name)}</b>${stars(rating)}<span class="rnum">${rating.toFixed(1)}</span>
        <small class="${R?.stingy ? 'bad' : ''}">${R?.stingy ? 'Treat overdue 🥲' : R?.owed.length ? 'Treat pending ☕' : repLabel(rating)}</small></button></li>`;
    }).join('')}</ol>`;
    html += rows.map(({ r, R }) => {
      const me = S.me, member = me && me.routeId === r.id, seniors = B.seniors?.[r.id] || [];
      const owed = (R?.owed || []).map(o => {
        const days = Math.floor((Date.now() - o.since) / 864e5), sen = seniors.filter(s => s.id !== o.champion.id && (o.champion.batch == null || s.batch < o.champion.batch)).slice(0, 3);
        const vote = member && me.id !== o.champion.id ? `<button class="btn ghost-b sm" data-vouch="${o.treatIds.join(',')}">I saw the treat happen · ${o.votes}/${R.needed}</button>` : '';
        return `<div class="tb-item ${o.overdue ? 'late' : ''}">${S.avatar(o.champion, 34)}<div><b>${at(o.champion)} is owed ☕×${o.cups}</b>
          <small>${o.overdue ? `Overdue · waiting ${days} days` : `Since ${days ? days + ' day' + (days > 1 ? 's' : '') : 'today'}`}${sen.length ? ` · Seniors on duty: ${sen.map(s => '@' + esc(s.username)).join(', ')}` : ''}</small>${vote}</div></div>`;
      }).join('');
      const given = (R?.given || []).map(g => `<li>☕ ${g.giver ? `<b>@${esc(g.giver)}</b> treated` : 'Riders confirmed a treat for'} <b>@${esc(g.champion)}</b><span>week of ${new Date(g.week + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</span></li>`).join('');
      if (!owed && !given) return '';
      return `<section class="tb-card" id="tb-${esc(r.id)}" style="--route:${esc(r.color)}"><header><b>${esc(r.name)}</b>${stars(R.rating)}<span class="rnum">${R.rating.toFixed(1)}</span></header>
        ${R.stingy ? '<p class="tb-roast">Seniors of this route are kipta (stingy) 🥲, holding a junior\'s treat hostage.</p>' : ''}${owed}${given ? `<ul class="tb-given">${given}</ul>` : ''}</section>`;
    }).join('') || '<p class="muted-p">No treats yet. The first weekly champions are crowned on Saturday.</p>';
    html += `<details class="howto"><summary>How the treat board works</summary><ul>
      <li>👑 Saturday: the top contributor of each route last week becomes its champion and is owed ☕.</li>
      <li>🫖 The champion confirms "I got my treat" with the senior's username; the senior earns the Generous Senior badge.</li>
      <li>✋ If the champion forgets, most riders of the route can confirm it instead.</li>
      <li>📣 A treat still pending after 7 days lowers the route's rating, and every Sunday the whole route sees the treat report.</li></ul></details>`;
    return html;
  }

  /* ================= Notifications ================= */
  function notifyView() {
    const back = `<button class="ghost back" data-back>${ICON_BACK} Back</button>`;
    const r = Feed.routes.find(x => x.id === myRoute);
    let html = back + `<div class="bhead"><h2>${ico('bell')}Notifications</h2></div>`;
    if (!r) html += `<label class="pickroute"><span>⭐ First pick your route</span><select data-myroute><option value="">Choose…</option>${Feed.routes.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>`;
    const timed = r ? r.stops.filter(s => s.time) : [];
    if (r && timed.length) html += `<label class="nrow"><span>Remind me at</span><select data-mystop="${esc(r.id)}"><option value="">the first stop</option>${timed.map(s => `<option ${myStops[r.id] === s.name ? 'selected' : ''} value="${esc(s.name)}">${esc(s.name)} (${t12(s.time)})</option>`).join('')}</select></label>`;
    if (!P.supported()) {
      html += `<p class="estnote">This browser cannot receive push notifications. Install the app (Chrome on Android, or Safari → Add to Home Screen on iPhone).</p>`;
    } else if (P.needsInstall()) {
      html += `<div class="estnote"><b>iPhone:</b> tap <b>Share</b> → <b>Add to Home Screen</b>, open IUBAT Bus from your home screen, then turn notifications on here (iOS 16.4 or newer).</div>`;
    } else if (Notification.permission === 'denied') {
      html += `<p class="estnote">🔕 Notifications are blocked for this site. Allow them in the browser's site settings (🔒 next to the address), then come back here.</p>`;
    } else if (!pushOn()) {
      html += `<div class="pushcard"><span>📲</span><div><b>Get a push even when the app is closed</b><p>${r ? `Bus on ${esc(r.name)}: ${REMIND_MIN} min before it leaves, weekly champion & treat news, transport notices.` : 'Pick your route first.'}</p>
        <button class="btn primary sm" data-pushon ${r ? '' : 'disabled'}>Turn on notifications</button></div></div>`;
    } else {
      const sw = (k, l, d) => `<label class="switch2"><input type="checkbox" data-pushpref="${k}" ${P.prefs[k] ? 'checked' : ''}><span></span><div><b>${l}</b><small>${d}</small></div></label>`;
      html += `<div class="pform card2">${sw('remind', `⏰ Departure reminder`, `${REMIND_MIN} min before your bus leaves${myStops[myRoute] ? ` ${esc(myStops[myRoute])}` : ''} (morning) and campus (evening), on bus days only`)}
        ${sw('treat', '👑 Champion & ☕ treat news', 'Weekly champion (Saturday), treat report (Sunday), route battle winner')}
        ${sw('notices', '📢 Transport notices', 'Important notices from the transport office')}
        <div class="inrow"><button class="btn ghost-b sm" data-pushtest>Send a test</button><button class="link danger" data-pushoff>Turn off</button></div></div>`;
    }
    html += `<label class="switch2 inapp"><input type="checkbox" data-inapp ${remind ? 'checked' : ''}><span></span><div><b>In-app reminder</b><small>A banner ${REMIND_MIN} min before, while the app is open</small></div></label>`;
    return html;
  }

  /* ================= Feedback (only the transport office reads it) ================= */
  function feedbackView() {
    const back = `<button class="ghost back" data-back>${ICON_BACK} Back</button>`, sel = view.routeId || myRoute;
    return back + `<div class="bhead"><h2>${ico('chat')}Feedback</h2></div>
      <form data-form="feedback" class="pform card2">
        <p class="small">Only the transport office can read this. Problems with a bus, the schedule or the app, or an idea: tell us.</p>
        <div class="row2"><label class="field"><span>Route</span><select name="route"><option value="">Not about a route</option>${Feed.routes.map(r => `<option value="${esc(r.id)}" ${sel === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
          <label class="field"><span>About</span><select name="kind"><option value="bus">The bus</option><option value="driver">Driver / staff</option><option value="schedule">Timing / schedule</option><option value="app">This app</option><option value="idea">An idea</option><option value="other">Other</option></select></label></div>
        <label class="field"><span>Message</span><textarea name="message" rows="5" maxlength="1500" required placeholder="What happened? When? Which bus?"></textarea></label>
        <label class="field"><span>Contact <em>(optional)</em></span><input name="contact" maxlength="80" placeholder="Phone or email, if you want a reply"></label>
        <p class="fhint">📎 Photo / video attachments are coming soon.${S.me ? ` Sent as @${esc(S.me.username)}.` : ' Sent anonymously.'}</p>
        <button class="btn primary">Send feedback</button></form>`;
  }

  /* ================= Profiles ================= */
  function profileCard(p, self) {
    const L = S.level(p.xp);
    const owned = new Set(p.badges);
    const badges = Object.entries(S.BADGES).map(([id, [e, n, d]]) => `<li class="${owned.has(id) ? 'got' : ''}" title="${esc(d)}"><span>${e}</span><b>${esc(n)}</b><small>${esc(d)}</small></li>`).join('');
    return `<div class="pcard" style="--c:${esc(p.color)}">${S.avatar(p, 76, 'big')}
        <div><h2>@${esc(p.username)}${p.verified ? ' <span class="vf" title="Verified student">✔</span>' : ''}</h2>
          <div class="chips2">${owned.has('contributor') ? '<span class="chip2 contrib">🤝 Contributor</span>' : '<span class="chip2">New rider</span>'}${p.champion.length ? `<span class="chip2 gold">👑 Champion ×${p.champion.length}</span>` : ''}${p.batch ? `<span class="chip2">Batch ${p.batch}</span>` : ''}${p.routeId ? `<span class="chip2">${esc(routeName(p.routeId))}</span>` : ''}</div></div></div>
      <div class="lvl"><div class="lvl-top"><b>Lv ${L.n} · ${esc(L.name)}</b><span>${p.xp}${L.to ? ` / ${L.to}` : ''} XP</span></div><div class="lvl-bar"><i style="width:${L.pct}%"></i></div>
        <small>${L.next ? `${L.to - p.xp} XP to ${esc(L.next)}` : 'Max level. Absolute legend.'}</small></div>
      <div class="stats s4"><div class="stat"><small>This week</small><strong>${p.week}</strong></div><div class="stat"><small>Shared</small><strong>${p.km}<em> km</em></strong></div>
        <div class="stat"><small>Trips</small><strong>${p.trips}</strong></div><div class="stat"><small>Streak</small><strong>${p.streak ? '🔥' + p.streak : '0'}</strong></div></div>
      <div class="section-title">Contributions</div>${S.heatmap(p.heat, p.heatFrom)}
      <div class="section-title">Badges · ${owned.size}/${Object.keys(S.BADGES).length}</div><ul class="badges">${badges}</ul>`;
  }
  function userView() {
    const p = S.cachedUser(view.userId);
    const back = `<button class="ghost back" data-back>${ICON_BACK} Back</button>`;
    if (!p) return back + '<p class="muted-p">Loading…</p>';
    const self = S.me && S.me.id === p.id;
    return back + profileCard(p, self) + (p.avatarV && S.joined && !self ? `<button class="link report" data-report="${esc(p.id)}">Report photo</button>` : '');
  }
  function meView() {
    const back = `<button class="ghost back" data-back>${ICON_BACK} Home</button>`;
    const p = S.me;
    if (!p) return back + `<div class="joincta"><div><b>You haven't joined yet</b><p>Pick a username to share your bus and earn XP.</p></div><button class="btn primary sm" data-join>Join</button></div>`;
    let html = back + profileCard(p, true);
    html += (p.owed || []).map(o => `<form class="claim" data-form="claim" data-route="${esc(o.routeId)}"><span class="tbig">☕</span><div>
      <b>You're owed ☕×${o.cups} on ${esc(routeName(o.routeId))}!</b><p>Got your tea/coffee from a senior? Enter their username to confirm. The route's reputation goes up.</p>
      <div class="inrow"><input name="giver" placeholder="senior's username" autocapitalize="off" spellcheck="false" required><button class="btn primary sm">I got my treat</button></div></div></form>`).join('');
    if (p.shareBlocked) html += `<p class="estnote">Location sharing is turned off for your account by the transport office.</p>`;
    if (p.photoHidden) html += `<p class="estnote">Your photo is hidden until the transport office reviews it.</p>`;
    html += `<details class="edit" open><summary>Edit profile</summary><form data-form="profile" class="pform">
      <label class="field"><span>Username</span><input name="username" value="${esc(p.username)}" maxlength="20" autocapitalize="off" spellcheck="false">
        <small class="fhint">${p.renameAfter > Date.now() ? `Next change possible on ${new Date(p.renameAfter).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'Letters, numbers and _; must start with a letter or _. You can change it once a week.'}</small></label>
      <div class="field"><span>Avatar</span><div class="emojis">${emojiGrid(p.emoji)}</div></div>
      <div class="row2"><label class="field"><span>My route</span><select name="route"><option value="">—</option>${Feed.routes.map(r => `<option value="${esc(r.id)}" ${p.routeId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Batch</span><input name="batch" value="${esc(p.batch ?? '')}" inputmode="numeric" maxlength="4" placeholder="e.g. 2023"></label></div>
      <div class="photo-row">${p.noPhoto ? '<span class="muted-s">Photo uploads are turned off for your account.</span>'
        : `<label class="btn ghost-b sm">📸 ${p.avatarV ? 'Change photo' : 'Add a small photo'}<input type="file" id="photoIn" accept="image/*" hidden></label>${p.avatarV ? '<button type="button" class="link" data-removephoto>Remove photo</button>' : ''}`}</div>
      <small class="fhint">Photos are cut to a small square and shown on the leaderboard. Keep it friendly: rude photos get removed and uploads disabled.</small>
      <button class="btn primary">Save</button></form></details>
    <button class="studentrow" data-student><span>🎓</span><div><b>Link your student ID</b><small>Coming soon: a ✔ verified badge and real seniority for treats, once the university database is connected.</small></div><em>Soon</em></button>
    <details class="edit"><summary>🔑 Recovery code & this phone</summary><div class="pform">
      <p class="small">No password: your account lives on this phone. Save the recovery code to use it on another phone.</p>
      <div class="inrow"><button class="btn ghost-b sm" data-showkey>Show recovery code</button><button class="btn ghost-b sm" data-newkey>Make a new code</button></div>
      <div class="inrow"><button class="link" data-signout>Sign out on this phone</button><button class="link danger" data-delete>Delete account</button></div></div></details>
    <button class="fbtn" data-feedback>${ico('chat')}Send feedback</button>`;
    return html;
  }
  const emojiGrid = sel => S.EMOJIS.map(e => `<button type="button" role="radio" data-emoji="${e}" aria-checked="${e === sel}">${e}</button>`).join('');

  /* ---------- top bar profile button, celebrations ---------- */
  function renderMe() {
    const b = $('#meBtn');
    b.innerHTML = S.me ? S.avatar(S.me, 30) : '<span>Join</span>';
    b.classList.toggle('joined', !!S.me);
    b.setAttribute('aria-label', S.me ? `My profile (@${S.me.username})` : 'Join as contributor');
  }
  function celebrateNew() {
    const p = S.me; if (!p) return;
    const prev = local.get('iubat_prog') || { lvl: S.level(p.xp).n, badges: p.badges };
    const L = S.level(p.xp), fresh = p.badges.filter(x => !prev.badges.includes(x));
    if (L.n > prev.lvl) celebrate(`Level up! Lv ${L.n} · ${L.name}`);
    else if (fresh.length) celebrate(`New badge: ${S.BADGES[fresh[0]][0]} ${S.BADGES[fresh[0]][1]}`);
    local.set('iubat_prog', { lvl: L.n, badges: p.badges });
  }
  function celebrate(text) {
    const fx = $('#xpfx');
    fx.innerHTML = `<div class="burst">${Array.from({ length: 16 }, (_, i) => `<i style="--a:${i * 22.5}deg;--d:${60 + (i % 3) * 30}px">${['🎉', '⭐', '✨', '🚌', '🔥', '☕'][i % 6]}</i>`).join('')}</div><div class="cele">${esc(text)}</div>`;
    fx.className = 'xpfx show'; clearTimeout(fx._t); fx._t = setTimeout(() => (fx.className = 'xpfx'), 3200);
  }
  function pop(text) {
    const el = document.createElement('div'); el.className = 'xppop'; el.textContent = text;
    document.body.appendChild(el); setTimeout(() => el.remove(), 1600);
  }

  /* ---------- join / recovery dialogs ---------- */
  let afterJoin = null, tsToken = null, tsLoaded = false;
  function openJoin(then) {
    afterJoin = then || null;
    const dlg = $('#joinDlg');
    $('#jEmoji').innerHTML = emojiGrid(S.EMOJIS[Math.floor(Math.random() * S.EMOJIS.length)]);
    $('#jRoute').innerHTML = `<option value="">—</option>` + Feed.routes.map(r => `<option value="${esc(r.id)}" ${(view.routeId || myRoute) === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    $('#jErr').hidden = true;
    if (Feed.turnstile) loadTurnstile();
    dlg.showModal(); setTimeout(() => $('#jName').focus(), 50);
  }
  function loadTurnstile() {
    const render = () => { $('#jTs').innerHTML = ''; window.turnstile.render('#jTs', { sitekey: Feed.turnstile, callback: t => (tsToken = t) }); };
    if (window.turnstile) return render();
    if (tsLoaded) return; tsLoaded = true;
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = render; document.head.appendChild(s);
  }
  $('#jEmoji').addEventListener('click', e => { const b = e.target.closest('[data-emoji]'); if (b) $('#jEmoji').querySelectorAll('[data-emoji]').forEach(x => x.setAttribute('aria-checked', x === b)); });
  $('#jName').addEventListener('input', e => {
    const bad = S.checkName(e.target.value), h = $('#jNameHint');
    h.textContent = !e.target.value ? 'Like a variable name: starts with a letter or _, then letters, numbers or _.' : bad || '✓ Looks good';
    h.className = 'fhint ' + (!e.target.value ? '' : bad ? 'bad' : 'ok');
  });
  $('#jLater').addEventListener('click', () => $('#joinDlg').close());
  $('#jRestore').addEventListener('click', () => { $('#joinDlg').close(); openRestore(); });
  $('#joinForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#jErr'), name = $('#jName').value.trim(), bad = S.checkName(name), btn = $('#jGo');
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await S.join({ username: name, emoji: $('#jEmoji [aria-checked="true"]')?.dataset.emoji, routeId: $('#jRoute').value || null, batch: $('#jBatch').value.trim(), turnstile: tsToken });
      if (S.me.routeId) setMyRoute(S.me.routeId, true);
      $('#joinDlg').close(); celebrate(`Welcome aboard, @${S.me.username}!`);
      showKey(() => { const f = afterJoin; afterJoin = null; f ? f() : go({ name: 'me' }); });
    } catch (x) { err.textContent = x.message; err.hidden = false; if (window.turnstile) try { window.turnstile.reset(); } catch {} }
    btn.disabled = false; btn.textContent = "Let's go";
  });
  function showKey(then) {
    const dlg = $('#keyDlg');
    $('#keyVal').value = S.key || '(not available on this phone: make a new code)';
    dlg.onclose = () => then && then();
    dlg.showModal();
  }
  const copy = async (text, ok) => { try { await navigator.clipboard.writeText(text); toast(ok); } catch { $('#keyVal').select(); toast('Select and copy the code'); } };
  $('#keyCopy').addEventListener('click', () => copy(S.key, 'Recovery code copied. Keep it private!'));
  $('#keyLink').addEventListener('click', () => copy(`${location.origin}/#restore=${S.key}`, 'Restore link copied. Send it only to yourself.'));
  function openRestore(code) {
    $('#restoreVal').value = code || ''; $('#restoreErr').hidden = true;
    $('#restoreDlg').showModal();
  }
  $('#restoreCancel').addEventListener('click', () => $('#restoreDlg').close());
  $('#restoreForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await S.restore($('#restoreVal').value); $('#restoreDlg').close(); celebrate(`Welcome back, @${S.me.username}!`); go({ name: 'me' }); }
    catch (x) { $('#restoreErr').textContent = x.message; $('#restoreErr').hidden = false; }
  });

  /* ---------- installable app (PWA) ---------- */
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  let installEvt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
  addEventListener('appinstalled', () => { installEvt = null; $('#installBtn').hidden = true; });
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true;
  });

  start();
})();
