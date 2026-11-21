/* U-Tapao PMIS Mobile — 앱 화면 자동 업데이트 (설치형 앱 전용, Capgo 플러그인 직접 운영 방식)
 *
 * 흐름
 *  1) 앱이 켜지면 boot(): 현재 화면이 정상 동작함을 알림(notifyAppReady → 실패 시 플러그인이 이전 화면으로 자동 복귀)
 *     → 지난번에 받아 둔 새 화면이 있으면 "앱을 켜는 순간"에만 적용(set → 즉시 재시작).
 *     작업 도중(사진 촬영으로 앱이 잠시 뒤로 가는 경우 등)에는 절대 바꾸지 않는다(next() 미사용).
 *  2) 3초 뒤 서버(getAppUpdate)에 최신 화면 정보를 물어 새 버전이면 백그라운드로 내려받고(zip CRC32 검증)
 *     "다음에 앱을 열 때 적용 / 지금 적용" 배너 표시.
 *  3) 새 휴대폰 기능이 필요한 화면(minNative)이면 내려받지 않고 "새 앱 설치" 안내(Drive APK 링크)만 표시.
 *  - 브라우저·PWA(아이폰 홈 화면 앱)에서는 아무 동작도 하지 않는다(서비스워커가 갱신 담당).
 *  - 서버·통신 오류는 조용히 무시(로그인·업무 흐름을 막지 않음).
 */
