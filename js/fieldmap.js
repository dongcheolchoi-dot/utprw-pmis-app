/* U-Tapao PMIS Mobile — 현장 지도: 내 위치·작업구역 + 검측원 위치 공유 (2026-11-20)
 * - 서버: updateFieldLocation / getFieldMap / getZoneDetail (Code_Core.js handleMobileAppApi_ → Code_Map.js)
 * - 위치 전송은 '위치 공유' 토글이 켜져 있을 때만 (서버도 출근 중 또는 공유 ON 일 때만 기록)
 * - GPS 권한 거부·실내 음영·시간 초과 시 안내만 하고 화면은 계속 동작
 * - 오프라인: 마지막으로 받은 지도(구역·인력)를 IndexedDB 에서 표시
 */
(function (global) {
  const SHARE_KEY = 'pmis_mobile_share_loc_v1';
  const WORK_LOC_KEY = 'pmis_mobile_work_loc_v1';
  const AUTO_INTERVAL_MS = 5 * 60 * 1000;
  const GPS_TIMEOUT_MS = 12000;
  const CACHE_KEY = 'fieldmap_v1';

  const st = {
    map: null,
    layers: {},
    data: null,
    myPos: null,          // { lat, lng, accuracy, at }
    shareOn: false,
    autoTimer: null,
    showPeople: true,
    loading: false,
    selected: null        // { type: 'zone'|'person', id }
  };

  // ───────── 공통 ─────────
  function T(k) { return global.PMIS_I18N.t(k); }
  function TF(k, p) { return global.PMIS_I18N.tf(k, p); }
  function toast(msg, type) { if (global.PMIS_APP) global.PMIS_APP.toast(msg, type); }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function shortZone(z) { return String(z || '').replace(/UTP-CB-/g, '').replace(/_/g, '/'); }   // UTP-CB-SP5_UTP-CB-SP1 → SP5/SP1
  function ageText(min) { return (min === null || min === undefined || min < 1) ? T('fm_just_now') : TF('fm_minutes_ago', { m: min }); }

  function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }
  function zoneAt(lat, lng) {
    if (!st.data || !Array.isArray(st.data.zones)) return null;
    let hit = null;
    st.data.zones.forEach((z) => {
      const g = z.geometry;
      if (!g) return;
      const rings = g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [g.coordinates[0]];
      if (rings.some((r) => pointInRing(lat, lng, r))) {
        const isMulti = g.type === 'MultiPolygon';
        if (!hit || (hit._multi && !isMulti)) hit = Object.assign({ _multi: isMulti }, z);   // 하위 블록 우선
      }
    });
    return hit;
  }

  // ───────── GPS (멈추지 않는 위치 취득) ─────────
  function acquirePosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve({ error: 'unavailable' }); return; }
      let done = false;
      const guard = setTimeout(() => { if (!done) { done = true; resolve({ error: 'timeout' }); } }, GPS_TIMEOUT_MS + 2000);
      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (done) return;
            done = true; clearTimeout(guard);
            resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() });
          },
          (err) => {
            if (done) return;
            done = true; clearTimeout(guard);
            resolve({ error: err && err.code === 1 ? 'denied' : (err && err.code === 3 ? 'timeout' : 'unavailable') });
          },
          { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30000 }
        );
      } catch (e) {
        done = true; clearTimeout(guard);
        resolve({ error: 'unavailable' });
      }
    });
  }
  function gpsErrorText(code) {
    if (code === 'denied') return T('fm_gps_denied');
    if (code === 'timeout') return T('fm_gps_timeout');
    return T('fm_gps_unavailable');
  }

  // ───────── 지도 준비 ─────────
  function ensureMap() {
    if (st.map) return true;
    const el = document.getElementById('fmMapCanvas');
    if (!el) return false;
    if (!global.L) {
      showBanner(T('fm_err_leaflet'));
      return false;
    }
    const L = global.L;
    st.map = L.map(el, { zoomControl: true, attributionControl: false }).setView([12.681, 101.0125], 14);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(st.map);
    st.layers.zones = L.layerGroup().addTo(st.map);
    st.layers.trail = L.layerGroup().addTo(st.map);
    st.layers.people = L.layerGroup().addTo(st.map);
    st.layers.me = L.layerGroup().addTo(st.map);
    return true;
  }

  function showBanner(text) {
    const b = document.getElementById('fmStatusBanner');
    if (!b) return;
    b.textContent = text || '';
    b.classList.toggle('hidden', !text);
  }

  // ───────── 데이터 ─────────
  async function load(force) {
    st.shareOn = lsGet(SHARE_KEY) === '1';
    syncToggleUi();
    restoreWorkInputs();
    if (!ensureMap()) return;
    setTimeout(() => { if (st.map) st.map.invalidateSize(); }, 200);
    if (st.loading) return;

    if (!navigator.onLine && !force) {
      const cached = await global.PMIS_DB.loadState(CACHE_KEY).catch(() => null);
      if (cached && cached.data) {
        st.data = cached.data;
        showBanner(TF('fm_cache_banner', { time: new Date(cached.cachedAt).toISOString().slice(5, 16).replace('T', ' ') }));
        render(true);
      } else {
        showBanner(T('fm_offline'));
      }
      return;
    }

    st.loading = true;
    try {
      const res = await global.PMIS_API.call('getFieldMap', { includeTrail: true });
      if (res && res.success) {
        const first = !st.data;
        st.data = res;
        showBanner('');
        global.PMIS_DB.saveState(CACHE_KEY, res).catch(() => {});
        // 이 기기에서는 공유를 껐는데 서버 기록이 아직 ON 이면 정리 (재설치·다른 기기 등)
        if (!st.shareOn && res.me && res.me.shareState === 'ON') sendStop(true);
        render(first);
        if (st.shareOn) startAuto();
      } else {
        showBanner((res && (res.msg || res.error)) || T('fm_load_fail'));
      }
    } catch (err) {
      const cached = await global.PMIS_DB.loadState(CACHE_KEY).catch(() => null);
      if (cached && cached.data) { st.data = cached.data; render(true); }
      showBanner(T('fm_offline'));
    } finally {
      st.loading = false;
    }
  }

  // ───────── 그리기 ─────────
  function render(fit) {
    if (!st.map || !st.data) return;
    renderZones();
    renderPeople();
    renderMe();
    renderMyZoneCard();
    renderPeopleList();
    if (fit) fitAll();
    if (st.selected) {
      if (st.selected.type === 'zone') showZoneInfo(st.selected.id, true);
      else showPersonInfo(st.selected.id, true);
    }
  }

  function fitAll() {
    const L = global.L;
    const b = L.latLngBounds([]);
    st.layers.zones.eachLayer((l) => { if (l.getBounds) b.extend(l.getBounds()); });
    if (st.myPos) b.extend([st.myPos.lat, st.myPos.lng]);
    if (b.isValid()) st.map.fitBounds(b, { padding: [16, 16] });
  }

  function renderZones() {
    const L = global.L;
    if (!st.map || !st.data) return;
    st.layers.zones.clearLayers();
    const assigned = (st.data.me && st.data.me.assignedZoneIds) || [];
    const myZone = st.myPos ? zoneAt(st.myPos.lat, st.myPos.lng) : null;
    (st.data.zones || []).forEach((z) => {
      if (!z.geometry) return;
      const isMine = myZone && myZone.zoneId === z.zoneId;
      const isAssigned = assigned.indexOf(z.zoneId) !== -1;
      const isMulti = z.geometry.type === 'MultiPolygon';
      const style = {
        color: isMine ? '#2563eb' : (isAssigned ? '#f59e0b' : '#ffffff'),
        weight: isMine || isAssigned ? 3 : 1.2,
        fillColor: isMine ? '#3b82f6' : (isAssigned ? '#fbbf24' : (z.colorHex || '#94a3b8')),
        fillOpacity: isMulti ? 0 : (isMine ? 0.45 : (isAssigned ? 0.4 : 0.18)),
        dashArray: isMulti ? '6 4' : null
      };
      L.geoJSON({ type: 'Feature', properties: {}, geometry: z.geometry }, { style: () => style })
        .eachLayer((layer) => {
          layer.bindTooltip(shortZone(z.zoneId), { permanent: !isMulti, direction: 'center', className: 'fm-zone-label' });
          layer.on('click', () => showZoneInfo(z.zoneId));
          layer.addTo(st.layers.zones);
        });
    });
  }

  function personColor(p) {
    if (p.isMe) return '#2563eb';
    if (p.role === 'Inspector') return '#16a34a';
    if (p.role === 'RE') return '#7c3aed';
    return '#64748b';
  }

  function renderPeople() {
    const L = global.L;
    if (!st.map || !st.data) return;
    st.layers.people.clearLayers();
    if (!st.showPeople) return;
    (st.data.people || []).forEach((p) => {
      if (!isFinite(p.lat) || !isFinite(p.lng) || p.isMe) return;
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 8, color: '#ffffff', weight: 2, fillColor: personColor(p), fillOpacity: p.ageMin > 60 ? 0.45 : 0.95
      });
      m.bindTooltip(escHtml(p.name) + ' · ' + ageText(p.ageMin), { direction: 'top' });
      m.on('click', () => showPersonInfo(p.userId));
      m.addTo(st.layers.people);
    });
  }

  function renderMe() {
    const L = global.L;
    if (!st.map) return;
    st.layers.me.clearLayers();
    if (!st.myPos) return;
    if (st.myPos.accuracy && st.myPos.accuracy < 500) {
      L.circle([st.myPos.lat, st.myPos.lng], { radius: st.myPos.accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(st.layers.me);
    }
    L.circleMarker([st.myPos.lat, st.myPos.lng], { radius: 9, color: '#ffffff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 })
      .bindTooltip(T('fm_role_me'), { direction: 'top' })
      .addTo(st.layers.me);
  }

  function renderMyZoneCard() {
    const el = document.getElementById('fmMyZoneCard');
    if (!el || !st.data) return;
    const me = st.data.me || {};
    const myZone = st.myPos ? zoneAt(st.myPos.lat, st.myPos.lng) : null;
    const assigned = me.assignedZoneIds || [];
    let posLine;
    if (!st.myPos) posLine = T('fm_no_position');
    else if (myZone) posLine = '📍 ' + T('fm_my_zone') + ': <strong>' + escHtml(shortZone(myZone.zoneId)) + '</strong> ' + escHtml(myZone.zoneName || '');
    else posLine = '📍 ' + T('fm_outside_zone');
    const shareLine = st.shareOn
      ? '<span class="badge badge-green">' + escHtml(T('fm_share')) + ' ON</span>' + (me.lastLoggedAt ? ' <span class="small-muted">' + escHtml(TF('fm_last_update', { time: String(me.lastLoggedAt).slice(11, 16) })) + '</span>' : '')
      : '<span class="badge badge-slate">' + escHtml(T('fm_share')) + ' OFF</span>';
    el.innerHTML =
      '<div class="card-top"><div>' + posLine + '</div>' + shareLine + '</div>' +
      '<div class="small-muted" style="margin-top:4px;">' + escHtml(T('fm_assigned_zones')) + ': ' +
        (assigned.length ? assigned.map((id) => '<button type="button" class="chip-btn" data-fm-zone="' + escHtml(id) + '">' + escHtml(shortZone(id)) + '</button>').join(' ') : '-') +
      '</div>' +
      '<div class="small-muted">' + escHtml(T('fm_open_rits')) + ': ' + (me.openRitCount || 0) + (me.onDuty ? '' : ' · ' + escHtml(T('fm_not_on_duty_short'))) + '</div>';
    el.classList.remove('hidden');
  }

  function renderPeopleList() {
    const el = document.getElementById('fmPeopleList');
    if (!el || !st.data) return;
    if (!st.showPeople) { el.innerHTML = ''; return; }
    if (!st.data.canViewPeople) {
      el.innerHTML = '<div class="empty-box">' + escHtml(T('fm_people_hidden')) + '</div>';
      return;
    }
    const list = (st.data.people || []).filter((p) => !p.isMe);
    const head = '<div class="briefing-title">👷 ' + escHtml(TF('fm_people_title', { n: list.length, h: st.data.staleHours || 12 })) + '</div>';
    if (!list.length) {
      el.innerHTML = '<div class="card">' + head + '<div class="small-muted">' + escHtml(T('fm_people_empty')) + '</div></div>';
      return;
    }
    el.innerHTML = '<div class="card">' + head + list.map((p) =>
      '<button type="button" class="fm-person-row" data-fm-person="' + escHtml(p.userId) + '">' +
        '<span class="fm-dot" style="background:' + personColor(p) + '"></span>' +
        '<span class="fm-person-main"><strong>' + escHtml(p.name) + '</strong> <span class="small-muted">' + escHtml(p.role) + (p.discipline ? ' · ' + escHtml(p.discipline) : '') + '</span><br>' +
        '<span class="small-muted">' + escHtml(p.zoneId ? shortZone(p.zoneId) : (p.zoneOrLocation || T('fm_outside_zone'))) + ' · ' + escHtml(ageText(p.ageMin)) +
        (p.openRitCount ? ' · RIT ' + p.openRitCount : '') + '</span></span>' +
      '</button>'
    ).join('') + '</div>';
  }

  // ───────── 정보 패널 (구역 / 인력) ─────────
  function panel(html) {
    const el = document.getElementById('fmInfoPanel');
    if (!el) return;
    if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  function showZoneInfo(zoneId, silent) {
    if (!st.data) return;
    const z = (st.data.zones || []).find((x) => x.zoneId === zoneId);
    if (!z) return;
    st.selected = { type: 'zone', id: zoneId };
    st.layers.trail.clearLayers();
    const s = z.summary;
    const here = (st.data.people || []).filter((p) => p.zoneId === zoneId);
    const html =
      '<div class="card-top"><strong>🧱 ' + escHtml(shortZone(z.zoneId)) + ' · ' + escHtml(z.zoneName || '') + '</strong>' +
        '<button type="button" class="btn-outline-sm" data-fm-close="1">✕</button></div>' +
      '<div class="small-muted">' + (s ? escHtml(TF('fm_zone_summary', { rit: s.rit, open: s.ritOpen, dwr: s.dwr, drq: s.drq })) + (s.lastDate ? ' · ' + escHtml(s.lastDate) : '') : escHtml(T('fm_zone_no_summary'))) + '</div>' +
      (here.length ? '<div class="small-muted" style="margin-top:4px;">👷 ' + escHtml(T('fm_zone_people')) + ': ' + here.map((p) => escHtml(p.name)).join(', ') + '</div>' : '') +
      '<div id="fmZoneDetail" style="margin-top:6px;"><button type="button" class="btn-outline-sm" data-fm-zone-detail="' + escHtml(zoneId) + '">' + escHtml(T('fm_zone_detail_btn')) + '</button></div>';
    panel(html);
    if (!silent) document.getElementById('fmInfoPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadZoneDetail(zoneId) {
    const box = document.getElementById('fmZoneDetail');
    if (!box) return;
    if (!navigator.onLine) { box.textContent = T('fm_offline'); return; }
    box.textContent = T('fm_zone_loading');
    try {
      const res = await global.PMIS_API.call('getZoneDetail', { zoneId: zoneId });
      if (!res || !res.success) throw new Error((res && (res.msg || res.message)) || 'Failed');
      const open = (res.ritEvents || []).filter((e) => e.statusKey !== 'done' && e.statusKey !== 'canceled').slice(0, 6);
      const daily = (res.dailyEvents || []).slice(0, 5);
      box.innerHTML =
        '<div class="small-muted fw-bold">' + escHtml(T('fm_open_rits')) + ' (' + open.length + ')</div>' +
        (open.length ? open.map((e) => '<div class="fm-mini-row">📋 ' + escHtml(e.ritNo) + (e.rev ? ' R' + escHtml(e.rev) : '') + ' · ' + escHtml(e.subject || '') + ' <span class="small-muted">' + escHtml(e.date || '') + '</span></div>').join('') : '<div class="small-muted">-</div>') +
        '<div class="small-muted fw-bold" style="margin-top:6px;">' + escHtml(T('fm_recent_daily')) + '</div>' +
        (daily.length ? daily.map((d) => '<div class="fm-mini-row">🗒 ' + escHtml(d.type) + ' ' + escHtml(d.date || '') + ' · ' + escHtml(d.activities || '') + '</div>').join('') : '<div class="small-muted">-</div>');
    } catch (err) {
      box.textContent = (err && err.message) || T('fm_load_fail');
    }
  }

  function showPersonInfo(userId, silent) {
    if (!st.data) return;
    const p = (st.data.people || []).find((x) => x.userId === userId);
    if (!p) return;
    st.selected = { type: 'person', id: userId };
    const L = global.L;
    st.layers.trail.clearLayers();
    if (Array.isArray(p.trail) && p.trail.length > 1) {
      const pts = p.trail.map((t) => [t[0], t[1]]);
      L.polyline(pts, { color: personColor(p), weight: 3, opacity: 0.85, dashArray: '6 6' }).addTo(st.layers.trail);
      L.circleMarker(pts[0], { radius: 4, color: personColor(p), fillOpacity: 1 }).bindTooltip(p.trail[0][2] || '').addTo(st.layers.trail);
    }
    if (!silent && isFinite(p.lat)) st.map.setView([p.lat, p.lng], Math.max(st.map.getZoom(), 16));
    const rits = (p.openRits || []).map((r) =>
      '<div class="fm-mini-row">📋 ' + escHtml(r.ritNo) + (r.rev ? ' R' + escHtml(r.rev) : '') + ' · ' + escHtml(r.subject) +
      ' <span class="small-muted">' + escHtml(r.location || '') + (r.reqDate ? ' · ' + escHtml(r.reqDate) : '') + '</span></div>').join('');
    const html =
      '<div class="card-top"><strong><span class="fm-dot" style="background:' + personColor(p) + '"></span> ' + escHtml(p.name) + '</strong>' +
        '<button type="button" class="btn-outline-sm" data-fm-close="1">✕</button></div>' +
      '<div class="small-muted">' + escHtml(p.role) + (p.discipline ? ' · ' + escHtml(p.discipline) : '') + ' · ' + escHtml(ageText(p.ageMin)) + ' (' + escHtml(String(p.loggedAt).slice(11, 16)) + ')' +
        (p.accuracy ? ' · ±' + p.accuracy + 'm' : '') + '</div>' +
      '<div style="margin-top:4px;">🧱 ' + escHtml(T('fm_zone')) + ': ' + (p.zoneId ? '<button type="button" class="chip-btn" data-fm-zone="' + escHtml(p.zoneId) + '">' + escHtml(shortZone(p.zoneId)) + '</button>' : escHtml(T('fm_outside_zone'))) + '</div>' +
      (p.zoneOrLocation ? '<div class="small-muted">📌 ' + escHtml(T('fm_work_loc')) + ': ' + escHtml(p.zoneOrLocation) + '</div>' : '') +
      (p.activityNote ? '<div class="small-muted">📝 ' + escHtml(T('fm_note')) + ': ' + escHtml(p.activityNote) + '</div>' : '') +
      (p.trail && p.trail.length > 1 ? '<div class="small-muted">〰 ' + escHtml(TF('fm_trail', { n: p.trail.length })) + '</div>' : '') +
      '<div class="small-muted fw-bold" style="margin-top:6px;">' + escHtml(T('fm_open_rits')) + ' (' + (p.openRitCount || 0) + ')</div>' +
      (rits || '<div class="small-muted">-</div>');
    panel(html);
    if (!silent) document.getElementById('fmInfoPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ───────── 내 위치 / 공유 ─────────
  async function locateMe(opts) {
    opts = opts || {};
    if (!ensureMap()) return null;
    showBanner(T('fm_gps_locating'));
    const pos = await acquirePosition();
    showBanner('');
    if (pos.error) {
      if (!opts.silent) toast(gpsErrorText(pos.error), 'warning');
      return null;
    }
    st.myPos = pos;
    renderMe();
    renderZones();
    renderMyZoneCard();
    if (!opts.noPan) st.map.setView([pos.lat, pos.lng], Math.max(st.map.getZoom(), 16));
    return pos;
  }

  async function sendLocation(pos, manual) {
    if (!pos || !st.shareOn) return false;
    if (!navigator.onLine) { if (manual) toast(T('fm_offline'), 'warning'); return false; }
    try {
      const res = await global.PMIS_API.call('updateFieldLocation', {
        event: 'UPDATE',
        lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy,
        shareOn: true, manual: !!manual,
        zoneOrLocation: (document.getElementById('fmWorkLocInput') || {}).value || '',
        activityNote: (document.getElementById('fmNoteInput') || {}).value || '',
        device: global.PMIS_API.getDeviceSummary()
      });
      if (res && res.success) {
        if (res.logged && st.data && st.data.me) st.data.me.lastLoggedAt = res.loggedAt || '';
        if (manual) toast(TF('fm_loc_sent', { zone: res.zoneId ? shortZone(res.zoneId) : T('fm_outside_zone') }), 'success');
        renderMyZoneCard();
        return true;
      }
      if (manual) toast((res && res.code === 'FIELD_LOC_NOT_ON_DUTY') ? T('fm_not_on_duty') : ((res && (res.msg || res.error)) || T('fm_load_fail')), 'warning');
    } catch (err) {
      if (manual) toast((err && err.message) || T('fm_load_fail'), 'danger');
    }
    return false;
  }

  async function sendStop(silent) {
    if (!navigator.onLine) return;
    try {
      await global.PMIS_API.call('updateFieldLocation', { event: 'STOP', shareOn: false, device: global.PMIS_API.getDeviceSummary() });
      if (st.data && st.data.me) st.data.me.shareState = 'OFF';
    } catch (e) {
      if (!silent) toast((e && e.message) || T('fm_load_fail'), 'warning');
    }
  }

  async function refreshLocation() {
    const pos = await locateMe();
    if (!pos) return;
    if (st.shareOn) {
      await sendLocation(pos, true);
      load(true);
    } else {
      toast(T('fm_loc_local_only'), 'info');
    }
  }

  function startAuto() {
    stopAuto();
    st.autoTimer = setInterval(async () => {
      if (!st.shareOn || document.hidden || !navigator.onLine) return;
      const pos = await locateMe({ silent: true, noPan: true });
      if (pos) sendLocation(pos, false);
    }, AUTO_INTERVAL_MS);
  }
  function stopAuto() {
    if (st.autoTimer) clearInterval(st.autoTimer);
    st.autoTimer = null;
  }

  async function onShareToggle(checked) {
    if (checked) {
      if (!confirm(T('fm_share_confirm'))) { syncToggleUi(); return; }
      st.shareOn = true;
      lsSet(SHARE_KEY, '1');
      syncToggleUi();
      const pos = await locateMe();
      if (pos) await sendLocation(pos, true);
      startAuto();
      toast(T('fm_share_on'), 'success');
      load(true);
    } else {
      st.shareOn = false;
      lsSet(SHARE_KEY, null);
      syncToggleUi();
      stopAuto();
      await sendStop(false);
      toast(T('fm_share_off'), 'info');
      renderMyZoneCard();
    }
  }

  function syncToggleUi() {
    const chk = document.getElementById('fmShareToggle');
    if (chk) chk.checked = !!st.shareOn;
    const wrap = document.getElementById('fmShareInputs');
    if (wrap) wrap.classList.toggle('hidden', !st.shareOn);
  }

  function restoreWorkInputs() {
    try {
      const saved = JSON.parse(lsGet(WORK_LOC_KEY) || '{}');
      const a = document.getElementById('fmWorkLocInput');
      const b = document.getElementById('fmNoteInput');
      if (a && !a.value && saved.loc) a.value = saved.loc;
      if (b && !b.value && saved.note) b.value = saved.note;
    } catch (e) {}
  }
  function saveWorkInputs() {
    const a = document.getElementById('fmWorkLocInput');
    const b = document.getElementById('fmNoteInput');
    lsSet(WORK_LOC_KEY, JSON.stringify({ loc: (a && a.value) || '', note: (b && b.value) || '' }));
  }

  // ───────── 이벤트 ─────────
  function bindEvents() {
    const on = (id, evName, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evName, fn); };
    on('fmMyLocBtn', 'click', () => locateMe());
    on('fmRefreshBtn', 'click', refreshLocation);
    on('fmInspBtn', 'click', () => {
      st.showPeople = !st.showPeople;
      const btn = document.getElementById('fmInspBtn');
      if (btn) btn.classList.toggle('active', st.showPeople);
      renderPeople();
      renderPeopleList();
      if (st.showPeople && navigator.onLine) load(true);
    });
    on('fmShareToggle', 'change', (e) => onShareToggle(e.target.checked));
    on('fmWorkLocInput', 'change', saveWorkInputs);
    on('fmNoteInput', 'change', saveWorkInputs);

    const tab = document.getElementById('tab-map');
    if (tab) {
      tab.addEventListener('click', (ev) => {
        const z = ev.target.closest('[data-fm-zone]');
        if (z) { showZoneInfo(z.getAttribute('data-fm-zone')); return; }
        const zd = ev.target.closest('[data-fm-zone-detail]');
        if (zd) { loadZoneDetail(zd.getAttribute('data-fm-zone-detail')); return; }
        const p = ev.target.closest('[data-fm-person]');
        if (p) { showPersonInfo(p.getAttribute('data-fm-person')); return; }
        if (ev.target.closest('[data-fm-close]')) { st.selected = null; st.layers.trail && st.layers.trail.clearLayers(); panel(''); }
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && st.shareOn && st.data) startAuto();
    });
  }

  function rerender() {
    if (st.data) render(false);
  }

  /** 로그인 직후: 이 기기에서 공유가 켜져 있었으면 자동 갱신 재개 (지도 탭을 열지 않아도 5분마다 전송) */
  function resume() {
    st.shareOn = lsGet(SHARE_KEY) === '1';
    if (st.shareOn) startAuto();
  }

  /** 로그아웃: 자동 갱신 중지 + 서버에 공유 종료 기록 (기기 설정은 유지하지 않음) */
  async function onLogout() {
    stopAuto();
    if (st.shareOn) await sendStop(true);
    st.shareOn = false;
    lsSet(SHARE_KEY, null);
    st.data = null;
    st.myPos = null;
  }

  global.PMIS_FIELDMAP = { load, bindEvents, rerender, stopAuto, resume, onLogout };
})(window);
