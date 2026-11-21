/* U-Tapao PMIS Mobile — 현장 특이사항 촬영·기록·공유 (안전 HSE / 일반 모니터링, 2026-11-20)
 * - RIT 검측과 별도. 헤더 📸 버튼 → 모달 [새 기록] / [공유 피드]
 * - 사진: 후면 카메라(capture=environment) 또는 갤러리, 1600px JPEG 로 줄여 메모리 보호, 첫 사진은 320px 미리보기도 생성
 * - 시각·GPS 자동 첨부 (GPS 실패 시 'No GPS' 로 계속 진행)
 * - 오프라인/통신 실패: IndexedDB(app_state_cache 'obs_queue')에 보관 → 온라인 복귀 시 자동 전송 (clientId 로 중복 방지)
 * - 서버: saveFieldObservation / addFieldObservationPhoto / getFieldObservations (Code_FieldNote.js)
 * - 2026-11-21: 사진 최대 20장 + 백그라운드 전송
 *   저장 버튼 → 기기 대기열에 넣고 창을 닫음 → ① 기록(메모·GPS·미리보기) 저장 ② 사진을 한 장씩 전송
 *   진행은 하단 메뉴 위 작은 표시(📤 3/20)로만 보이고, 끝나면 🔔 알림. 끊기면 남은 사진만 이어서 전송 (앱 실행 중일 때)
 */
