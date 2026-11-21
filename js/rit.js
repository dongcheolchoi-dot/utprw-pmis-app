/* U-Tapao PMIS Mobile RIT Offline-First Module */
(function (global) {
  const PHOTO_MAX = 10;
  const PHOTO_MAX_SIDE = 1600;
  const PHOTO_QUALITY = 0.82;
  const TIME_ZONE = 'Asia/Bangkok';

  let allRitTasks = [];
  let userOptions = { res: [], insps: [], disc: {}, discScope: null };
  let stagedPhotos = [];
  let photosBusy = false;
  let currentTarget = null;
  let isFlushing = false;
  let queueListOpen = false;
  let onlineTimer = null;

  // Lightweight Standalone High-DPI Touch Signature Pad
  const sigPad = (function () {
    let canvas = null;
    let ctx = null;
    let drawing = false;
    let dirty = false;
    let lastPt = null;

    function pt(ev) {
      const rect = canvas.getBoundingClientRect();
      const src = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    function start(ev) {
      if (!ctx) return;
      ev.preventDefault();
      drawing = true;
      lastPt = pt(ev);
      ctx.beginPath();
      ctx.moveTo(lastPt.x, lastPt.y);
      ctx.lineTo(lastPt.x + 0.1, lastPt.y + 0.1);
      ctx.stroke();
      dirty = true;
    }

    function move(ev) {
      if (!drawing || !ctx) return;
      ev.preventDefault();
      const p = pt(ev);
      ctx.beginPath();
      ctx.moveTo(lastPt.x, lastPt.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastPt = p;
      dirty = true;
    }

    function end() {
      drawing = false;
    }

    function init(el) {
      if (!el || canvas === el) return;
      canvas = el;
      canvas.addEventListener('pointerdown', start, { passive: false });
      canvas.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', end);
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', move, { passive: false });
      canvas.addEventListener('touchend', end);
    }

    function resizeAndClear() {
      if (!canvas) return;
      const ratio = Math.max(global.devicePixelRatio || 1, 1);
      const w = canvas.clientWidth || 320;
      const h = canvas.clientHeight || 160;
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#0f172a';
      dirty = false;
    }

    function isEmpty() {
      return !dirty;
    }

    function toDataURL() {
      return (!canvas || !dirty) ? '' : canvas.toDataURL('image/png');
    }

    return { init, clear: resizeAndClear, isEmpty, toDataURL };
  })();

  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTimestamp(ms) {
    try {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(new Date(ms));
    } catch (e) {
      return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    }
  }

  function newQueueId() {
    return 'RITQ-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  }

  function ritDisciplineCode(ritNo) {
    const m = String(ritNo || '').toUpperCase().trim().replace(/\s+/g, '-').match(/RIT-[A-Z]+-([A-Z0-9]+)(?:-|$)/);
    return m ? m[1] : '';
  }

  function isOtherDisciplineRow(row) {
    const user = global.PMIS_API.getUser();
    if (!user || !userOptions.discScope) return false;
    const scope = userOptions.discScope;
    if (scope.mode === 'OFF' || (scope.roles || []).indexOf(user.role) === -1) return false;
    const userRaw = (user.discipline || '').trim().toUpperCase();
    if (!userRaw || userRaw === 'ALL') return false;
    const docRaw = ritDisciplineCode(row[0]) || String(row[2] || '').trim();
    if (!docRaw) return false;
    const map = scope.map || {};
    const groups = scope.groups || {};
    const toGroup = (v) => {
      const u = String(v || '').trim().toUpperCase();
      if (groups[u] !== undefined) return u;
      if (map[u]) return map[u];
      const tail = u.split(/[-\s]+/).pop();
      if (groups[tail] !== undefined) return tail;
      if (map[tail]) return map[tail];
      return '*';
    };
    const docCode = toGroup(docRaw);
    if (!docCode || docCode === '*') return false;
    const uCodes = userRaw.split(/[,/;]+/).map((p) => toGroup(p)).filter((g) => g && g !== '*');
    if (!uCodes.length) return false;
    const ancestors = (code) => {
      const out = [];
      let cur = groups[code];
      let guard = 0;
      while (cur && guard++ < 5) { out.push(cur); cur = groups[cur]; }
      return out;
    };
    return !uCodes.some((u) => u === docCode || ancestors(docCode).indexOf(u) !== -1 || ancestors(u).indexOf(docCode) !== -1);
  }

  function statusBadgeClass(raw) {
    const u = String(raw || '').toUpperCase();
    if (u === 'CLOSED' || String(raw).indexOf('종결') !== -1 && String(raw).indexOf('미입력') === -1) return 'badge-green';
    if (u === 'INSP_DONE' || String(raw).indexOf('검측 완료') !== -1) return 'badge-teal';
    if (u === 'INSP_ASSIGNED' || String(raw).indexOf('검측원 배정') !== -1) return 'badge-blue';
    if (u === 'REJECTED' || String(raw).indexOf('반려') !== -1) return 'badge-red';
    if (u === 'CLOSED_COPY_MISSING' || String(raw).indexOf('미입력') !== -1) return 'badge-amber';
    return 'badge-slate';
  }

  function canEditRit(row) {
    const user = global.PMIS_API.getUser();
    if (!user) return false;
    const perms = user.menuPermissions && user.menuPermissions.RIT_TASKS;
    if (user.role !== 'Admin' && perms && !perms.edit) return false;
    const st = String(row[21] || '');
    if (st === 'CLOSED_COPY_MISSING' || st.indexOf('미입력') !== -1) return false;
    return user.role === 'Admin' || user.role === 'RE' || user.role === 'Inspector';
  }

  async function loadTasks(forceOnline) {
    const listEl = document.getElementById('ritTaskList');
    const cacheBanner = document.getElementById('ritCacheBanner');
    if (!listEl) return;
    const user = global.PMIS_API.getUser();
    if (!user) return;

    listEl.innerHTML = '<div class="empty-box">' + escHtml(PMIS_I18N.t('rit_loading')) + '</div>';
    if (cacheBanner) cacheBanner.classList.add('hidden');
    await refreshQueueBanner();

    if (!navigator.onLine && !forceOnline) {
      return showCachedTasks(null);
    }

    try {
      const res = await global.PMIS_API.call('getRitMyTasks', {});
      if (res && res.success && Array.isArray(res.tasks)) {
        allRitTasks = res.tasks;
        if (res.userOptions) userOptions = res.userOptions;
        await global.PMIS_DB.saveTasksCache(user.id, allRitTasks, userOptions).catch(() => {});
        renderTaskList();
      } else {
        throw new Error((res && (res.msg || res.error)) || 'Load failed');
      }
    } catch (err) {
      await showCachedTasks(err);
    }
  }

  async function showCachedTasks(err) {
    const listEl = document.getElementById('ritTaskList');
    const cacheBanner = document.getElementById('ritCacheBanner');
    const user = global.PMIS_API.getUser();
    try {
      const cache = await global.PMIS_DB.loadTasksCache(user && user.id);
      if (!cache || !Array.isArray(cache.tasks) || (Date.now() - (cache.cachedAt || 0)) > PMIS_CONFIG.TASK_CACHE_MAX_AGE_MS) {
        throw new Error('no cache');
      }
      allRitTasks = cache.tasks;
      if (cache.userOptions) userOptions = cache.userOptions;
      if (cacheBanner) {
        cacheBanner.textContent = PMIS_I18N.tf('rit_cache_banner', { time: formatTimestamp(cache.cachedAt).slice(5, 16) });
        cacheBanner.classList.remove('hidden');
      }
      renderTaskList();
    } catch (e) {
      if (listEl) {
        listEl.innerHTML = '<div class="empty-box">' + escHtml(PMIS_I18N.t('rit_no_cache')) + '</div>';
      }
      if (err && global.PMIS_APP && navigator.onLine) {
        global.PMIS_APP.toast(err.message || 'Server error', 'danger');
      }
    }
  }

  function renderTaskList() {
    const listEl = document.getElementById('ritTaskList');
    if (!listEl) return;
    const q = String((document.getElementById('ritSearchInput') || {}).value || '').trim().toLowerCase();
    const filtered = !q ? allRitTasks : allRitTasks.filter((r) => {
      const hay = [r[0], r[2], r[3], r[11], r[20], r[19]].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    if (!filtered.length) {
      listEl.innerHTML = '<div class="empty-box">' + escHtml(PMIS_I18N.t('rit_empty')) + '</div>';
      return;
    }

    const insps = userOptions.insps || [];
    const cards = filtered.map((r) => {
      const ritNo = r[0] || '';
      const rev = (r[1] !== undefined && r[1] !== '') ? String(r[1]) : '0';
      const cat = r[2] || '';
      const subj = r[3] || '';
      const reqDate = r[9] || '-';
      const reqTime = r[10] ? ' ' + r[10] : '';
      const loc = r[11] || '-';
      const insp = r[20] || PMIS_I18N.t('rit_unassigned');
      const st = r[21] || '';
      const otherDisc = isOtherDisciplineRow(r);
      const key = escHtml(ritNo) + '||' + escHtml(rev);
      const editable = canEditRit(r);

      let linksHtml = '';
      if (r[22]) linksHtml += `<a class="chip-link" href="${escHtml(r[22])}" target="_blank" rel="noopener">📄 IN</a>`;
      if (r[25]) linksHtml += `<a class="chip-link" href="${escHtml(r[25])}" target="_blank" rel="noopener">🖼 Photo</a>`;
      if (r[23]) linksHtml += `<a class="chip-link" href="${escHtml(r[23])}" target="_blank" rel="noopener">✅ Closed</a>`;

      let actionsHtml = '';
      if (editable) {
        const optsHtml = ['<option value="">--</option>'].concat(
          insps.map((n) => `<option value="${escHtml(n)}"${n === r[20] ? ' selected' : ''}>${escHtml(n)}</option>`)
        ).join('');
        actionsHtml = `
          <div class="rit-card-actions">
            <div class="assign-row">
              <select class="form-select-sm" data-assign-sel="${key}">${optsHtml}</select>
              <button type="button" class="btn-outline-sm" data-assign-btn="${key}">${escHtml(PMIS_I18N.t('rit_btn_assign'))}</button>
            </div>
            <button type="button" class="btn-primary-full" data-inspect-btn="${key}">📋 ${escHtml(PMIS_I18N.t('rit_btn_inspect'))}</button>
          </div>`;
      }

      return `
        <article class="card rit-card">
          <div class="card-top">
            <div>
              <span class="doc-no">${escHtml(ritNo)}</span>
              <span class="rev-tag">Rev.${escHtml(rev)}</span>
              ${otherDisc ? `<span class="badge-warn">${escHtml(PMIS_I18N.t('rit_other_disc'))}</span>` : ''}
            </div>
            <span class="badge ${statusBadgeClass(st)}">${escHtml(PMIS_I18N.translateStatus(st))}</span>
          </div>
          <div class="card-subject">${escHtml(subj)}</div>
          <div class="card-meta">
            <span>📅 ${escHtml(reqDate + reqTime)}</span>
            <span>📍 ${escHtml(loc)}</span>
          </div>
          <div class="card-meta">
            <span>🏷 ${escHtml(cat || '-')}</span>
            <span>👷 ${escHtml(PMIS_I18N.t('rit_lbl_inspector'))}: <strong>${escHtml(insp)}</strong></span>
          </div>
          ${linksHtml ? `<div class="chip-row">${linksHtml}</div>` : ''}
          ${actionsHtml}
        </article>`;
    }).join('');

    listEl.innerHTML = cards;
  }

  async function assignInspector(ritNo, revNo, inspectorName) {
    if (!inspectorName) return;
    if (!navigator.onLine) {
      global.PMIS_APP.toast(PMIS_I18N.t('att_offline_err'), 'warning');
      return;
    }
    try {
      const res = await global.PMIS_API.call('assignInspector', { ritNo, revNo, inspectorName });
      if (res && res.success) {
        global.PMIS_APP.toast(PMIS_I18N.t('rit_assign_ok'), 'success');
        await loadTasks(true);
      } else {
        global.PMIS_APP.toast(PMIS_I18N.tf('rit_assign_err', { msg: (res && res.msg) || '' }), 'warning');
      }
    } catch (err) {
      global.PMIS_APP.toast(PMIS_I18N.tf('rit_assign_err', { msg: err.message }), 'danger');
    }
  }

  function openInspectionSheet(ritNo, revNo) {
    const targetRev = String(revNo || '0').trim();
    const row = allRitTasks.find((r) => String(r[0]).trim() === ritNo && String(r[1] || '0').trim() === targetRev)
      || allRitTasks.find((r) => String(r[0]).trim() === ritNo);
    if (!row) return;
    currentTarget = row;

    document.getElementById('inspSheetRitNo').textContent = row[0] + ' (Rev.' + targetRev + ')';
    document.getElementById('inspSheetSubject').textContent = row[3] || '';
    document.getElementById('inspSheetMeta').textContent = '📍 ' + (row[11] || '-') + '  |  🏷 ' + (row[2] || '-');
    document.getElementById('inspResultCode').value = '1 - Approved';
    document.getElementById('inspRemarks').value = '';
    stagedPhotos = [];
    renderPhotoGrid();

    const modal = document.getElementById('inspModal');
    modal.classList.remove('hidden');
    sigPad.init(document.getElementById('inspSignatureCanvas'));
    requestAnimationFrame(() => sigPad.clear());
  }

  function closeInspectionSheet() {
    document.getElementById('inspModal').classList.add('hidden');
    currentTarget = null;
  }

  function insertStandardRemark() {
    const rc = document.getElementById('inspResultCode').value || '';
    const rm = document.getElementById('inspRemarks');
    let std = '';
    if (rc.startsWith('1')) std = 'Approved: Works inspected and found compliant with specifications and drawings.';
    else if (rc.startsWith('2')) std = 'Approved with Comments: Work proceeded with minor comments. Pending laboratory test certificate submission.';
    else if (rc.startsWith('3')) std = 'Rejected: Non-compliance observed. Contractor shall rectify defects and submit re-inspection.';
    else if (rc.startsWith('4')) std = 'Canceled: Inspection canceled per contractor request or site condition not ready.';
    if (std) {
      rm.value = rm.value.trim() ? (rm.value.trim() + '\n' + std) : std;
    }
  }

  function renderPhotoGrid() {
    const cnt = document.getElementById('inspPhotoCount');
    const grid = document.getElementById('inspPhotoGrid');
    const camBtn = document.getElementById('inspCameraBtn');
    const albBtn = document.getElementById('inspAlbumBtn');
    const full = stagedPhotos.length >= PHOTO_MAX;
    if (cnt) {
      cnt.textContent = photosBusy
        ? PMIS_I18N.t('rit_photo_processing')
        : PMIS_I18N.tf('rit_photos_label', { n: stagedPhotos.length, max: PHOTO_MAX });
    }
    if (camBtn) camBtn.disabled = photosBusy || full;
    if (albBtn) albBtn.disabled = photosBusy || full;
    if (!grid) return;

    grid.innerHTML = stagedPhotos.map((p, i) => `
      <div class="photo-thumb">
        <img src="${p.dataUrl}" alt="#${i + 1}">
        <span class="photo-idx">#${i + 1}</span>
        <button type="button" class="photo-del" data-del-photo="${i}">✕</button>
      </div>
    `).join('');
  }

  function resizePhotoFile(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(PHOTO_MAX_SIDE / img.naturalWidth, PHOTO_MAX_SIDE / img.naturalHeight, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(objectUrl);
        resolve({
          dataUrl: canvas.toDataURL('image/jpeg', PHOTO_QUALITY),
          width: canvas.width,
          height: canvas.height,
          capturedAt: formatTimestamp(file.lastModified || Date.now())
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Image load error'));
      };
      img.src = objectUrl;
    });
  }

  function addPhotoFiles(input) {
    const files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    if (!files.length || photosBusy) return;
    const room = PHOTO_MAX - stagedPhotos.length;
    if (files.length > room) {
      global.PMIS_APP.toast(PMIS_I18N.tf('rit_photo_limit', { max: PHOTO_MAX }), 'warning');
    }
    const targets = files.slice(0, Math.max(room, 0));
    if (!targets.length) return;
    photosBusy = true;
    renderPhotoGrid();
    targets.reduce((chain, f) =>
      chain.then(() => resizePhotoFile(f))
        .then((photo) => { stagedPhotos.push(photo); })
        .catch(() => {}),
    Promise.resolve()).then(() => {
      photosBusy = false;
      renderPhotoGrid();
    });
  }

  function fitCanvasText(ctx, text, maxWidth, size, minSize, weight) {
    const family = '"Noto Sans KR", "Noto Sans Thai", "Segoe UI", Roboto, sans-serif';
    let cur = size;
    ctx.font = weight + ' ' + cur + 'px ' + family;
    while (ctx.measureText(text).width > maxWidth && cur > minSize) {
      cur--;
      ctx.font = weight + ' ' + cur + 'px ' + family;
    }
    if (ctx.measureText(text).width <= maxWidth) return text;
    const chars = Array.from(text);
    while (chars.length && ctx.measureText(chars.join('') + '…').width > maxWidth) chars.pop();
    return chars.join('') + '…';
  }

  function formatGps(gpsInfo) {
    const m = String(gpsInfo || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    return m ? Number(m[1]).toFixed(6) + ', ' + Number(m[2]).toFixed(6) : String(gpsInfo || 'No GPS');
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = dataUrl;
    });
  }

  async function buildCollage(photos, row, gpsInfo, resultCode) {
    if (!photos.length) return '';
    const imgs = await Promise.all(photos.map((p) => loadImage(p.dataUrl)));
    const cc = document.createElement('canvas');
    const ctx = cc.getContext('2d');
    const cols = 2;
    const rows = Math.ceil(imgs.length / cols);
    const cell = 800;
    const pad = 20;
    const cap = 36;
    const hd = 200;
    cc.width = (cell * cols) + (pad * (cols + 1));
    cc.height = hd + ((cell + cap) * rows) + (pad * (rows + 1));

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cc.width, cc.height);

    // Header bar matching desktop JS_RIT.html
    ctx.fillStyle = '#1e3a5f';
    ctx.fillRect(0, 0, cc.width, hd);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(0, hd - 6, cc.width, 6);

    const user = global.PMIS_API.getUser();
    const dash = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim() || '-';
    const rev = (row[1] !== undefined && row[1] !== '') ? String(row[1]) : '0';
    const lines = [
      '📋 INSPECTION PHOTO SHEET — ' + row[0] + ' (Rev.' + rev + ')',
      '▪ Category: ' + dash(row[2]) + '   |   ▪ Location: ' + dash(row[11]),
      '▪ Subject: ' + dash(row[3]),
      '▪ Date/Time: ' + formatTimestamp(Date.now()).slice(0, 16) + '   |   ▪ GPS: ' + formatGps(gpsInfo) + '   |   ▪ Inspector: ' + dash(user && user.name) + '   |   ▪ Result: ' + dash(resultCode)
    ];
    const specs = [
      { y: 62, size: 44, min: 28, weight: '700' },
      { y: 108, size: 28, min: 20, weight: '500' },
      { y: 146, size: 28, min: 20, weight: '500' },
      { y: 182, size: 26, min: 18, weight: '500' }
    ];
    const maxW = cc.width - 64;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    lines.forEach((line, idx) => {
      const s = specs[idx];
      ctx.fillStyle = idx === 0 ? '#ffffff' : '#e2e8f0';
      ctx.fillText(fitCanvasText(ctx, line, maxW, s.size, s.min, s.weight), 32, s.y);
    });

    imgs.forEach((img, i) => {
      const x = pad + (i % cols) * (cell + pad);
      const y = hd + pad + Math.floor(i / cols) * (cell + cap + pad);
      const sc = Math.min(cell / img.width, cell / img.height);
      ctx.drawImage(img, x + (cell - img.width * sc) / 2, y + (cell - img.height * sc) / 2, img.width * sc, img.height * sc);
      ctx.fillStyle = '#334155';
      ctx.font = '600 24px "Noto Sans KR", "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('#' + (i + 1) + ' (' + String(photos[i].capturedAt).slice(11) + ')', x + cell / 2, y + cell + 28);
    });

    return cc.toDataURL('image/jpeg', 0.8);
  }

  function acquireGps() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(navigator.onLine === false ? 'Offline (No GPS)' : 'No GPS');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos.coords.latitude + ',' + pos.coords.longitude),
        () => resolve(navigator.onLine === false ? 'Offline (No GPS)' : 'No GPS'),
        { enableHighAccuracy: true, timeout: navigator.onLine === false ? 2500 : 5000 }
      );
    });
  }

  function classifyError(msg) {
    const s = String(msg || '');
    if (/\[RIT_(CONFLICT|NOT_FOUND|BAD_REQUEST)\]/.test(s) || /권한이 없습니다|AUTH_FORBIDDEN|srv_auth_forbidden/.test(s)) return 'reject';
    if (/세션이 만료|다시 로그인|AUTH_REQUIRED|srv_auth_required/.test(s)) return 'auth';
    return 'network';
  }

  async function enqueueItem(payload, row, reason) {
    const user = global.PMIS_API.getUser() || {};
    const item = {
      queueId: payload.clientQueueId,
      ritNo: String(payload.ritNo || ''),
      revNo: String(payload.revNo || '0'),
      subject: String((row && row[3]) || ''),
      location: String((row && row[11]) || ''),
      resultCode: payload.resultCode || '',
      remarks: payload.remarks || '',
      gpsInfo: payload.gpsInfo || '',
      photo: payload.photo || '',
      originalPhotos: payload.originalPhotos || [],
      sign: payload.sign || '',
      userId: String(user.id || ''),
      inspectorName: String(user.name || ''),
      capturedAt: payload.capturedAt || Date.now(),
      savedAt: Date.now(),
      status: 'PENDING',
      retryCount: 0,
      lastError: reason || ''
    };
    await global.PMIS_DB.enqueueInspection(item);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    global.PMIS_APP.toast(PMIS_I18N.t(reason ? 'rit_off_saved_fail' : 'rit_off_saved'), 'warning');
    if (classifyError(reason) === 'auth') {
      global.PMIS_APP.toast(PMIS_I18N.t('rit_off_relogin'), 'danger');
    }
    closeInspectionSheet();
    await refreshQueueBanner();
  }

  async function submitInspectionForm() {
    if (!currentTarget) return;
    if (photosBusy) {
      global.PMIS_APP.toast(PMIS_I18N.t('rit_photo_busy'), 'warning');
      return;
    }
    const resultCode = document.getElementById('inspResultCode').value;
    const remarks = document.getElementById('inspRemarks').value.trim();
    const isCode234 = /^[234]/.test(resultCode);
    if (isCode234 && !remarks && !confirm(PMIS_I18N.t('rit_confirm_empty_remark'))) {
      document.getElementById('inspRemarks').focus();
      return;
    }

    const btn = document.getElementById('inspSubmitBtn');
    btn.disabled = true;
    btn.textContent = PMIS_I18N.t('rit_gps_acquiring');

    const row = currentTarget;
    const revNo = (row[1] !== undefined && row[1] !== '') ? String(row[1]) : '0';

    try {
      const gpsInfo = await acquireGps();
      btn.textContent = PMIS_I18N.t('rit_submitting');
      const photos = stagedPhotos.slice();
      const collage = await buildCollage(photos, row, gpsInfo, resultCode);
      const payload = {
        ritNo: row[0],
        revNo: revNo,
        resultCode: resultCode,
        remarks: remarks,
        photo: collage,
        originalPhotos: photos.map((p) => p.dataUrl),
        sign: sigPad.toDataURL(),
        gpsInfo: gpsInfo,
        clientQueueId: newQueueId(),
        capturedAt: Date.now()
      };

      if (!navigator.onLine) {
        await enqueueItem(payload, row, '');
        return;
      }

      const res = await global.PMIS_API.call('submitInspection', payload);
      if (res && res.success) {
        global.PMIS_APP.toast(PMIS_I18N.t('rit_submitted_ok'), 'success');
        closeInspectionSheet();
        await loadTasks(true);
        if (global.PMIS_APP.refreshBadgeCounts) global.PMIS_APP.refreshBadgeCounts();
      } else {
        const msg = (res && (res.msg || res.error)) || 'Server error';
        if (classifyError(msg) === 'reject') {
          global.PMIS_APP.toast(msg, 'danger');
        } else {
          await enqueueItem(payload, row, msg);
        }
      }
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      if (classifyError(msg) === 'reject') {
        global.PMIS_APP.toast(msg, 'danger');
      } else {
        const photos = stagedPhotos.slice();
        const gpsFallback = navigator.onLine === false ? 'Offline (No GPS)' : 'No GPS';
        const collage = await buildCollage(photos, row, gpsFallback, resultCode).catch(() => '');
        await enqueueItem({
          ritNo: row[0],
          revNo: revNo,
          resultCode: resultCode,
          remarks: remarks,
          photo: collage,
          originalPhotos: photos.map((p) => p.dataUrl),
          sign: sigPad.toDataURL(),
          gpsInfo: gpsFallback,
          clientQueueId: newQueueId(),
          capturedAt: Date.now()
        }, row, msg);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = PMIS_I18N.t('btn_submit');
    }
  }

  function myItems(list) {
    const user = global.PMIS_API.getUser();
    const uid = String((user && user.id) || '');
    return (list || []).filter((it) => String(it.userId || '') === uid);
  }

  async function refreshQueueBanner() {
    const box = document.getElementById('ritQueueBanner');
    const topBadge = document.getElementById('topQueueBadge');
    const items = myItems(await global.PMIS_DB.listQueue().catch(() => []));
    if (topBadge) {
      topBadge.textContent = items.length ? String(items.length) : '';
      topBadge.classList.toggle('hidden', items.length === 0);
    }
    if (!box) return;
    if (!items.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      queueListOpen = false;
      return;
    }

    const offline = !navigator.onLine;
    const failed = items.filter((i) => i.status === 'FAILED').length;
    const pending = items.length - failed;

    let html = `
      <div class="queue-banner-head">
        <div class="queue-counts">
          ${pending ? `<span class="badge badge-amber">${escHtml(PMIS_I18N.tf('rit_off_pending', { n: pending }))}</span>` : ''}
          ${failed ? `<span class="badge badge-red">${escHtml(PMIS_I18N.tf('rit_off_failed', { n: failed }))}</span>` : ''}
        </div>
        <div class="queue-btns">
          <button type="button" class="btn-outline-sm" id="qToggleListBtn">${escHtml(PMIS_I18N.t('rit_off_list'))}</button>
          ${pending ? `<button type="button" class="btn-amber-sm" id="qUploadNowBtn" ${(offline || isFlushing) ? 'disabled' : ''}>${escHtml(PMIS_I18N.t('rit_off_upload'))}</button>` : ''}
        </div>
      </div>
      <div id="qProgressArea" class="${isFlushing ? '' : 'hidden'}">
        <div class="progress-track"><div id="qProgressBar" class="progress-fill" style="width:0%"></div></div>
        <div id="qProgressText" class="progress-text"></div>
      </div>`;

    if (queueListOpen) {
      html += '<ul class="queue-list">' + items.map((it) => `
        <li class="queue-item">
          <div class="queue-item-info">
            <div class="fw-bold">${escHtml(it.ritNo)} <small>Rev.${escHtml(it.revNo)}</small> ${it.status === 'FAILED' ? '<span class="badge badge-red">FAILED</span>' : ''}</div>
            <div class="small-muted">${escHtml(it.resultCode || '-')} · ${escHtml(PMIS_I18N.tf('rit_off_photos', { n: (it.originalPhotos || []).length }))} · ${escHtml(formatTimestamp(it.savedAt).slice(5, 16))}</div>
            ${it.lastError ? `<div class="small-err">${escHtml(String(it.lastError).slice(0, 160))}</div>` : ''}
          </div>
          <div class="queue-item-acts">
            <button type="button" class="btn-outline-sm" data-q-retry="${escHtml(it.queueId)}" ${(offline || isFlushing) ? 'disabled' : ''}>${escHtml(PMIS_I18N.t('rit_off_retry'))}</button>
            <button type="button" class="btn-danger-sm" data-q-del="${escHtml(it.queueId)}" ${isFlushing ? 'disabled' : ''}>${escHtml(PMIS_I18N.t('rit_off_delete'))}</button>
          </div>
        </li>
      `).join('') + '</ul>';
    }

    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  async function flushQueue(opts) {
    opts = opts || {};
    if (isFlushing || !navigator.onLine) return;
    if (!global.PMIS_API.getAuthToken()) {
      const ok = await global.PMIS_API.trySilentRenew();
      if (!ok) {
        if (!opts.auto) global.PMIS_APP.toast(PMIS_I18N.t('rit_off_relogin'), 'danger');
        return;
      }
    }

    const all = myItems(await global.PMIS_DB.listQueue().catch(() => []));
    const targets = opts.onlyId
      ? all.filter((i) => i.queueId === opts.onlyId)
      : all.filter((i) => i.status !== 'FAILED');
    if (!targets.length) return;

    isFlushing = true;
    await refreshQueueBanner();
    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      const bar = document.getElementById('qProgressBar');
      const txt = document.getElementById('qProgressText');
      if (bar) bar.style.width = Math.round((i / targets.length) * 100) + '%';
      if (txt) txt.textContent = PMIS_I18N.tf('rit_off_uploading', { i: i + 1, n: targets.length });

      try {
        const res = await global.PMIS_API.call('submitInspection', {
          ritNo: it.ritNo,
          revNo: it.revNo,
          resultCode: it.resultCode,
          remarks: it.remarks,
          photo: it.photo,
          originalPhotos: it.originalPhotos,
          sign: it.sign,
          gpsInfo: it.gpsInfo,
          clientQueueId: it.queueId,
          capturedAt: it.capturedAt
        });
        if (res && res.success) {
          await global.PMIS_DB.removeQueueItem(it.queueId);
          okCount++;
        } else {
          const msg = (res && (res.msg || res.error)) || 'Submit failed';
          const kind = classifyError(msg);
          if (kind === 'reject') {
            await global.PMIS_DB.updateQueueItem(it.queueId, {
              status: 'FAILED', retryCount: (it.retryCount || 0) + 1, lastError: msg
            });
            failCount++;
          } else {
            await global.PMIS_DB.updateQueueItem(it.queueId, {
              retryCount: (it.retryCount || 0) + 1, lastError: msg
            });
            if (kind === 'auth') global.PMIS_APP.toast(PMIS_I18N.t('rit_off_relogin'), 'danger');
            break;
          }
        }
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        await global.PMIS_DB.updateQueueItem(it.queueId, {
          retryCount: (it.retryCount || 0) + 1, lastError: msg
        });
        break;
      }
    }

    isFlushing = false;
    await refreshQueueBanner();
    if (okCount > 0 && failCount === 0) {
      global.PMIS_APP.toast(PMIS_I18N.tf('rit_off_done_all', { n: okCount }), 'success');
      loadTasks(true);
    } else if (okCount > 0 || failCount > 0) {
      global.PMIS_APP.toast(PMIS_I18N.tf('rit_off_done_partial', { ok: okCount, fail: failCount }), 'warning');
      if (okCount > 0) loadTasks(true);
    }
  }

  function scheduleAutoFlush() {
    clearTimeout(onlineTimer);
    onlineTimer = setTimeout(() => { flushQueue({ auto: true }); }, 3000);
  }

  function bindEvents() {
    const search = document.getElementById('ritSearchInput');
    if (search) search.addEventListener('input', renderTaskList);

    const listEl = document.getElementById('ritTaskList');
    if (listEl) {
      listEl.addEventListener('click', (ev) => {
        const inspBtn = ev.target.closest('[data-inspect-btn]');
        if (inspBtn) {
          const parts = inspBtn.getAttribute('data-inspect-btn').split('||');
          openInspectionSheet(parts[0], parts[1]);
          return;
        }
        const assignBtn = ev.target.closest('[data-assign-btn]');
        if (assignBtn) {
          const key = assignBtn.getAttribute('data-assign-btn');
          const sel = listEl.querySelector(`[data-assign-sel="${CSS.escape(key)}"]`);
          const parts = key.split('||');
          if (sel && sel.value) assignInspector(parts[0], parts[1], sel.value);
        }
      });
    }

    const qBanner = document.getElementById('ritQueueBanner');
    if (qBanner) {
      qBanner.addEventListener('click', async (ev) => {
        if (ev.target.id === 'qToggleListBtn') {
          queueListOpen = !queueListOpen;
          refreshQueueBanner();
        } else if (ev.target.id === 'qUploadNowBtn') {
          flushQueue({});
        } else if (ev.target.closest('[data-q-retry]')) {
          const qid = ev.target.closest('[data-q-retry]').getAttribute('data-q-retry');
          flushQueue({ onlyId: qid });
        } else if (ev.target.closest('[data-q-del]')) {
          const qid = ev.target.closest('[data-q-del]').getAttribute('data-q-del');
          if (!isFlushing && confirm(PMIS_I18N.t('rit_off_confirm_del'))) {
            await global.PMIS_DB.removeQueueItem(qid);
            refreshQueueBanner();
          }
        }
      });
    }

    document.getElementById('inspCloseBtn').addEventListener('click', closeInspectionSheet);
    document.getElementById('inspCancelBtn').addEventListener('click', closeInspectionSheet);
    document.getElementById('inspStdRemarkBtn').addEventListener('click', insertStandardRemark);
    document.getElementById('inspSignClearBtn').addEventListener('click', () => sigPad.clear());
    document.getElementById('inspSubmitBtn').addEventListener('click', submitInspectionForm);

    const camInput = document.getElementById('inspCameraInput');
    const albInput = document.getElementById('inspAlbumInput');
    document.getElementById('inspCameraBtn').addEventListener('click', () => camInput.click());
    document.getElementById('inspAlbumBtn').addEventListener('click', () => albInput.click());
    camInput.addEventListener('change', (e) => addPhotoFiles(e.target));
    albInput.addEventListener('change', (e) => addPhotoFiles(e.target));
    document.getElementById('inspPhotoGrid').addEventListener('click', (ev) => {
      const del = ev.target.closest('[data-del-photo]');
      if (!del) return;
      stagedPhotos.splice(Number(del.getAttribute('data-del-photo')), 1);
      renderPhotoGrid();
    });
  }

  global.PMIS_RIT = {
    bindEvents,
    loadTasks,
    renderTaskList,
    refreshQueueBanner,
    flushQueue,
    scheduleAutoFlush
  };
})(window);
