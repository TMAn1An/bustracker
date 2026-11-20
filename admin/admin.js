(function () {
  const $ = s => document.querySelector(s);
  const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} }, del(k) { try { sessionStorage.removeItem(k); } catch {} } };
  const API = '../api/';
  const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = ['#0b6e1c', '#d92d20', '#1d6fe0', '#8a3ffc', '#f08a00', '#00a3a3', '#c2188a', '#5b6b00'];

  let token = store.get('iubat_admin'), S = null, E = null, dirty = false, map = null, markers = [], mapReady = null;

  /* ---------- helpers ---------- */
  let toastT;
  function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'a-toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), bad ? 5000 : 2600); }
  async function api(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token } });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { signOut(); throw new Error('Session expired. Please sign in again.'); }
    if (!res.ok) throw new Error(j.error || 'Request failed.');
    return j;
  }
  const act = async (action, body) => { const j = await api('admin', { method: 'POST', body: JSON.stringify({ action, ...body }) }); S = j.state; return j; };
  const ago = ts => { if (!ts) return null; const s = Math.max(0, (S.now - ts) / 1000); return s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };

  /* ---------- sign in / out ---------- */
  $('#signinForm').addEventListener('submit', async e => {
    e.preventDefault(); const err = $('#aerr'); err.hidden = true;
    try {
      const res = await fetch(API + 'admin-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('#au').value, password: $('#ap').value }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error || 'Sign-in failed.');
      token = j.token; store.set('iubat_admin', token); await start();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });
  function signOut() { token = null; store.del('iubat_admin'); $('#adminApp').hidden = true; $('#signin').hidden = false; $('#ap').value = ''; }
  $('#aout').addEventListener('click', signOut);

  async function start() {
    S = await api('admin');
    $('#signin').hidden = true; $('#adminApp').hidden = false;
    renderBuses(); renderRouteList(); renderNotices(); renderSharing();
    setInterval(async () => { if (!$('#tab-sharing').hidden && !document.hidden) { try { S = await api('admin'); renderSharing(); } catch {} } }, 10000);
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b));
    ['buses', 'routes', 'notices', 'sharing'].forEach(t => { $('#tab-' + t).hidden = b.dataset.tab !== t; });
    if (b.dataset.tab === 'routes') { initMap().then(() => { map.resize(); drawRoute(); }); }
  }));

  /* ---------- Buses ---------- */
  const routeOpts = sel => '<option value="">— No route —</option>' + S.routes.map(r => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  function renderBuses() {
    $('#newBusRoute').innerHTML = routeOpts('');
    $('#busEmpty').hidden = S.buses.length > 0;
    $('#busRows').innerHTML = S.buses.map(b => {
      const seen = ago(b.lastSeen), live = b.lastSeen && S.now - b.lastSeen < 60000;
      return `<tr data-id="${esc(b.id)}">
        <td><input class="no" value="${esc(b.id)}" maxlength="10" aria-label="Bus number"></td>
        <td><select class="rt" aria-label="Route">${routeOpts(b.routeId)}</select></td>
        <td><input class="tm ds" type="time" value="${esc(b.departStart || '')}" aria-label="Leaves start"></td>
        <td><input class="tm dc" type="time" value="${esc(b.departCampus || '')}" aria-label="Leaves campus"></td>
        <td><input class="dy" list="dayPresets" value="${esc(b.days || '')}" maxlength="30" placeholder="Sat–Wed" aria-label="Days"></td>
        <td><span class="seen ${live ? 'on' : ''}"><i></i>${seen ? seen : 'Never'}</span></td>
        <td class="r"><button class="btn ghost-btn sm save" hidden>Save</button><button class="btn ghost-btn sm tok">New token</button><button class="btn ghost-btn sm danger del">Delete</button></td></tr>`;
    }).join('');
  }
  $('#busRows').addEventListener('input', e => { const tr = e.target.closest('tr'); if (tr) tr.querySelector('.save').hidden = false; });
  $('#busRows').addEventListener('change', e => { const tr = e.target.closest('tr'); if (tr) tr.querySelector('.save').hidden = false; });
  $('#busRows').addEventListener('click', async e => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = tr.dataset.id;
    try {
      if (e.target.closest('.save')) {
        await act('saveBus', { id, newId: tr.querySelector('.no').value, routeId: tr.querySelector('.rt').value || null,
          departStart: tr.querySelector('.ds').value, departCampus: tr.querySelector('.dc').value, days: tr.querySelector('.dy').value });
        toast('Bus saved'); renderBuses(); renderRouteList();
      }
      else if (e.target.closest('.tok')) { if (!confirm(`Generate a new tracker token for bus ${id}? The old token will stop working.`)) return; const j = await act('newToken', { id }); showToken(id, j.token); }
      else if (e.target.closest('.del')) { if (!confirm(`Delete bus ${id}? Its tracker token will stop working.`)) return; await act('deleteBus', { id }); toast('Bus deleted'); renderBuses(); renderRouteList(); }
    } catch (x) { toast(x.message, true); }
  });
  $('#addBus').addEventListener('submit', async e => {
    e.preventDefault(); const no = $('#newBusNo').value.trim();
    try { const j = await act('saveBus', { id: null, newId: no, routeId: $('#newBusRoute').value || null }); $('#newBusNo').value = ''; renderBuses(); renderRouteList(); showToken(no, j.token); }
    catch (x) { toast(x.message, true); }
  });
  function showToken(no, t) {
    $('#tokTitle').textContent = `Tracker token · Bus ${no}`;
    $('#tokVal').value = t; $('#tokLink').value = `${location.origin}/tracker/?key=${t}`;
    $('#tokDlg').showModal();
  }
  $('#tokCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#tokLink').value); toast('Link copied'); } catch { $('#tokLink').select(); toast('Press Ctrl+C to copy'); } });

  /* ---------- Sharing ---------- */
  const ST = { verified: ['Verified · in use', 'ok'], backup: ['Verified · standby (bus phone live)', 'ok'], checking: ['Checking movement', 'wait'], paused: ['Paused · not moving', 'wait'],
    weak_gps: ['Weak GPS', 'wait'], off_route: ['Not on route', 'bad'], jump: ['Impossible jump', 'bad'], disagree: ['Does not match other rider', 'bad'] };
  function renderSharing() {
    $('#crowdOn').checked = !!S.crowdEnabled;
    $('#sharerEmpty').hidden = S.sharers.length > 0;
    $('#sharerRows').innerHTML = S.sharers.map(x => {
      const [label, cls] = ST[x.status] || [x.status, 'wait'];
      return `<tr><td><b>${esc(x.studentId)}</b></td><td>Bus ${esc(x.busId)}</td><td class="st-${cls}">${esc(label)}</td><td class="small">${fmtWhen(x.startedAt)}</td><td class="small">${ago(x.lastTs) || ''}</td>
        <td class="r"><button class="btn ghost-btn sm danger" data-block="${esc(x.studentId)}">Block</button></td></tr>`;
    }).join('');
    $('#blockEmpty').hidden = S.blocked.length > 0;
    $('#blockRows').innerHTML = S.blocked.map(x => `<tr><td><b>${esc(x.studentId)}</b></td><td class="small">Blocked ${fmtWhen(x.at)}</td><td class="r"><button class="btn ghost-btn sm" data-unblock="${esc(x.studentId)}">Unblock</button></td></tr>`).join('');
  }
  $('#crowdOn').addEventListener('change', async e => {
    try { await act('setCrowd', { enabled: e.target.checked }); toast(e.target.checked ? 'Student sharing turned on' : 'Student sharing turned off'); renderSharing(); }
    catch (x) { toast(x.message, true); e.target.checked = !e.target.checked; }
  });
  $('#tab-sharing').addEventListener('click', async e => {
    const b = e.target.closest('[data-block]'), u = e.target.closest('[data-unblock]');
    try {
      if (b && confirm(`Block student ${b.dataset.block} from sharing location?`)) { await act('blockSharer', { studentId: b.dataset.block }); toast('Student blocked'); renderSharing(); }
      if (u) { await act('unblockSharer', { studentId: u.dataset.unblock }); toast('Student unblocked'); renderSharing(); }
    } catch (x) { toast(x.message, true); }
  });

  /* ---------- Notices ---------- */
  const fmtWhen = ts => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  function renderNotices() {
    $('#noticeEmpty').hidden = S.notices.length > 0;
    $('#noticeRows').innerHTML = S.notices.map(n => {
      const live = !n.expiresAt || n.expiresAt > S.now;
      return `<tr data-id="${n.id}"><td class="ntext">${esc(n.message)}</td>
        <td><span class="pill ${n.level === 'urgent' ? 'urgent' : 'info'}">${n.level === 'urgent' ? 'Urgent' : 'Notice'}</span></td>
        <td class="small">${fmtWhen(n.createdAt)}</td>
        <td class="small">${live ? (n.expiresAt ? 'Showing until ' + fmtWhen(n.expiresAt) : 'Showing') : 'Expired'}</td>
        <td class="r"><button class="btn ghost-btn sm danger ndel">Delete</button></td></tr>`;
    }).join('');
  }
  $('#nMsg').addEventListener('input', e => { $('#nCount').textContent = `${e.target.value.length} / 500`; });
  $('#noticeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const exp = $('#nExp').value ? new Date($('#nExp').value).getTime() : null;
    try {
      await act('addNotice', { message: $('#nMsg').value, level: $('#nLevel').value, expiresAt: exp });
      $('#nMsg').value = ''; $('#nExp').value = ''; $('#nCount').textContent = '0 / 500';
      toast('Notice published to all apps'); renderNotices();
    } catch (x) { toast(x.message, true); }
  });
  $('#noticeRows').addEventListener('click', async e => {
    const b = e.target.closest('.ndel'); if (!b) return;
    if (!confirm('Delete this notice? It will disappear from all apps.')) return;
    try { await act('deleteNotice', { id: b.closest('tr').dataset.id }); toast('Notice deleted'); renderNotices(); } catch (x) { toast(x.message, true); }
  });

  /* ---------- Routes ---------- */
  function renderRouteList() {
    $('#routeList').innerHTML = S.routes.map(r => {
      const n = S.buses.filter(b => b.routeId === r.id).length;
      return `<li><button data-id="${esc(r.id)}" aria-current="${E && E.id === r.id}"><i style="background:${esc(r.color)}"></i><span>${esc(r.name)}</span><small>${n} bus${n === 1 ? '' : 'es'}</small></button></li>`;
    }).join('') || '<li class="muted small" style="padding:8px">No routes yet.</li>';
  }
  $('#routeList').addEventListener('click', e => {
    const b = e.target.closest('[data-id]'); if (!b) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const r = S.routes.find(x => x.id === b.dataset.id);
    edit({ id: r.id, name: r.name, color: r.color, stops: r.stops.map(s => ({ ...s })) }, true);
  });
  $('#newRoute').addEventListener('click', () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    edit({ id: null, name: '', color: COLORS[S.routes.length % COLORS.length], stops: [] }, false);
  });

  function edit(route, fit) {
    E = route; dirty = false;
    $('#routeForm').hidden = false; $('#routeHint').hidden = true;
    $('#rName').value = E.name; $('#rColor').value = E.color; $('#delRoute').hidden = !E.id; $('#rMsg').textContent = '';
    renderStops(); renderRouteList();
    initMap().then(() => { map.resize(); drawRoute(); if (fit) fitRoute(); });
  }
  $('#rName').addEventListener('input', e => { E.name = e.target.value; dirty = true; });
  $('#rColor').addEventListener('input', e => { E.color = e.target.value; dirty = true; drawRoute(); });

  function renderStops() {
    const n = E.stops.length;
    $('#stopList').innerHTML = E.stops.map((s, i) => `<li data-i="${i}">
        <span class="n">${i + 1}</span><input value="${esc(s.name)}" maxlength="60" aria-label="Stop ${i + 1} name">
        <span class="act"><button data-a="focus" title="Show on map" aria-label="Show on map">&#9678;</button><button data-a="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button><button data-a="down" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button><button data-a="del" aria-label="Delete stop">&times;</button></span></li>`).join('')
      + `<li class="campus"><span class="n">${n + 1}</span><input value="IUBAT Campus (fixed end point)" disabled aria-label="Campus"><span class="act"></span></li>`;
    if (!n) $('#stopList').insertAdjacentHTML('afterbegin', '<li class="muted small" style="grid-template-columns:1fr">No stops yet — click the map to add the starting point.</li>');
  }
  $('#stopList').addEventListener('input', e => { const li = e.target.closest('li[data-i]'); if (li) { E.stops[+li.dataset.i].name = e.target.value; dirty = true; } });
  $('#stopList').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.closest('li').dataset.i, a = b.dataset.a;
    if (a === 'del') E.stops.splice(i, 1);
    else if (a === 'up') [E.stops[i - 1], E.stops[i]] = [E.stops[i], E.stops[i - 1]];
    else if (a === 'down') [E.stops[i + 1], E.stops[i]] = [E.stops[i], E.stops[i + 1]];
    else if (a === 'focus') { map.flyTo({ center: [E.stops[i].lng, E.stops[i].lat], zoom: 15 }); return; }
    dirty = true; renderStops(); drawRoute();
  });

  $('#saveRoute').addEventListener('click', async () => {
    const btn = $('#saveRoute'); btn.disabled = true; btn.textContent = 'Saving…'; $('#rMsg').textContent = '';
    try {
      const j = await act('saveRoute', { route: { id: E.id, name: E.name, color: E.color, stops: E.stops } });
      E.id = j.id; dirty = false; $('#delRoute').hidden = false;
      $('#rMsg').textContent = j.snapped ? `Saved · ${j.km.toFixed(1)} km, snapped to roads` : 'Saved · road service unavailable, drawn as straight lines';
      toast('Route saved'); renderRouteList(); renderBuses(); drawRoute();
    } catch (x) { toast(x.message, true); }
    btn.disabled = false; btn.textContent = 'Save route';
  });
  $('#delRoute').addEventListener('click', async () => {
    const n = S.buses.filter(b => b.routeId === E.id).length;
    if (!confirm(`Delete route "${E.name}"?${n ? ` ${n} bus(es) will be left without a route.` : ''}`)) return;
    try { await act('deleteRoute', { id: E.id }); E = null; dirty = false; $('#routeForm').hidden = true; $('#routeHint').hidden = false; toast('Route deleted'); renderRouteList(); renderBuses(); drawRoute(); }
    catch (x) { toast(x.message, true); }
  });
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- Map ---------- */
  function initMap() {
    if (mapReady) return mapReady;
    map = new maplibregl.Map({ container: 'amap', style: STYLE, center: [S.campus.lng, S.campus.lat], zoom: 11, pitch: 0, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapReady = new Promise(res => map.on('load', () => {
      map.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('saved', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'saved-casing', type: 'line', source: 'saved', paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': .9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({ id: 'saved-line', type: 'line', source: 'saved', paint: { 'line-color': ['get', 'color'], 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 2] } });
      new maplibregl.Marker({ element: pin('★', 'campus') }).setLngLat([S.campus.lng, S.campus.lat]).addTo(map);
      res();
    }));
    map.on('click', e => {
      if (!E) { toast('Select or create a route first'); return; }
      E.stops.push({ name: `Stop ${E.stops.length + 1}`, lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) });
      dirty = true; renderStops(); drawRoute();
      const inp = $('#stopList li[data-i="' + (E.stops.length - 1) + '"] input'); if (inp) { inp.focus(); inp.select(); }
    });
    return mapReady;
  }
  function pin(txt, cls) { const el = document.createElement('div'); el.className = 'a-pin ' + (cls || ''); el.textContent = txt; return el; }

  function drawRoute() {
    if (!map || !map.getSource('draft')) return;
    markers.forEach(m => m.remove()); markers = [];
    if (!E) { map.getSource('draft').setData({ type: 'FeatureCollection', features: [] }); map.getSource('saved').setData({ type: 'FeatureCollection', features: [] }); return; }
    E.stops.forEach((s, i) => {
      const m = new maplibregl.Marker({ element: pin(i + 1), draggable: true }).setLngLat([s.lng, s.lat]).addTo(map);
      m.on('dragend', () => { const p = m.getLngLat(); s.lat = +p.lat.toFixed(6); s.lng = +p.lng.toFixed(6); dirty = true; drawRoute(); });
      markers.push(m);
    });
    const pts = [...E.stops.map(s => [s.lng, s.lat]), [S.campus.lng, S.campus.lat]];
    const saved = E.id && S.routes.find(r => r.id === E.id);
    const showDraft = dirty || !saved; // unsaved edits: dashed straight preview; saved: solid road-snapped line
    map.getSource('draft').setData({ type: 'FeatureCollection', features: showDraft ? [{ type: 'Feature', properties: { color: E.color }, geometry: { type: 'LineString', coordinates: pts } }] : [] });
    map.getSource('saved').setData({ type: 'FeatureCollection', features: saved && !dirty ? [{ type: 'Feature', properties: { color: E.color }, geometry: { type: 'LineString', coordinates: saved.geometry } }] : [] });
  }
  function fitRoute() {
    const pts = [...E.stops.map(s => [s.lng, s.lat]), [S.campus.lng, S.campus.lat]];
    const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
  }

  // Place search (OpenStreetMap Nominatim) — only used while editing routes
  $('#placeSearch').addEventListener('submit', async e => {
    e.preventDefault(); const q = $('#placeQ').value.trim(); if (!q) return;
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=bd&q=' + encodeURIComponent(q));
      const j = await r.json();
      if (!j[0]) return toast('Place not found', true);
      await initMap(); map.flyTo({ center: [+j[0].lon, +j[0].lat], zoom: 15.5 });
    } catch { toast('Search failed. Try again.', true); }
  });

  if (token) start().catch(() => signOut());
})();
