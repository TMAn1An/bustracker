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
    renderBuses(); renderRouteList(); renderNotices(); renderSharing(); renderCalendar(); renderFeedback(); renderSuggestions(); counts();
    setInterval(async () => { if (!$('#tab-sharing').hidden && !document.hidden) { try { S = await api('admin'); renderSharing(); } catch {} } }, 10000);
  }

  /* ---------- tabs ---------- */
  // Phone: the sections and Sign out live in a menu behind the ☰ button
  function toggleMenu(open) {
    const m = $('#topMenu'), on = open ?? !m.classList.contains('open');
    m.classList.toggle('open', on); $('#menuBtn').setAttribute('aria-expanded', on);
  }
  $('#menuBtn').addEventListener('click', () => toggleMenu());
  document.addEventListener('click', e => { if (!e.target.closest('#topMenu, #menuBtn')) toggleMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleMenu(false); });

  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b));
    ['buses', 'routes', 'notices', 'sharing', 'community', 'calendar', 'feedback'].forEach(t => { $('#tab-' + t).hidden = b.dataset.tab !== t; });
    $('#menuLabel').textContent = b.firstChild.textContent.trim(); toggleMenu(false); // phone: show the current section, close the menu
    if (b.dataset.tab === 'routes') { initMap().then(() => { map.resize(); drawRoute(); }); }
    if (b.dataset.tab === 'community') loadCommunity();
  }));

  /* ---------- Buses ---------- */
  const routeOpts = sel => '<option value="">— No route —</option>' + S.routes.map(r => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  // Reminder for admins: which other buses already run a route (sharing a route is fine).
  const busesOn = (routeId, except) => routeId ? S.buses.filter(b => b.routeId === routeId && b.id !== except).map(b => b.id) : [];
  const alsoText = (routeId, except) => { const o = busesOn(routeId, except); return o.length ? `Also on this route: Bus ${o.join(', ')}` : ''; };
  function renderBuses() {
    $('#newBusRoute').innerHTML = routeOpts('');
    $('#busEmpty').hidden = S.buses.length > 0;
    $('#busRows').innerHTML = S.buses.map(b => {
      const seen = ago(b.lastSeen), live = b.lastSeen && S.now - b.lastSeen < 60000;
      return `<tr data-id="${esc(b.id)}">
        <td data-label="Bus no."><input class="no" value="${esc(b.id)}" maxlength="10" aria-label="Bus number"></td>
        <td data-label="Route"><select class="rt" aria-label="Route">${routeOpts(b.routeId)}</select><small class="also">${esc(alsoText(b.routeId, b.id))}</small></td>
        <td data-label="Leaves start"><input class="tm ds" type="time" value="${esc(b.departStart || '')}" aria-label="Leaves start"></td>
        <td data-label="Leaves campus"><input class="tm dc" type="time" value="${esc(b.departCampus || '')}" aria-label="Leaves campus"></td>
        <td data-label="Days"><input class="dy" list="dayPresets" value="${esc(b.days || '')}" maxlength="30" placeholder="Uni days" title="Empty = the university calendar (Calendar tab)" aria-label="Days"></td>
        <td data-label="Last seen"><span class="seen ${live ? 'on' : ''}"><i></i>${seen ? seen : 'Never'}</span></td>
        <td class="r acts"><button class="btn primary sm save" hidden>Save</button><button class="btn ghost-btn sm tok" title="New tracker token for the bus phone (the old one stops working)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>Token</button><button class="btn ghost-btn sm danger del icon" title="Delete bus ${esc(b.id)}" aria-label="Delete bus ${esc(b.id)}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></td></tr>`;
    }).join('');
  }
  $('#busRows').addEventListener('input', e => { const tr = e.target.closest('tr'); if (tr) tr.querySelector('.save').hidden = false; });
  $('#busRows').addEventListener('change', e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    tr.querySelector('.save').hidden = false;
    if (e.target.classList.contains('rt')) tr.querySelector('.also').textContent = alsoText(e.target.value, tr.dataset.id);
  });
  $('#newBusRoute').addEventListener('change', e => { $('#newBusAlso').textContent = alsoText(e.target.value, null); });
  $('#busRows').addEventListener('click', async e => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = tr.dataset.id;
    try {
      if (e.target.closest('.save')) {
        await act('saveBus', { id, newId: tr.querySelector('.no').value, routeId: tr.querySelector('.rt').value || null,
          departStart: tr.querySelector('.ds').value, departCampus: tr.querySelector('.dc').value, days: tr.querySelector('.dy').value });
        const others = busesOn(tr.querySelector('.rt').value, tr.querySelector('.no').value.trim());
        toast(others.length ? `Bus saved. Bus ${others.join(', ')} also runs this route.` : 'Bus saved'); renderBuses(); renderRouteList();
      }
      else if (e.target.closest('.tok')) { if (!confirm(`Generate a new tracker token for bus ${id}? The old token will stop working.`)) return; const j = await act('newToken', { id }); showToken(id, j.token); }
      else if (e.target.closest('.del')) { if (!confirm(`Delete bus ${id}? Its tracker token will stop working.`)) return; await act('deleteBus', { id }); toast('Bus deleted'); renderBuses(); renderRouteList(); }
    } catch (x) { toast(x.message, true); }
  });
  $('#addBus').addEventListener('submit', async e => {
    e.preventDefault(); const no = $('#newBusNo').value.trim();
    try {
      const routeId = $('#newBusRoute').value || null, others = busesOn(routeId, no);
      const j = await act('saveBus', { id: null, newId: no, routeId });
      $('#newBusNo').value = ''; $('#newBusAlso').textContent = ''; renderBuses(); renderRouteList(); showToken(no, j.token);
      if (others.length) toast(`Bus ${no} added. Bus ${others.join(', ')} also runs this route.`);
    }
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
      return `<tr><td><b>${esc(x.username ? '@' + x.username : x.studentId)}</b></td><td>Bus ${esc(x.busId)}</td><td class="st-${cls}">${esc(label)}</td><td class="small">${fmtWhen(x.startedAt)}</td><td class="small">${ago(x.lastTs) || ''}</td>
        <td class="r"><button class="btn ghost-btn sm danger" data-block="${esc(x.studentId)}">Block</button></td></tr>`;
    }).join('');
    $('#blockEmpty').hidden = S.blocked.length > 0;
    const [af, at] = (S.windows?.am || '06:00-12:00').split('-'), [pf, pt] = (S.windows?.pm || '17:00-22:00').split('-');
    if (document.activeElement?.closest('#winForm') == null) { $('#amFrom').value = af; $('#amTo').value = at; $('#pmFrom').value = pf; $('#pmTo').value = pt; }
    $('#blockRows').innerHTML = S.blocked.map(x => `<tr><td><b>${esc(x.username ? '@' + x.username : x.studentId)}</b></td><td class="small">Blocked ${fmtWhen(x.at)}</td><td class="r"><button class="btn ghost-btn sm" data-unblock="${esc(x.studentId)}">Unblock</button></td></tr>`).join('');
  }
  $('#crowdOn').addEventListener('change', async e => {
    try { await act('setCrowd', { enabled: e.target.checked }); toast(e.target.checked ? 'Student sharing turned on' : 'Student sharing turned off'); renderSharing(); }
    catch (x) { toast(x.message, true); e.target.checked = !e.target.checked; }
  });
  $('#tab-sharing').addEventListener('click', async e => {
    const b = e.target.closest('[data-block]'), u = e.target.closest('[data-unblock]');
    try {
      if (b && confirm(`Block this rider from sharing location?`)) { await act('blockSharer', { studentId: b.dataset.block }); toast('Student blocked'); renderSharing(); }
      if (u) { await act('unblockSharer', { studentId: u.dataset.unblock }); toast('Student unblocked'); renderSharing(); }
    } catch (x) { toast(x.message, true); }
  });

  $('#winForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await act('setWindows', { am: `${$('#amFrom').value}-${$('#amTo').value}`, pm: `${$('#pmFrom').value}-${$('#pmTo').value}` }); toast('Sharing hours saved'); renderSharing(); }
    catch (x) { toast(x.message, true); }
  });

  /* ---------- Community ---------- */
  const routeName = id => S.routes.find(r => r.id === id)?.name || '—';
  async function loadCommunity() { try { S = await api('admin?community=1'); renderCommunity(); counts(); } catch (x) { toast(x.message, true); } }
  const cact = async (action, body, msg) => { try { await act(action, { ...body, community: true }); toast(msg); renderCommunity(); renderSharing(); counts(); } catch (x) { toast(x.message, true); } };
  function renderCommunity() {
    if (document.activeElement?.closest('#batchForm') == null) { $('#bMin').value = S.batchRange?.min || ''; $('#bMax').value = S.batchRange?.max || ''; }
    const photos = S.photos || [];
    $('#photoEmpty').hidden = photos.length > 0;
    $('#photoGrid').innerHTML = photos.map(p => `<figure class="ph ${p.hidden ? 'hid' : ''}" data-uid="${esc(p.userId)}"><img src="${esc(p.src)}" alt="">
      <figcaption><b>@${esc(p.username)}</b><small>${p.hidden ? 'Hidden · ' : ''}${p.reports ? `<span class="st-bad">⚠ Reported by ${p.reports}</span>` : 'Uploaded ' + (ago(p.at) || '')}</small>
      <span>${p.hidden || p.reports ? '<button class="btn ghost-btn sm" data-keep>Looks fine</button>' : ''}<button class="btn ghost-btn sm danger" data-rmphoto>Remove</button><button class="btn ghost-btn sm danger" data-banphoto>Remove + ban uploads</button></span></figcaption></figure>`).join('');
    const q = $('#userQ').value.trim().toLowerCase(), users = (S.users || []).filter(u => !q || u.username.toLowerCase().includes(q));
    $('#userEmpty').hidden = users.length > 0;
    $('#userRows').innerHTML = users.slice(0, 150).map(u => `<tr data-uid="${esc(u.id)}"><td>${esc(u.emoji || '')} <b>@${esc(u.username)}</b>${u.batch ? ` <small class="muted">Batch ${u.batch}</small>` : ''}</td>
      <td class="small">${esc(routeName(u.routeId))}</td><td>${u.xp}</td><td class="small">${ago(u.seenAt) || ''}</td>
      <td class="small">${[u.reports ? `<span class="st-bad">${u.reports} report${u.reports > 1 ? 's' : ''}</span>` : '', u.blocked ? '<span class="st-bad">sharing blocked</span>' : '', u.noPhoto ? '<span class="st-wait">no photo uploads</span>' : ''].filter(Boolean).join(' · ')}</td>
      <td class="r"><button class="btn ghost-btn sm" data-rename>Reset name</button>${u.noPhoto ? '<button class="btn ghost-btn sm" data-allowphoto>Allow photos</button>' : '<button class="btn ghost-btn sm danger" data-nophoto>Ban photos</button>'}${u.blocked ? '<button class="btn ghost-btn sm" data-ublock>Unblock</button>' : '<button class="btn ghost-btn sm danger" data-ublockit>Block sharing</button>'}</td></tr>`).join('');
    const tr = S.treats || [];
    $('#treatEmpty').hidden = tr.length > 0;
    const TS = { pending: ['Waiting for treat', 'wait'], paid: ['Treat given', 'ok'], vouched: ['Confirmed by riders', 'ok'], cancelled: ['Cancelled', 'bad'] };
    $('#treatRows').innerHTML = tr.map(t => `<tr data-tid="${t.id}"><td class="small">${esc(t.week)}</td><td>${esc(routeName(t.routeId))}</td><td><b>@${esc(t.champion || '?')}</b></td>
      <td class="small st-${(TS[t.status] || [])[1] || 'wait'}">${esc((TS[t.status] || [t.status])[0])}${t.giver ? ` by @${esc(t.giver)}` : ''}${t.status === 'pending' && t.votes ? ` · ${t.votes} rider confirmations` : ''}</td>
      <td class="r">${t.status === 'pending' ? '<button class="btn ghost-btn sm" data-settle="paid">Mark given</button><button class="btn ghost-btn sm danger" data-settle="cancelled">Cancel</button>' : '<button class="btn ghost-btn sm" data-settle="pending">Reopen</button>'}</td></tr>`).join('');
  }
  $('#userQ').addEventListener('input', renderCommunity);
  $('#batchForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await act('setBatchRange', { min: $('#bMin').value.trim(), max: $('#bMax').value.trim() }); toast('Batch range saved'); } catch (x) { toast(x.message, true); }
  });
  $('#tab-community').addEventListener('click', e => {
    const uid = e.target.closest('[data-uid]')?.dataset.uid, tid = e.target.closest('[data-tid]')?.dataset.tid, has = s => e.target.closest(s);
    if (has('[data-keep]')) return cact('keepPhoto', { userId: uid }, 'Photo kept');
    if (has('[data-rmphoto]')) return cact('removePhoto', { userId: uid }, 'Photo removed');
    if (has('[data-banphoto]')) { if (confirm('Remove this photo and stop this rider from uploading photos?')) cact('removePhoto', { userId: uid, ban: true }, 'Photo removed, uploads banned'); return; }
    if (has('[data-nophoto]')) return cact('removePhoto', { userId: uid, ban: true }, 'Photo uploads banned');
    if (has('[data-allowphoto]')) return cact('setPhotoBan', { userId: uid, ban: false }, 'Photo uploads allowed');
    if (has('[data-rename]')) { if (confirm('Replace this username with a random one (e.g. rider_3fa9c1)? The rider can pick a new name.')) cact('renameUser', { userId: uid }, 'Username reset'); return; }
    if (has('[data-ublockit]')) { if (confirm('Block this rider from sharing location? They also disappear from leaderboards.')) cact('blockSharer', { studentId: uid }, 'Sharing blocked'); return; }
    if (has('[data-ublock]')) return cact('unblockSharer', { studentId: uid }, 'Unblocked');
    const st = has('[data-settle]'); if (st) return cact('settleTreat', { id: tid, status: st.dataset.settle }, 'Treat updated');
  });

  /* ---------- stops suggested by riders ---------- */
  let sugMarker = null;
  const hhmm12 = v => { if (!v) return '—'; const [h, m] = v.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  function renderSuggestions() {
    const all = S.suggestions || [], pend = all.filter(g => g.status === 'pending'), done = all.filter(g => g.status !== 'pending');
    $('#sugBox').hidden = !all.length;
    $('#sugN').hidden = !pend.length; $('#sugN').textContent = pend.length;
    $('#sugList').innerHTML = pend.length ? pend.map(g => { const r = S.routes.find(x => x.id === g.routeId);
      return `<div class="sug" data-sid="${g.id}" style="--rc:${esc(r?.color || '#999')}">
        <div class="sug-main"><i></i><div><input class="sug-name" value="${esc(g.name)}" maxlength="60" aria-label="Stop name">
          <small>${esc(r?.name || 'Unknown route')} · by ${g.username ? '@' + esc(g.username) : 'a rider'} · ${fmtWhen(g.createdAt)}</small>
          <small>${g.between?.[0] && g.between?.[1] ? `Between <b>${esc(g.between[0])}</b> and <b>${esc(g.between[1])}</b> · ` : ''}${g.km} km to campus · ☀️ ~${hhmm12(g.am)} · 🌙 ~${hhmm12(g.pm)}${g.off > 300 ? ` · <span class="st-bad">${g.off} m off the route</span>` : ''}</small>
          ${g.note ? `<small class="sug-note">“${esc(g.note)}”</small>` : ''}</div></div>
        <div class="sug-act"><input class="sug-time" type="time" title="Pick-up time (optional; empty = estimated automatically)" aria-label="Pick-up time">
          <button class="btn ghost-btn sm" data-sg="map">Show</button><button class="btn ghost-btn sm" data-sg="edit">Edit first</button>
          <button class="btn primary sm" data-sg="ok">Approve</button><button class="btn ghost-btn sm danger" data-sg="no">Reject</button></div></div>`; }).join('')
      : '<p class="muted small" style="margin:6px 0">No new suggestions.</p>';
    $('#sugDone').hidden = !done.length;
    $('#sugDoneList').innerHTML = done.slice(0, 30).map(g => `<li>${g.status === 'approved' ? '✅' : '✖️'} <b>${esc(g.name)}</b> · ${esc(S.routes.find(x => x.id === g.routeId)?.name || '')}${g.adminNote ? ` · “${esc(g.adminNote)}”` : ''}</li>`).join('');
  }
  $('#sugList').addEventListener('click', async e => {
    const b = e.target.closest('[data-sg]'); if (!b) return;
    const box = b.closest('[data-sid]'), g = S.suggestions.find(x => x.id === +box.dataset.sid), name = box.querySelector('.sug-name').value.trim(), time = box.querySelector('.sug-time').value;
    try {
      if (b.dataset.sg === 'map' || b.dataset.sg === 'edit') {
        const r = S.routes.find(x => x.id === g.routeId); if (!r) return toast('The route no longer exists.', true);
        if (dirty && !confirm('Discard unsaved changes?')) return;
        edit({ id: r.id, name: r.name, color: r.color, stops: r.stops.map(({ approx, ...s }) => ({ ...s, ...(approx ? { auto: true } : {}) })) }, false);
        await initMap();
        if (b.dataset.sg === 'edit') { E.suggestionId = g.id; addStop({ name: name || g.name, lat: g.lat, lng: g.lng, ...(time ? { time } : {}) }, 'smart'); toast('Added to the stop list: drag it, rename it, then Save route.'); }
        else { sugMarker?.remove(); const el = document.createElement('div'); el.className = 'a-pin sugpin'; el.textContent = '?'; sugMarker = new maplibregl.Marker({ element: el }).setLngLat([g.lng, g.lat]).addTo(map); }
        map.flyTo({ center: [g.lng, g.lat], zoom: 15 }); $('.a-mapbox').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (b.dataset.sg === 'ok') {
        if (!confirm(`Add "${name}" to ${S.routes.find(x => x.id === g.routeId)?.name}?`)) return;
        const j = await act('approveSuggestion', { id: g.id, name, time: time || null });
        toast(`Added as stop ${j.position} on ${j.routeName}${j.snapped ? '' : ' (road service unavailable: straight lines)'}`);
      } else {
        const why = prompt('Reason (optional, the rider sees it):', ''); if (why === null) return;
        await act('rejectSuggestion', { id: g.id, note: why }); toast('Suggestion rejected');
      }
      sugMarker?.remove(); renderSuggestions(); renderRouteList(); if (E && E.id === g.routeId) { const r = S.routes.find(x => x.id === E.id); edit({ id: r.id, name: r.name, color: r.color, stops: r.stops.map(({ approx, ...s }) => ({ ...s, ...(approx ? { auto: true } : {}) })) }, false); }
    } catch (x) { toast(x.message, true); }
  });

  /* ---------- tab counters ---------- */
  function counts() {
    const rep = (S.users || []).filter(u => u.reports).length, fb = (S.feedback || []).filter(f => f.status === 'new').length;
    $('#repN').hidden = !rep; $('#repN').textContent = rep; $('#fbN').hidden = !fb; $('#fbN').textContent = fb;
    $('#pushN').textContent = S.push ? `${S.push.subscribers} phone${S.push.subscribers === 1 ? '' : 's'} have push notifications on.` : '';
  }

  /* ---------- Calendar ---------- */
  const DOW = [[6, 'Sat'], [0, 'Sun'], [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri']];
  const dateTxt = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  function renderCalendar() {
    const c = S.calendar || { openDays: [6, 0, 1, 2, 3], special: {} };
    $('#openDays').innerHTML = DOW.map(([n, l]) => `<label class="daybox"><input type="checkbox" value="${n}" ${c.openDays.includes(n) ? 'checked' : ''}><span>${l}</span></label>`).join('');
    const sp = Object.entries(c.special).filter(([d]) => d >= S.today).sort();
    $('#specEmpty').hidden = sp.length > 0;
    $('#specRows').innerHTML = sp.map(([d, x]) => `<tr data-day="${esc(d)}"><td><b>${dateTxt(d)}</b></td><td class="${x.open ? 'st-ok' : 'st-bad'}">${x.open ? 'Open (buses run)' : 'Closed (no buses)'}</td><td>${esc(x.note || '')}</td>
      <td class="r"><button class="btn ghost-btn sm danger" data-delday>Remove</button></td></tr>`).join('');
    const b = S.boost;
    $('#boNow').textContent = b ? `Active / planned: ${b.label} · ${b.mult}× · ${dateTxt(b.from)} → ${dateTxt(b.to)}` : 'No boost planned.';
    if (b && !$('#boFrom').value) { $('#boFrom').value = b.from; $('#boTo').value = b.to; $('#boMult').value = String(b.mult); $('#boLabel').value = b.label; }
  }
  $('#saveDays').addEventListener('click', async () => {
    const days = [...document.querySelectorAll('#openDays input:checked')].map(x => Number(x.value));
    try { await act('setOpenDays', { days }); toast('Normal week saved'); renderCalendar(); } catch (x) { toast(x.message, true); }
  });
  $('#specForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await act('setSpecialDay', { day: $('#spDay').value, open: $('#spOpen').value === '1', note: $('#spNote').value }); $('#spNote').value = ''; toast('Special day saved'); renderCalendar(); }
    catch (x) { toast(x.message, true); }
  });
  $('#specRows').addEventListener('click', async e => {
    if (!e.target.closest('[data-delday]')) return;
    try { await act('deleteSpecialDay', { day: e.target.closest('tr').dataset.day }); toast('Removed'); renderCalendar(); } catch (x) { toast(x.message, true); }
  });
  $('#boostForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await act('setBoost', { from: $('#boFrom').value, to: $('#boTo').value, mult: Number($('#boMult').value), label: $('#boLabel').value }); toast('XP boost saved'); renderCalendar(); }
    catch (x) { toast(x.message, true); }
  });
  $('#boClear').addEventListener('click', async () => {
    try { await act('clearBoost'); ['#boFrom', '#boTo', '#boLabel'].forEach(s => ($(s).value = '')); toast('Boost removed'); renderCalendar(); } catch (x) { toast(x.message, true); }
  });

  /* ---------- Feedback ---------- */
  const KIND = { bus: '🚌 Bus', driver: '🧑‍✈️ Driver / staff', schedule: '🕒 Schedule', app: '📱 App', idea: '💡 Idea', other: '💬 Other' };
  function renderFeedback() {
    const keep = $('#fbRoute').value;
    $('#fbRoute').innerHTML = '<option value="">All routes</option><option value="-">No route</option>' + S.routes.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    $('#fbRoute').value = keep;
    const rf = $('#fbRoute').value, sf = $('#fbStatus').value;
    const list = (S.feedback || []).filter(f => (!rf || (rf === '-' ? !f.routeId : f.routeId === rf)) && (!sf || f.status === sf));
    $('#fbEmpty').hidden = list.length > 0;
    $('#fbList').innerHTML = list.map(f => `<article class="a-card fb ${f.status}" data-fid="${f.id}">
      <div class="fb-top"><span class="pill info">${esc(routeName(f.routeId) === '—' ? 'No route' : routeName(f.routeId))}</span><span class="small">${KIND[f.kind] || esc(f.kind)}</span>
        <span class="small muted">${fmtWhen(f.createdAt)} · ${f.username ? '@' + esc(f.username) : 'anonymous'}${f.contact ? ' · ' + esc(f.contact) : ''}</span></div>
      <p class="ntext">${esc(f.message)}</p>
      ${f.attachments.length ? `<p class="small">📎 ${f.attachments.length} attachment(s)</p>` : ''}
      <div class="a-row end">${['new', 'seen', 'done'].map(s => `<button class="btn ghost-btn sm ${f.status === s ? 'cur' : ''}" data-fst="${s}">${{ new: 'New', seen: 'Seen', done: 'Done ✓' }[s]}</button>`).join('')}</div></article>`).join('');
    counts();
  }
  $('#fbRoute').addEventListener('change', renderFeedback); $('#fbStatus').addEventListener('change', renderFeedback);
  $('#fbList').addEventListener('click', async e => {
    const b = e.target.closest('[data-fst]'); if (!b) return;
    try { await act('setFeedback', { id: b.closest('[data-fid]').dataset.fid, status: b.dataset.fst }); renderFeedback(); } catch (x) { toast(x.message, true); }
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
      if ($('#nPush').checked && $('#nLevel').value !== 'urgent') { toast('Push is only for urgent notices. Set Type to Urgent, or untick push.', true); return; }
      const j = await act('addNotice', { message: $('#nMsg').value, level: $('#nLevel').value, expiresAt: exp, push: $('#nPush').checked });
      $('#nMsg').value = ''; $('#nExp').value = ''; $('#nCount').textContent = '0 / 500'; $('#nPush').checked = false;
      toast(j.pushed != null ? `Notice published; push going to ${j.pushed} phone${j.pushed === 1 ? '' : 's'}` : 'Notice published to all apps'); renderNotices();
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
      const ids = busesOn(r.id, null);
      return `<li><button data-id="${esc(r.id)}" aria-current="${E && E.id === r.id}"><i style="background:${esc(r.color)}"></i><span>${esc(r.name)}</span><small>${ids.length ? 'Bus ' + ids.map(esc).join(', ') : 'No bus'}</small></button></li>`;
    }).join('') || '<li class="muted small" style="padding:8px">No routes yet.</li>';
  }
  $('#routeList').addEventListener('click', e => {
    const b = e.target.closest('[data-id]'); if (!b) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const r = S.routes.find(x => x.id === b.dataset.id);
    edit({ id: r.id, name: r.name, color: r.color, stops: r.stops.map(({ approx, ...s }) => ({ ...s, ...(approx ? { auto: true } : {}) })) }, true);
  });
  $('#newRoute').addEventListener('click', () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    edit({ id: null, name: '', color: COLORS[S.routes.length % COLORS.length], stops: [] }, false);
  });

  function edit(route, fit) {
    E = route; dirty = false; placing = null; $('#placing').hidden = true;
    $('#routeForm').hidden = false; $('#routeHint').hidden = true;
    $('#rName').value = E.name; $('#rColor').value = E.color; $('#delRoute').hidden = !E.id; $('#rMsg').textContent = '';
    const on = busesOn(E.id, null); $('#rBuses').textContent = E.id ? (on.length ? `Buses on this route: ${on.join(', ')}` : 'No bus is assigned to this route yet (assign one in Buses).') : '';
    renderStops(); renderRouteList();
    initMap().then(() => { map.resize(); drawRoute(); if (fit) fitRoute(); });
  }
  $('#rName').addEventListener('input', e => { E.name = e.target.value; dirty = true; });
  $('#rColor').addEventListener('input', e => { E.color = e.target.value; dirty = true; drawRoute(); });

  let placing = null; // index of the stop waiting for a map click
  // Where a stop added from the map / search goes: 'smart' (least detour), 'start' (new first stop) or 'end' (just before campus)
  let addMode = 'smart';
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 102 * Math.cos(a.lat * Math.PI / 180) / Math.cos(23.8 * Math.PI / 180));
  /** Index where a new stop adds the least extra distance. Before the first stop = the route is extended at its start. */
  function bestIndex(p) {
    const pts = [...E.stops.filter(hasPos), S.campus];
    if (pts.length === 1) return 0;
    let best = 0, cost = km(p, pts[0]) * 1.15 + (km(p, S.campus) < km(pts[0], S.campus) ? 50 : 0); // extend the start (only if p is farther out)
    for (let i = 1; i < pts.length; i++) {
      const c = km(pts[i - 1], p) + km(p, pts[i]) - km(pts[i - 1], pts[i]);
      if (c < cost) { cost = c; best = i; }
    }
    // map back to an index in E.stops (stops without a location keep their place)
    const placed = E.stops.map((s, i) => (hasPos(s) ? i : -1)).filter(i => i >= 0);
    return best >= placed.length ? E.stops.length : placed[best];
  }
  function addStop(stop, how = addMode) {
    const i = how === 'start' ? 0 : how === 'end' ? E.stops.length : bestIndex(stop);
    E.stops.splice(i, 0, stop); dirty = true;
    if (addMode === 'start') setMode('smart'); // "Extend start" is for one click
    renderStops(); drawRoute();
    toast(i === 0 && E.stops.length > 1 ? `"${stop.name}" is now the first stop: the route starts further out. Save to apply.` : `Added as stop ${i + 1}. Drag the marker to adjust.`);
    return i;
  }
  function setMode(m) { addMode = m; document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-checked', b.dataset.mode === m)); }
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { setMode(b.dataset.mode); if (b.dataset.mode === 'start') toast('Click the map where the route should now start.'); }));
  $('#shortenStart').addEventListener('click', () => {
    if (!E || E.stops.length < 2) return toast('A route needs at least one stop besides campus.', true);
    if (!confirm(`Shorten the route: remove the first stop "${E.stops[0].name}"? The route will start at "${E.stops[1].name}".`)) return;
    E.stops.shift(); dirty = true; setPlacing(null); renderStops(); drawRoute(); toast('First stop removed. Save to apply.');
  });
  function setPlacing(i) {
    placing = i;
    const el = $('#placing');
    el.hidden = i === null; if (i !== null) el.textContent = `Click the map to place stop ${i + 1} "${E.stops[i].name}"`;
    if (map) map.getCanvas().style.cursor = i === null ? '' : 'crosshair';
  }
  const hasPos = s => s.lat != null && s.lng != null;
  function renderStops() {
    const n = E.stops.length;
    $('#stopList').innerHTML = E.stops.map((s, i) => {
      const flag = !hasPos(s) ? '<span class="flag bad" title="Not on the map yet">No location</span>' : s.auto ? '<span class="flag wait" title="Found automatically: check the marker">Check</span>' : '';
      return `<li data-i="${i}" class="${placing === i ? 'placing' : ''}${i === 0 ? ' first' : ''}">
        <span class="n ${!hasPos(s) ? 'miss' : s.auto ? 'auto' : ''}" title="${i === 0 ? 'Start of the route' : ''}">${i === 0 ? 'S' : i + 1}</span>
        <span class="nm-wrap"><input class="nm" value="${esc(s.name)}" maxlength="60" aria-label="Stop ${i + 1} name">${flag}</span>
        <input class="tm" type="time" value="${esc(s.time || '')}" aria-label="Stop ${i + 1} pick-up time">
        <span class="act"><button data-a="place" title="Place on map" aria-label="Place on map">&#128205;</button><button data-a="focus" title="Show on map" aria-label="Show on map" ${hasPos(s) ? '' : 'disabled'}>&#9678;</button><button data-a="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button><button data-a="down" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button><button data-a="del" aria-label="Delete stop">&times;</button></span></li>`;
    }).join('')
      + `<li class="campus"><span class="n">${n + 1}</span><span class="nm-wrap"><input value="IUBAT Campus (fixed end point)" disabled aria-label="Campus"></span><span></span><span class="act"></span></li>`;
    if (!n) $('#stopList').insertAdjacentHTML('afterbegin', '<li class="muted small" style="display:block">No stops yet. Click the map, search a place, or use Add stops in bulk.</li>');
    const saved = E.id && S.routes.find(r => r.id === E.id);
    let len = 0; if (saved && !dirty) for (let k = 1; k < saved.geometry.length; k++) len += km({ lat: saved.geometry[k - 1][1], lng: saved.geometry[k - 1][0] }, { lat: saved.geometry[k][1], lng: saved.geometry[k][0] });
    $('#routeLen').textContent = n ? `Starts at "${E.stops[0].name}"${len ? ` · about ${len.toFixed(1)} km by road` : dirty ? ' · unsaved changes' : ''}` : '';
  }
  $('#stopList').addEventListener('input', e => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const st = E.stops[+li.dataset.i];
    if (e.target.classList.contains('nm')) st.name = e.target.value; else if (e.target.classList.contains('tm')) st.time = e.target.value;
    dirty = true;
  });
  $('#stopList').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.closest('li').dataset.i, a = b.dataset.a;
    if (a === 'place') {
      setPlacing(placing === i ? null : i); renderStops();
      if (placing !== null) $('.a-mapbox').scrollIntoView({ behavior: 'smooth', block: 'center' }); // the map is below a long stop list
      return;
    }
    if (a === 'focus') { $('.a-mapbox').scrollIntoView({ behavior: 'smooth', block: 'center' }); map.flyTo({ center: [E.stops[i].lng, E.stops[i].lat], zoom: 15.5 }); return; }
    if (a === 'del') E.stops.splice(i, 1);
    else if (a === 'up') [E.stops[i - 1], E.stops[i]] = [E.stops[i], E.stops[i - 1]];
    else if (a === 'down') [E.stops[i + 1], E.stops[i]] = [E.stops[i], E.stops[i + 1]];
    setPlacing(null); dirty = true; renderStops(); drawRoute();
  });

  /* ---- bulk add: paste the stop list, then look each stop up near the route ---- */
  function parseStops(text) {
    const out = [];
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/^\s*\d{1,3}[.)\-\s]+(?=\D)/, '').trim();   // drop a leading serial number like "01" or "1."
      if (!line) continue;
      let time = '';
      const m = line.match(/[\s,|\-–]*(\d{1,2})[:.](\d{2})\s*([ap])\.?\s*m\.?\s*$/i) || line.match(/[\s,|\-–]*(\d{1,2})[:.](\d{2})\s*$/);
      if (m) {
        let h = +m[1]; const mi = +m[2], ap = (m[3] || '').toLowerCase();
        if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
        if (h < 24 && mi < 60) { time = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0'); line = line.slice(0, m.index).trim(); }
      }
      line = line.replace(/[\s,|\-–]+$/, '');
      if (!line || /^(iubat\s*)?campus$/i.test(line)) continue;    // campus is the fixed end point
      out.push({ name: line.slice(0, 60), time, lat: null, lng: null });
    }
    return out;
  }
  function searchBox() {
    const saved = E.id && S.routes.find(r => r.id === E.id);
    const pts = [[S.campus.lng, S.campus.lat], ...E.stops.filter(hasPos).map(s => [s.lng, s.lat]), ...(saved ? saved.geometry : [])];
    let [w, so, e, n] = [180, 90, -180, -90];
    for (const [x, y] of pts) { w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y); }
    const pad = pts.length > 2 ? 0.04 : 0.35; // only the campus known: search a wide area around it
    return [w - pad, n + pad, e + pad, so - pad].map(v => v.toFixed(4)).join(',');
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Common Bangla-English spelling variants seen in stop names, to give OpenStreetMap search a better chance.
  const SPELL = [[/chowr?astha|chourastha|chourasta|chorasta|chowrasta/gi, 'Chowrasta'], [/purabari/gi, 'Porabari'], [/\bmor\b/gi, 'More'],
    [/bazaar/gi, 'Bazar'], [/\bbr?idge\b/gi, 'Bridge'], [/\s*&\s*/g, ' and ']];
  function variants(name) {
    const out = [name];
    let v = name; for (const [re, to] of SPELL) v = v.replace(re, to);
    if (v !== name) out.push(v);
    const short = v.replace(/\s+(bridge|more|bus stop|stand|stoppage)$/i, '').trim();  // "Salna Bridge" -> "Salna" (area)
    if (short !== v && short.length >= 4) out.push(short);
    return out;
  }
  async function geocode(name, box) {
    for (const q of variants(name)) {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=bd&bounded=1&viewbox=' + box + '&q=' + encodeURIComponent(q));
      const j = await r.json();
      if (j[0]) return { lat: +(+j[0].lat).toFixed(6), lng: +(+j[0].lon).toFixed(6) };
      await sleep(1100); // about one request per second (OpenStreetMap search policy)
    }
    return null;
  }
  async function locateMissing() {
    const todo = E.stops.filter(s => !hasPos(s));
    if (!todo.length) return;
    const box = searchBox(); let found = 0;
    for (let k = 0; k < todo.length; k++) {
      $('#rMsg').textContent = `Looking up stops on the map… ${k + 1} / ${todo.length}`;
      try { const p = await geocode(todo[k].name, box); if (p) { Object.assign(todo[k], p, { auto: true }); found++; } } catch { /* leave it unplaced */ }
      renderStops(); drawRoute();
      await sleep(1100); // OpenStreetMap's search service allows about one request per second
    }
    const missing = todo.length - found;
    $('#rMsg').textContent = `${found} of ${todo.length} stops found. ${missing ? `${missing} not found: use 📍 Place and click the map.` : ''} Check every marker, then Save.`;
    fitRoute();
  }
  $('#bulkBtn').addEventListener('click', () => { $('#bulkText').value = ''; $('#bulkDlg').returnValue = ''; $('#bulkDlg').showModal(); });
  $('#bulkDlg').addEventListener('close', async () => {
    if ($('#bulkDlg').returnValue !== 'yes') return;
    const list = parseStops($('#bulkText').value);
    if (!list.length) return toast('No stops found in the text', true);
    E.stops.push(...list); dirty = true; renderStops();
    await initMap(); await locateMissing();
  });

  $('#saveRoute').addEventListener('click', async () => {
    const miss = E.stops.findIndex(x => !hasPos(x));
    if (miss >= 0) { toast(`Stop ${miss + 1} "${E.stops[miss].name}" has no location yet. Use 📍 Place and click the map.`, true); return; }
    const btn = $('#saveRoute'); btn.disabled = true; btn.textContent = 'Saving…'; $('#rMsg').textContent = '';
    try {
      // "approx" keeps the Check flag for stops whose position was found automatically and not yet confirmed
      const stops = E.stops.map(({ name, lat, lng, time, auto }) => ({ name, lat, lng, ...(time ? { time } : {}), ...(auto ? { approx: true } : {}) }));
      const j = await act('saveRoute', { route: { id: E.id, name: E.name, color: E.color, stops } });
      renderStops();
      E.id = j.id; dirty = false; $('#delRoute').hidden = false;
      $('#rMsg').textContent = j.snapped ? `Saved · ${j.km.toFixed(1)} km, snapped to roads` : 'Saved · road service unavailable, drawn as straight lines';
      if (j.warn) { $('#rMsg').textContent += ' · Check: ' + j.warn; toast(j.warn, true); }
      toast('Route saved'); renderRouteList(); renderBuses(); drawRoute();
      if (E.suggestionId) { const sid = E.suggestionId; E.suggestionId = null; await act('markSuggestion', { id: sid, status: 'approved' }); renderSuggestions(); toast('Route saved · suggestion marked as added'); }
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
      if (placing !== null && E.stops[placing]) {
        const done = placing;
        Object.assign(E.stops[done], { lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) }); delete E.stops[done].auto;
        setPlacing(null); dirty = true; renderStops(); drawRoute();
        toast(`Stop ${done + 1} placed. Drag the marker to adjust.`);
        const row = $(`#stopList li[data-i="${done}"]`); if (row) setTimeout(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }), 600);
        return;
      }
      const i = addStop({ name: addMode === 'start' ? 'New start' : `Stop ${E.stops.length + 1}`, lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) });
      const inp = $('#stopList li[data-i="' + i + '"] input.nm'); if (inp) { inp.focus(); inp.select(); }
    });
    return mapReady;
  }
  function pin(txt, cls) { const el = document.createElement('div'); el.className = 'a-pin ' + (cls || ''); el.textContent = txt; return el; }

  function drawRoute() {
    if (!map || !map.getSource('draft')) return;
    markers.forEach(m => m.remove()); markers = [];
    if (!E) { map.getSource('draft').setData({ type: 'FeatureCollection', features: [] }); map.getSource('saved').setData({ type: 'FeatureCollection', features: [] }); return; }
    E.stops.forEach((s, i) => {
      if (!hasPos(s)) return;
      const m = new maplibregl.Marker({ element: pin(i === 0 ? 'START' : i + 1, (s.auto ? 'auto ' : '') + (i === 0 ? 'start' : '')), draggable: true }).setLngLat([s.lng, s.lat]).addTo(map);
      m.on('dragend', () => { const p = m.getLngLat(); s.lat = +p.lat.toFixed(6); s.lng = +p.lng.toFixed(6); delete s.auto; dirty = true; renderStops(); drawRoute(); });
      markers.push(m);
    });
    const pts = [...E.stops.filter(hasPos).map(s => [s.lng, s.lat]), [S.campus.lng, S.campus.lat]];
    const saved = E.id && S.routes.find(r => r.id === E.id);
    const showDraft = dirty || !saved; // unsaved edits: dashed straight preview; saved: solid road-snapped line
    map.getSource('draft').setData({ type: 'FeatureCollection', features: showDraft ? [{ type: 'Feature', properties: { color: E.color }, geometry: { type: 'LineString', coordinates: pts } }] : [] });
    map.getSource('saved').setData({ type: 'FeatureCollection', features: saved && !dirty ? [{ type: 'Feature', properties: { color: E.color }, geometry: { type: 'LineString', coordinates: saved.geometry } }] : [] });
  }
  function fitRoute() {
    const pts = [...E.stops.filter(hasPos).map(s => [s.lng, s.lat]), [S.campus.lng, S.campus.lat]];
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
      await initMap(); const at = [+j[0].lon, +j[0].lat]; map.flyTo({ center: at, zoom: 15.5 });
      if (E) {
        const box = document.createElement('div'); box.className = 'a-pop';
        box.innerHTML = `<b>${esc(j[0].display_name.split(',').slice(0, 2).join(','))}</b><button class="btn primary sm" data-how="smart">Add “${esc(q)}” as a stop</button><button class="btn ghost-btn sm" data-how="start">Make it the new start</button>`;
        const pop = new maplibregl.Popup({ closeOnClick: true, maxWidth: '260px' }).setLngLat(at).setDOMContent(box).addTo(map);
        box.querySelectorAll('button').forEach(b => (b.onclick = () => { addStop({ name: q.slice(0, 60), lat: +at[1].toFixed(6), lng: +at[0].toFixed(6) }, b.dataset.how); pop.remove(); }));
      }
    } catch { toast('Search failed. Try again.', true); }
  });

  if (token) start().catch(() => signOut());
})();