(function (global) {
  const MAX_PHOTOS = 20;
  const JOB_V = 2;   // 대기열 항목 형식: 2 = 기록 먼저 + 사진 한 장씩 (이전 형식은 한 번에 전송)
  // 다시 보내도 같은 결과인 오류 → 대기열에서 버림
  const PERMANENT_CODES = ['srv_auth_forbidden', 'FIELD_NOTE_BAD_ID', 'FIELD_NOTE_NOT_FOUND'];
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
        const preview = await shrinkDataUrl(full, 240, 0.6);   // 화면 미리보기용 (원본 20장을 그리면 메모리 부족 위험)
        st.photos.push({ full, thumb, preview });
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
      '<div class="photo-thumb"><img src="' + (p.preview || p.full) + '" alt=""><button type="button" class="photo-del" data-obs-del="' + i + '">✕</button></div>').join('');
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
    const clientId = newClientId();
    // 2026-11-21: 대기열에 넣고 바로 창을 닫음 → 전송은 백그라운드 (기록 먼저, 사진은 한 장씩)
    const job = {
      v: JOB_V,
      queuedAt: Date.now(),
      noteId: '',
      total: st.photos.length,
      photos: st.photos.map((p) => p.full),   // 보낸 사진은 null 로 비워 기기 저장공간을 줄임
      failed: 0,
      meta: {
        category: st.category,
        locationText: $('obsLocInput').value.trim(),
        note: note,
        lat: st.gps ? st.gps.lat : '',
        lng: st.gps ? st.gps.lng : '',
        gpsText: st.gpsText || 'No GPS',
        capturedAt: st.capturedAt || bangkokNow(),
        photos: [],
        expectedPhotos: st.photos.length,
        thumb: (st.photos[0] && st.photos[0].thumb) || '',
        clientId: clientId,
        device: global.PMIS_API.getDeviceSummary()
      }
    };
    try {
      const q = await loadQueue();
      q.push(job);
      await saveQueue(q);
      toast(job.total ? TF('obs_bg_started', { n: job.total }) : T('obs_bg_started_note'), 'info');
      resetForm();
      close();
    } finally {
      st.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = T('obs_btn_submit'); }
    }
    flushQueue();
  }

  // ───────── 백그라운드 전송 (2026-11-21) ─────────
  // 대기열 전체의 사진 진행 (하단 표시용)
  function queueProgress(q) {
    let total = 0, left = 0;
    q.forEach((j) => {
      if (j && j.v === JOB_V) { total += j.total; left += j.photos.filter((x) => !!x).length; }
      else if (j) { const n = Array.isArray(j.photos) ? j.photos.length : 0; total += n; left += n; }
    });
    return { jobs: q.length, total, done: total - left };
  }
  function renderPill(q, sending) {
    const el = $('obsUploadPill');
    if (!el) return;
    if (!q || !q.length) { el.classList.add('hidden'); return; }
    const pr = queueProgress(q);
    el.classList.remove('hidden');
    el.classList.toggle('waiting', !sending);
    el.textContent = sending
      ? (pr.total ? TF('obs_bg_progress', { done: pr.done, total: pr.total }) : T('obs_bg_sending'))
      : TF('obs_bg_waiting', { n: pr.jobs });
  }
  async function refreshPill() { renderPill(await loadQueue(), st.flushing); }

  function isPermanent(res) { return !!(res && PERMANENT_CODES.indexOf(res.code) !== -1); }

  // 대기열 한 건 처리 → 'done' | 'drop' | 'retry'
  async function runJob(job, persist) {
    // 이전 형식(사진을 한 번에 보내던 앱 버전에서 남은 항목)
    if (job.v !== JOB_V) {
      const res = await global.PMIS_API.call('saveFieldObservation', job, { timeoutMs: 120000 });
      if (res && res.success) return 'done';
      if (isPermanent(res) || (res && res.code === 'FIELD_NOTE_EMPTY')) return 'drop';
      return 'retry';
    }
    // ① 기록 먼저 (같은 clientId 재전송은 서버가 같은 기록 번호를 돌려줌)
    if (!job.noteId) {
      const res = await global.PMIS_API.call('saveFieldObservation', job.meta, { timeoutMs: 90000 });
      if (res && res.success && res.noteId) { job.noteId = res.noteId; await persist(); }
      else if (isPermanent(res) || (res && res.code === 'FIELD_NOTE_EMPTY' && !job.total)) return 'drop';
      else return 'retry';
    }
    // ② 사진 한 장씩
    for (let i = 0; i < job.photos.length; i++) {
      if (!job.photos[i]) continue;
      const res = await global.PMIS_API.call('addFieldObservationPhoto', { noteId: job.noteId, index: i + 1, dataUrl: job.photos[i] }, { timeoutMs: 90000 });
      if (res && res.success) { job.photos[i] = null; await persist(); continue; }
      if (isPermanent(res)) return 'drop';
      if (res && (res.code === 'FIELD_NOTE_BAD_PHOTO' || res.code === 'FIELD_NOTE_BAD_INDEX')) { job.photos[i] = null; job.failed++; await persist(); continue; }
      return 'retry';
    }
    return 'done';
  }

  async function flushQueue() {
    if (st.flushing || !navigator.onLine || !global.PMIS_API.getAuthToken()) { refreshPill(); return; }
    st.flushing = true;
    let doneJobs = 0, donePhotos = 0, failedPhotos = 0;
    try {
      const q = await loadQueue();
      renderPill(q, true);
      const persist = async () => { await saveQueue(q); renderPill(q, true); };
      while (q.length) {
        const job = q[0];
        let out;
        try { out = await runJob(job, persist); } catch (e) { out = 'retry'; }
        if (out === 'retry') break;
        q.shift();
        await saveQueue(q);
        if (out === 'done') {
          doneJobs++;
          donePhotos += (job.v === JOB_V ? job.total - (job.failed || 0) : (Array.isArray(job.photos) ? job.photos.length : 0));
          failedPhotos += (job.failed || 0);
        }
      }
      if (doneJobs) {
        const body = TF('obs_bg_done_body', { n: doneJobs, p: donePhotos }) + (failedPhotos ? ' ' + TF('obs_bg_done_failed', { n: failedPhotos }) : '');
        if (global.PMIS_NOTIFY && global.PMIS_NOTIFY.notify) global.PMIS_NOTIFY.notify(T('obs_bg_done_title'), body, { tab: 'rit', tag: 'pmis-obs' });
        else toast(T('obs_bg_done_title') + ' — ' + body, 'success');
        if (st.feed) loadFeed(true);
      }
    } finally {
      st.flushing = false;
      await refreshPill();
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
    window.addEventListener('offline', () => refreshPill());
    // 2026-11-21: 남은 사진 이어 보내기 — 앱으로 돌아올 때, 1분마다, 앱 시작 직후(로그인 복원 대기), 표시 누르면 즉시
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(flushQueue, 1500); });
    setInterval(() => { if (!st.flushing) flushQueue(); }, 60000);
    setTimeout(flushQueue, 8000);
    on('obsUploadPill', 'click', () => flushQueue());
  }

  function rerender() {
    renderPhotos();
    if (st.feed) renderFeed();
    refreshQueueLine();
    refreshPill();
  }

  global.PMIS_OBS = { bindEvents, open, flushQueue, rerender };
})(window);