(function (global) {
  const LS_PENDING = 'pmis_mobile_upd_pending_v1';   // { id, label, build }
  const LS_FAILED = 'pmis_mobile_upd_failed_v1';     // 적용 실패(자동 복귀)한 label
  const LS_LAST_CHECK = 'pmis_mobile_upd_last_v1';
  const LS_APPLIED_NOTICE = 'pmis_mobile_upd_applied_v1';
  const CHECK_INTERVAL_MS = 30 * 60 * 1000;
  const PLUGIN_TIMEOUT_MS = 3000;

  const state = {
    status: 'idle',            // idle | checking | latest | downloading | ready | apk_required | apk_available | error | unsupported
    nativeVersion: '',
    nativeBuild: 0,
    latest: null,
    error: ''
  };
  let checking = null;

  function t(key) { return (global.PMIS_I18N && global.PMIS_I18N.t) ? global.PMIS_I18N.t(key) : key; }
  function tf(key, p) { return (global.PMIS_I18N && global.PMIS_I18N.tf) ? global.PMIS_I18N.tf(key, p) : key; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function lsJson(k) { try { const v = lsGet(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  function isNative() {
    const C = global.Capacitor;
    return !!(C && C.isNativePlatform && C.isNativePlatform());
  }
  function plugin() {
    const C = global.Capacitor;
    return (isNative() && C.Plugins && C.Plugins.CapacitorUpdater) ? C.Plugins.CapacitorUpdater : null;
  }
  function webInfo() {
    const w = global.PMIS_WEB_BUNDLE || {};
    return { build: Number(w.build) || 0, label: String(w.label || 'builtin'), minNative: Number(w.minNative) || 0 };
  }
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  }
  // versionName "0.9.3.103" → 103 (설치형 앱 빌드 번호 = versionCode)
  function parseNativeBuild(name) {
    const m = String(name || '').match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  async function readNative() {
    const p = plugin();
    if (!p) return;
    try {
      const cur = await withTimeout(p.current(), PLUGIN_TIMEOUT_MS);
      state.nativeVersion = String((cur && cur.native) || '');
      state.nativeBuild = parseNativeBuild(state.nativeVersion);
    } catch (e) {}
  }

  /* ---------- 배너 ---------- */
  function banner(kind, text, actionLabel, onAction) {
    let el = document.getElementById('appUpdateBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appUpdateBanner';
      el.className = 'upd-banner';
      document.body.appendChild(el);
    }
    el.className = 'upd-banner upd-' + kind;
    el.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'upd-msg';
    msg.textContent = text;
    el.appendChild(msg);
    const btns = document.createElement('div');
    btns.className = 'upd-btns';
    if (actionLabel && onAction) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'upd-btn-main';
      b.textContent = actionLabel;
      b.addEventListener('click', onAction);
      btns.appendChild(b);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'upd-btn-close';
    x.textContent = t('upd_later');
    x.addEventListener('click', () => el.remove());
    btns.appendChild(x);
    el.appendChild(btns);
  }

  function openExternal(url) {
    if (!url) return;
    try { global.location.href = url; } catch (e) {}   // 설치형 앱: 외부 주소는 시스템 브라우저로 열림
  }

  function renderSettings() {
    const verEl = document.getElementById('updVersionText');
    const stEl = document.getElementById('updStatusText');
    if (!verEl || !stEl) return;
    const w = webInfo();
    verEl.textContent = tf('upd_version_line', {
      web: w.label,
      app: state.nativeVersion || (isNative() ? '-' : 'PWA')
    });
    let s = '';
    const L = state.latest || {};
    switch (state.status) {
      case 'checking': s = t('upd_st_checking'); break;
      case 'latest': s = t('upd_st_latest'); break;
      case 'downloading': s = t('upd_st_downloading'); break;
      case 'ready': s = tf('upd_st_ready', { ver: (lsJson(LS_PENDING) || {}).label || '' }); break;
      case 'apk_required': s = tf('upd_st_apk_required', { ver: (L.apk && L.apk.versionName) || '' }); break;
      case 'apk_available': s = tf('upd_st_apk_available', { ver: (L.apk && L.apk.versionName) || '' }); break;
      case 'unsupported': s = t('upd_st_unsupported'); break;
      case 'error': s = tf('upd_st_error', { msg: state.error || '' }); break;
      default: s = '';
    }
    stEl.textContent = s;
    const apkBtn = document.getElementById('updApkBtn');
    if (apkBtn) apkBtn.classList.toggle('hidden', !(L.apk && L.apk.url && (state.status === 'apk_required' || state.status === 'apk_available')));
    const applyBtn = document.getElementById('updApplyBtn');
    if (applyBtn) applyBtn.classList.toggle('hidden', state.status !== 'ready');
  }

  function setStatus(st, err) {
    state.status = st;
    state.error = err || '';
    renderSettings();
  }

  /* ---------- 적용 ---------- */
  async function applyPending(reason) {
    const p = plugin();
    const pend = lsJson(LS_PENDING);
    if (!p || !pend || !pend.id) return false;
    try {
      lsSet(LS_APPLIED_NOTICE, pend.label || '');
      await withTimeout(p.set({ id: String(pend.id) }), 8000);   // 성공 시 화면이 즉시 다시 열림
      return true;
    } catch (e) {
      // 받아 둔 화면이 지워졌거나(새 APK 설치 등) 적용 실패 → 대기 정보 정리, 다음 확인 때 다시 받음
      lsSet(LS_PENDING, null);
      lsSet(LS_APPLIED_NOTICE, null);
      return false;
    }
  }

  /**
   * 앱 시작 시 1회 호출. true 를 돌려주면 새 화면으로 다시 여는 중이므로 로그인 등을 진행하지 않는다.
   */
  async function boot() {
    const p = plugin();
    if (!p) { renderSettings(); return false; }
    const w = webInfo();
    try { await withTimeout(p.notifyAppReady(), PLUGIN_TIMEOUT_MS); } catch (e) {}
    await readNative();

    // 방금 새 화면으로 바뀐 경우 안내 1회
    const notice = lsGet(LS_APPLIED_NOTICE);
    if (notice && notice === w.label) {
      lsSet(LS_APPLIED_NOTICE, null);
      lsSet(LS_PENDING, null);
      setTimeout(() => { if (global.PMIS_APP) global.PMIS_APP.toast(tf('upd_applied', { ver: w.label }), 'success'); }, 600);
    } else if (notice && notice !== w.label) {
      // 새 화면 적용을 시도했지만 이전 화면으로 되돌아옴(자동 복귀) → 같은 버전 재시도 금지
      lsSet(LS_FAILED, notice);
      lsSet(LS_APPLIED_NOTICE, null);
      lsSet(LS_PENDING, null);
    }

    const pend = lsJson(LS_PENDING);
    if (pend && pend.id) {
      if (Number(pend.build) > w.build && pend.label !== lsGet(LS_FAILED)) {
        const applied = await applyPending('launch');
        if (applied) return true;
      } else {
        lsSet(LS_PENDING, null);   // 이미 같은/더 높은 화면(새 APK 설치 등)
      }
    }
    setTimeout(() => { check({ silent: true }); }, 3000);
    renderSettings();
    return false;
  }

  /* ---------- 확인·내려받기 ---------- */
  async function check(opts) {
    opts = opts || {};
    if (!isNative()) { setStatus('unsupported'); return state; }
    if (checking) return checking;
    if (opts.silent) {
      const last = Number(lsGet(LS_LAST_CHECK) || 0);
      if (opts.throttle && Date.now() - last < CHECK_INTERVAL_MS) return state;
    }
    checking = (async () => {
      setStatus('checking');
      try {
        await readNative();
        const w = webInfo();
        const res = await global.PMIS_API.call('getAppUpdate', {
          web: w.build, webLabel: w.label, nativeBuild: state.nativeBuild, nativeVersion: state.nativeVersion
        }, { noRenew: true, timeoutMs: 20000 });
        lsSet(LS_LAST_CHECK, String(Date.now()));
        if (!res || !res.success) throw new Error((res && (res.msg || res.error)) || 'server');
        state.latest = res;
        const web = res.web || null;
        const apk = res.apk || null;
        const p = plugin();

        if (web && Number(web.build) > w.build && web.url) {
          // 1) 새 화면이 지금 설치된 앱으로는 동작하지 않음 → 새 APK 설치 안내
          if (!p || Number(web.minNative || 0) > state.nativeBuild) {
            setStatus('apk_required');
            if (apk && apk.url) banner('apk', tf('upd_banner_apk', { ver: apk.versionName || '' }), t('upd_btn_apk'), () => openExternal(apk.url));
            return state;
          }
          // 2) 지난번 적용이 실패한 같은 버전이면 다시 받지 않음
          if (String(web.label) === lsGet(LS_FAILED)) { setStatus('latest'); return state; }
          // 3) 이미 받아 둠
          const pend = lsJson(LS_PENDING);
          if (pend && pend.label === String(web.label)) {
            setStatus('ready');
            if (!opts.silent) banner('ready', tf('upd_banner_ready', { ver: web.label }), t('upd_btn_apply'), () => applyPending('user'));
            return state;
          }
          setStatus('downloading');
          const dl = { url: String(web.url), version: String(web.label) };
          if (web.checksum) dl.checksum = String(web.checksum);
          const b = await p.download(dl);
          lsSet(LS_PENDING, JSON.stringify({ id: b.id, label: String(web.label), build: Number(web.build) }));
          setStatus('ready');
          banner('ready', tf('upd_banner_ready', { ver: web.label }), t('upd_btn_apply'), () => applyPending('user'));
          return state;
        }
        // 화면은 최신. 더 새 설치 앱이 있으면 설정 화면에만 안내(필수 아님)
        if (apk && apk.url && Number(apk.versionCode || 0) > state.nativeBuild && state.nativeBuild > 0) {
          setStatus('apk_available');
          if (apk.required) banner('apk', tf('upd_banner_apk', { ver: apk.versionName || '' }), t('upd_btn_apk'), () => openExternal(apk.url));
          return state;
        }
        setStatus('latest');
        return state;
      } catch (e) {
        setStatus('error', e && e.message ? e.message : String(e));
        return state;
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  function bindEvents() {
    const btn = document.getElementById('updCheckBtn');
    if (btn) btn.addEventListener('click', () => check({ silent: false }));
    const apkBtn = document.getElementById('updApkBtn');
    if (apkBtn) apkBtn.addEventListener('click', () => {
      const L = state.latest || {};
      if (L.apk && L.apk.url) openExternal(L.apk.url);
    });
    const applyBtn = document.getElementById('updApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', () => applyPending('user'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check({ silent: true, throttle: true });
    });
    renderSettings();
  }

  global.PMIS_UPDATER = {
    boot,
    check,
    bindEvents,
    rerender: renderSettings,
    getState: () => Object.assign({}, state, { web: webInfo() }),
    _parseNativeBuild: parseNativeBuild
  };
})(window);
