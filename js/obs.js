/* U-Tapao PMIS Mobile — 현장 특이사항 촬영·기록·공유 (안전 HSE / 일반 모니터링, 2026-11-20)
 * - RIT 검측과 별도. 헤더 📸 버튼 → 모달 [새 기록] / [공유 피드]
 * - 사진: 후면 카메라(capture=environment) 또는 갤러리, 1600px JPEG 로 줄여 메모리 보호, 첫 사진은 320px 미리보기도 생성
 * - 시각·GPS 자동 첨부 (GPS 실패 시 'No GPS' 로 계속 진행)
 * - 오프라인/통신 실패: IndexedDB(app_state_cache 'obs_queue')에 보관 → 온라인 복귀 시 자동 전송 (clientId 로 중복 방지)
 * - 서버: saveFieldObservation / getFieldObservations (Code_FieldNote.js)
 */
(function (global) {
  const MAX_PHOTOS = 6;
  const QUEUE_KEY = 'obs_queue';
  const st = {
    photos: [],        // [{ full: dataURL, thumb: dataURL }]
    gps: null,         // { lat, lng, accuracy } | null
    gpsText: '',
    capturedAt: '',
    category: 'SAFETY',
    feed: null,
    feedFilter: 'ALL',
    busy: false,
    flushing: false
  };

  function T(k) { return global.PMIS_I18N.t(k); }
  function TF(k, p) { return global.PMIS_I18N.tf(k, p); }
  function toast(m, t) { if (global.PMIS_APP) global.PMIS_APP.toast(m, t); }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function bangkokNow() {
    try {
      return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
  }
  function newClientId() { return 'obs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  const $ = (id) => document.getElementById(id);

  // ───────── 이미지 축소 (메모리 보호) ─────────
  function resizeFile(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read fail'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('image fail'));
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function shrinkDataUrl(dataUrl, maxSide, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale)); c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    });
  }

  async function addFiles(input) {
    const files = Array.from((input && input.files) || []);
    for (const f of files) {
      if (st.photos.length >= MAX_PHOTOS) { toast(TF('obs_max_photos', { n: MAX_PHOTOS }), 'warning'); break; }
      try {
        const full = await resizeFile(f, 1600, 0.8);
        const thumb = st.photos.length === 0 ? await shrinkDataUrl(full, 320, 0.6) : '';
        st.photos.push({ full, thumb });
      } catch (e) {
        toast(T('obs_photo_fail'), 'warning');
      }
    }
    if (input) input.value = '';
    renderPhotos();
  }

  function renderPhotos() {
    const grid = $('obsPhotoGrid');
    const cnt = $('obsPhotoCount');
    if (cnt) cnt.textContent = TF('obs_photos_label', { n: st.photos.length, max: MAX_PHOTOS });
    if (!grid) return;
    grid.innerHTML = st.photos.map((p, i) =>
      '<div class="photo-thumb"><img src="' + p.full + '" alt=""><button type="button" class="photo-del" data-obs-del="' + i + '">✕</button></div>').join('');
  }

  // ───────── GPS (멈추지 않게) ─────────
  function acquireGps() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      let done = false;
      const guard = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 10000);
      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => { if (done) return; done = true; clearTimeout(guard); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }); },
          () => { if (done) return; done = true; clearTimeout(guard); resolve(null); },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
        );
      } catch (e) { done = true; clearTimeout(guard); resolve(null); }
    });
  }
  async function refreshGps() {
    const el = $('obsGpsLine');
    if (el) el.textContent = '📍 ' + T('obs_gps_locating');
    st.gps = await acquireGps();
    st.gpsText = st.gps ? (st.gps.lat.toFixed(6) + ', ' + st.gps.lng.toFixed(6)) : (navigator.onLine === false ? 'Offline (No GPS)' : 'No GPS');
    if (el) el.textContent = '📍 ' + (st.gps ? st.gpsText + ' (±' + Math.round(st.gps.accuracy || 0) + 'm)' : T('obs_gps_none'));
  }

  // ───────── 모달 ─────────
  function open(tab) {
    $('obsModal').classList.remove('hidden');
    switchSeg(tab || 'new');
    if ((tab || 'new') === 'new') resetForm();
    flushQueue();
  }
  function close() { $('obsModal').classList.add('hidden'); }

  function switchSeg(seg) {
    document.querySelectorAll('[data-obs-seg]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-obs-seg') === seg));
    $('obsNewPane').classList.toggle('hidden', seg !== 'new');
    $('obsFeedPane').classList.toggle('hidden', seg !== 'feed');
    if (seg === 'feed') loadFeed(false);
  }

  function resetForm() {
    st.photos = [];
    st.capturedAt = bangkokNow();
    $('obsNoteInput').value = '';
    $('obsLocInput').value = '';
    setCategory(st.category || 'SAFETY');
    const tl = $('obsTimeLine');
    if (tl) tl.textContent = '🕒 ' + st.capturedAt + ' (GMT+7)';
    renderPhotos();
    refreshQueueLine();
    refreshGps();
  }

  function setCategory(cat) {
    st.category = cat === 'GENERAL' ? 'GENERAL' : 'SAFETY';
    document.querySelectorAll('[data-obs-cat]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-obs-cat') === st.category));
  }

  // ───────── 저장 / 오프라인 큐 ─────────
  // 기기 저장소(IndexedDB)가 응답하지 않아도 저장 버튼이 멈추지 않도록 3초 제한
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
    ]);
  }
  let memQueue = null;   // 저장소를 못 쓰는 환경용 메모리 보관 (앱 종료 시 사라짐)
  async function loadQueue() {
    const s = await withTimeout(global.PMIS_DB.loadState(QUEUE_KEY), 3000, null);
    if (s && Array.isArray(s.data)) return s.data;
    return memQueue ? memQueue.slice() : [];
  }
  async function saveQueue(list) {
    memQueue = list.slice();
    await withTimeout(global.PMIS_DB.saveState(QUEUE_KEY, list), 3000, null);
    refreshQueueLine();
  }
  async function refreshQueueLine() {
    const el = $('obsQueueLine');
    if (!el) return;
    const q = await loadQueue();
    el.textContent = q.length ? TF('obs_queue_pending', { n: q.length }) : '';
    el.classList.toggle('hidden', !q.length);
  }

  async function submit() {
    if (st.busy) return;
    const note = $('obsNoteInput').value.trim();
    if (!note && !st.photos.length) { toast(T('obs_err_empty'), 'warning'); return; }
    st.busy = true;
    const btn = $('obsSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = T('obs_saving'); }
    const payload = {
      category: st.category,
      locationText: $('obsLocInput').value.trim(),
      note: note,
      lat: st.gps ? st.gps.lat : '',
      lng: st.gps ? st.gps.lng : '',
      gpsText: st.gpsText || 'No GPS',
      capturedAt: st.capturedAt || bangkokNow(),
      photos: st.photos.map((p) => p.full),
      thumb: (st.photos[0] && st.photos[0].thumb) || '',
      clientId: newClientId(),
      device: global.PMIS_API.getDeviceSummary()
    };
    try {
      if (!navigator.onLine) throw new Error('offline');
      const res = await global.PMIS_API.call('saveFieldObservation', payload, { timeoutMs: 120000 });
      if (res && res.success) {
        toast(res.photoFailed ? T('obs_saved_no_photo') : T('obs_saved'), res.photoFailed ? 'warning' : 'success');
        resetForm();
        switchSeg('feed');
        loadFeed(true);
      } else if (res && (res.code === 'srv_auth_forbidden' || res.code === 'FIELD_NOTE_EMPTY')) {
        toast(res.msg || res.error || T('obs_err_save'), 'danger');
      } else {
        throw new Error((res && (res.msg || res.error)) || 'server');
      }
    } catch (err) {
      // 오프라인·통신 실패 → 기기 보관, 온라인 복귀 시 자동 전송
      const q = await loadQueue();
      q.push(Object.assign({ queuedAt: Date.now() }, payload));
      await saveQueue(q);
      toast(T('obs_queued'), 'info');
      resetForm();
    } finally {
      st.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = T('obs_btn_submit'); }
    }
  }

  async function flushQueue() {
    if (st.flushing || !navigator.onLine || !global.PMIS_API.getAuthToken()) return;
    st.flushing = true;
    try {
      let q = await loadQueue();
      if (!q.length) return;
      const remain = [];
      let sent = 0;
      for (const item of q) {
        try {
          const res = await global.PMIS_API.call('saveFieldObservation', item, { timeoutMs: 120000 });
          if (res && res.success) sent++;
          else if (res && (res.code === 'srv_auth_forbidden' || res.code === 'FIELD_NOTE_EMPTY')) { /* 다시 보내도 실패 → 버림 */ }
          else remain.push(item);
        } catch (e) { remain.push(item); }
      }
      await saveQueue(remain);
      if (sent) { toast(TF('obs_queue_sent', { n: sent }), 'success'); if (st.feed) loadFeed(true); }
    } finally {
      st.flushing = false;
    }
  }

  // ───────── 공유 피드 ─────────
  async function loadFeed(force) {
    const list = $('obsFeedList');
    if (!navigator.onLine && !force) {
      const cached = await global.PMIS_DB.loadState('obs_feed').catch(() => null);
      if (cached && cached.data) { st.feed = cached.data; renderFeed(); }
      else if (list) list.innerHTML = '<div class="empty-box">' + escHtml(T('obs_feed_offline')) + '</div>';
      return;
    }
    if (list && !st.feed) list.innerHTML = '<div class="empty-box">' + escHtml(T('rit_loading')) + '</div>';
    try {
      const res = await global.PMIS_API.call('getFieldObservations', { category: 'ALL', limit: 40 });
      if (res && res.success) {
        st.feed = res.items || [];
        global.PMIS_DB.saveState('obs_feed', st.feed).catch(() => {});
        renderFeed();
      } else if (list) {
        list.innerHTML = '<div class="empty-box">' + escHtml((res && (res.msg || res.error)) || T('obs_err_load')) + '</div>';
      }
    } catch (e) {
      const cached = await global.PMIS_DB.loadState('obs_feed').catch(() => null);
      if (cached && cached.data) { st.feed = cached.data; renderFeed(); }
    }
  }

  function renderFeed() {
    const list = $('obsFeedList');
    if (!list || !st.feed) return;
    document.querySelectorAll('[data-obs-filter]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-obs-filter') === st.feedFilter));
    const items = st.feed.filter((it) => st.feedFilter === 'ALL' || it.category === st.feedFilter);
    if (!items.length) { list.innerHTML = '<div class="empty-box">' + escHtml(T('obs_feed_empty')) + '</div>'; return; }
    list.innerHTML = items.map((it) => {
      const isSafety = it.category === 'SAFETY';
      return '<article class="card obs-card">' +
        (it.thumb ? '<img class="obs-thumb" src="' + escHtml(it.thumb) + '" alt="">' : '') +
        '<div class="obs-body">' +
          '<div class="card-top"><span class="badge ' + (isSafety ? 'badge-red' : 'badge-blue') + '">' + escHtml(isSafety ? T('obs_cat_safety') : T('obs_cat_general')) + '</span>' +
          '<span class="small-muted">' + escHtml(String(it.capturedAt).slice(5, 16)) + '</span></div>' +
          (it.note ? '<div class="obs-note">' + escHtml(it.note) + '</div>' : '') +
          '<div class="small-muted">📌 ' + escHtml(it.locationText || '-') + (it.zoneId ? ' · 🧱 ' + escHtml(String(it.zoneId).replace(/UTP-CB-/g, '')) : '') + '</div>' +
          '<div class="small-muted">📍 ' + escHtml(it.gpsText || 'No GPS') + '</div>' +
          '<div class="small-muted">👤 ' + escHtml(it.authorName) + (it.authorRole ? ' (' + escHtml(it.authorRole) + ')' : '') + '</div>' +
          (it.photoCount ? '<div class="chip-row"><a class="chip-link" href="' + escHtml(it.folderUrl || it.photoUrls[0]) + '" target="_blank" rel="noopener">🖼 ' + escHtml(TF('obs_photos_open', { n: it.photoCount })) + '</a></div>' : '') +
        '</div></article>';
    }).join('');
  }

  // ───────── 이벤트 ─────────
  function bindEvents() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('headerObsBtn', 'click', () => open('new'));
    on('navObsBtn', 'click', () => open('new')); // 하단 메뉴 중앙 큰 사진 버튼 (2026-11-21)
    on('obsCloseBtn', 'click', close);
    on('obsCameraBtn', 'click', () => $('obsCameraInput').click());
    on('obsAlbumBtn', 'click', () => $('obsAlbumInput').click());
    on('obsCameraInput', 'change', (e) => addFiles(e.target));
    on('obsAlbumInput', 'change', (e) => addFiles(e.target));
    on('obsGpsRetryBtn', 'click', refreshGps);
    on('obsSubmitBtn', 'click', submit);
    on('obsFeedRefreshBtn', 'click', () => loadFeed(true));
    const modal = $('obsModal');
    if (modal) {
      modal.addEventListener('click', (ev) => {
        const seg = ev.target.closest('[data-obs-seg]');
        if (seg) { switchSeg(seg.getAttribute('data-obs-seg')); return; }
        const cat = ev.target.closest('[data-obs-cat]');
        if (cat) { setCategory(cat.getAttribute('data-obs-cat')); return; }
        const del = ev.target.closest('[data-obs-del]');
        if (del) { st.photos.splice(Number(del.getAttribute('data-obs-del')), 1); renderPhotos(); return; }
        const flt = ev.target.closest('[data-obs-filter]');
        if (flt) { st.feedFilter = flt.getAttribute('data-obs-filter'); renderFeed(); }
      });
    }
    window.addEventListener('online', () => setTimeout(flushQueue, 3000));
  }

  function rerender() {
    renderPhotos();
    if (st.feed) renderFeed();
    refreshQueueLine();
  }

  global.PMIS_OBS = { bindEvents, open, flushQueue, rerender };
})(window);
