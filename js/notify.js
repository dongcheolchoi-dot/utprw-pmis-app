/* U-Tapao PMIS Mobile — 앱 자체 알림 엔진 (외부 메신저 비용 없음, 2026-11-20)
 * - 주기적으로 getNotificationFeed(내 결재함)를 받아 직전 목록과 비교 → 새 건만 알림
 *   · RIT_ASSIGNED: 내게 배정된 RIT 검측 / NEW_TASK: 신규 검토·결재 / 마감 임박·지남: 하루 1회 요약
 * - 표시: 인앱 배너(토스트) + 🔔 목록 + 하단 결재함 배지 + 앱 아이콘 배지(지원 기기)
 *         + 기기 알림(브라우저·PWA 에서 권한 허용 시, 서비스워커 showNotification) + 소리·진동(설정)
 * - 첫 확인은 기준선으로만 저장(기존 미결 전체가 한꺼번에 울리지 않도록)
 * - 알림 실패·권한 거부는 조용히 넘어감 (업무 기능과 분리)
 */
(function (global) {
  const LIST_MAX = 30;
  const st = { prefs: null, timer: null, polling: false, user: null, list: [] };

  function T(k) { return global.PMIS_I18N.t(k); }
  function TF(k, p) { return global.PMIS_I18N.tf(k, p); }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const $ = (id) => document.getElementById(id);
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function uid() { const u = global.PMIS_API.getUser(); return u ? String(u.id || '').toLowerCase() : ''; }
  function kSeen() { return 'pmis_notify_seen_v1_' + uid(); }
  function kList() { return 'pmis_notify_list_v1_' + uid(); }
  const K_PREFS = 'pmis_notify_prefs_v1';
  const DEFAULTS = { notifyRitAssigned: true, notifyNewTask: true, notifyReminder: true, sound: true, vibrate: true, pollMinutes: 5 };
  function isNative() { return !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()); }

  // ───────── 권한 ─────────
  function permissionState() {
    if (isNative() || !('Notification' in global)) return 'unsupported';
    return global.Notification.permission;   // default | granted | denied
  }
  async function requestPermission() {
    if (permissionState() === 'unsupported') { renderSettings(); return 'unsupported'; }
    try { await global.Notification.requestPermission(); } catch (e) {}
    renderSettings();
    return permissionState();
  }

  // ───────── 알림 표시 ─────────
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (global.AudioContext || global.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
      o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.4);
    } catch (e) {}
  }

  async function systemNotify(title, body, tab, tag) {
    if (permissionState() !== 'granted') return false;
    try {
      const opts = { body: body, tag: tag || 'pmis', icon: './assets/icon-192.png', badge: './assets/icon-192.png', data: { tab: tab || 'tasks' }, renotify: true };
      if (st.prefs && st.prefs.vibrate) opts.vibrate = [120, 60, 120];
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
      }
      const n = new global.Notification(title, opts);
      n.onclick = () => { try { global.focus(); } catch (e) {} openTab(tab); n.close(); };
      return true;
    } catch (e) { return false; }
  }

  function notify(title, body, opts) {
    opts = opts || {};
    const item = { title, body, tab: opts.tab || 'tasks', at: Date.now(), read: false };
    st.list.unshift(item);
    st.list = st.list.slice(0, LIST_MAX);
    lsSet(kList(), st.list);
    renderBell();
    if (global.PMIS_APP) global.PMIS_APP.toast('🔔 ' + title + (body ? ' — ' + body : ''), 'info');
    const p = st.prefs || DEFAULTS;
    if (p.sound) beep();
    if (p.vibrate && navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
    systemNotify(title, body, item.tab, opts.tag).catch(() => {});
  }

  function openTab(tab) {
    if (global.PMIS_APP && global.PMIS_APP.switchTab) global.PMIS_APP.switchTab(tab || 'tasks');
  }

  // ───────── 배지 ─────────
  function setBadges(total) {
    const nb = $('navTasksBadge');
    if (nb) { nb.textContent = total ? String(total) : ''; nb.classList.toggle('hidden', !total); }
    try {
      if (navigator.setAppBadge) { if (total) navigator.setAppBadge(total); else navigator.clearAppBadge(); }
    } catch (e) {}
  }
  function renderBell() {
    const unread = st.list.filter((x) => !x.read).length;
    const b = $('headerBellBadge');
    if (b) { b.textContent = unread > 9 ? '9+' : String(unread); b.classList.toggle('hidden', !unread); }
  }

  // ───────── 확인(폴링) ─────────
  function typeAllowed(type) {
    const p = st.prefs || DEFAULTS;
    return type === 'RIT_ASSIGNED' ? p.notifyRitAssigned : p.notifyNewTask;
  }

  async function poll() {
    if (st.polling || !navigator.onLine || !global.PMIS_API.getAuthToken()) return;
    st.polling = true;
    try {
      const res = await global.PMIS_API.call('getNotificationFeed', {});
      if (!res || !res.success) return;
      if (res.prefs) { st.prefs = Object.assign({}, DEFAULTS, res.prefs); lsSet(K_PREFS, st.prefs); }
      setBadges((res.counts && res.counts.total) || 0);
      const items = res.items || [];
      const seen = lsGet(kSeen());
      const curKeys = items.map((i) => i.key);
      if (!seen || !Array.isArray(seen.keys)) {
        lsSet(kSeen(), { keys: curKeys, remindDay: res.today });   // 첫 확인: 기준선만 저장
        return;
      }
      const seenSet = new Set(seen.keys);
      const fresh = items.filter((i) => !seenSet.has(i.key) && typeAllowed(i.type));
      if (fresh.length > 3) {
        const ritN = fresh.filter((i) => i.type === 'RIT_ASSIGNED').length;
        notify(TF('nt_many_title', { n: fresh.length }), ritN ? TF('nt_many_body_rit', { rit: ritN, other: fresh.length - ritN }) : T('nt_tap_to_open'), { tab: ritN === fresh.length ? 'rit' : 'tasks', tag: 'pmis-many' });
      } else {
        fresh.forEach((i) => {
          const isRit = i.type === 'RIT_ASSIGNED';
          notify(isRit ? T('nt_rit_assigned') : TF('nt_new_task', { mod: i.mod }),
            (i.docNo ? i.docNo + (i.rev && i.rev !== '0' ? ' R' + i.rev : '') + ' · ' : '') + (i.title || ''),
            { tab: isRit ? 'rit' : 'tasks', tag: 'pmis-' + i.key });
        });
      }
      let remindDay = seen.remindDay || '';
      const p = st.prefs || DEFAULTS;
      if (p.notifyReminder && remindDay !== res.today) {
        const over = items.filter((i) => i.overdue).length;
        const soon = items.filter((i) => i.dueSoon).length;
        if (over || soon) notify(T('nt_reminder_title'), TF('nt_reminder_body', { soon: soon, over: over }), { tab: 'tasks', tag: 'pmis-reminder' });
        remindDay = res.today;
      }
      lsSet(kSeen(), { keys: curKeys, remindDay: remindDay });
    } catch (e) {
      /* 네트워크 오류 등은 다음 주기에 재시도 */
    } finally {
      st.polling = false;
    }
  }

  function schedule() {
    if (st.timer) clearInterval(st.timer);
    const min = Math.max(3, Math.min(30, Number((st.prefs || DEFAULTS).pollMinutes) || 5));
    st.timer = setInterval(poll, min * 60000);
  }

  // ───────── 시작 / 종료 ─────────
  async function start() {
    st.user = global.PMIS_API.getUser();
    st.prefs = Object.assign({}, DEFAULTS, lsGet(K_PREFS) || {});
    st.list = lsGet(kList()) || [];
    renderBell();
    if (navigator.onLine) {
      try {
        const res = await global.PMIS_API.call('getNotificationPrefs', {});
        if (res && res.success && res.prefs) { st.prefs = Object.assign({}, DEFAULTS, res.prefs); lsSet(K_PREFS, st.prefs); }
      } catch (e) {}
    }
    schedule();
    setTimeout(poll, 5000);
  }
  function stop() {
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
  }

  // ───────── 설정 화면 (앱 설정 모달 안 '알림 설정') ─────────
  function renderSettings() {
    const p = st.prefs || DEFAULTS;
    const set = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
    set('ntRitChk', p.notifyRitAssigned);
    set('ntTaskChk', p.notifyNewTask);
    set('ntRemindChk', p.notifyReminder);
    set('ntSoundChk', p.sound);
    set('ntVibrateChk', p.vibrate);
    const sel = $('ntPollSel'); if (sel) sel.value = String(p.pollMinutes || 5);
    const perm = permissionState();
    const lbl = $('ntPermState');
    if (lbl) {
      const map = { granted: ['nt_perm_granted', 'badge-green'], denied: ['nt_perm_denied', 'badge-red'], default: ['nt_perm_default', 'badge-amber'], unsupported: ['nt_perm_unsupported', 'badge-slate'] };
      const m = map[perm] || map.unsupported;
      lbl.textContent = T(m[0]);
      lbl.className = 'badge ' + m[1];
    }
    const btn = $('ntPermBtn'); if (btn) btn.classList.toggle('hidden', perm !== 'default');
    const hint = $('ntPermHint');
    if (hint) hint.textContent = perm === 'unsupported' ? T('nt_hint_unsupported') : (perm === 'denied' ? T('nt_hint_denied') : '');
  }

  async function savePrefsFromUi() {
    const g = (id) => { const el = $(id); return el ? el.checked : false; };
    st.prefs = Object.assign({}, st.prefs || DEFAULTS, {
      notifyRitAssigned: g('ntRitChk'), notifyNewTask: g('ntTaskChk'), notifyReminder: g('ntRemindChk'),
      sound: g('ntSoundChk'), vibrate: g('ntVibrateChk'), pollMinutes: Number(($('ntPollSel') || {}).value || 5)
    });
    lsSet(K_PREFS, st.prefs);
    schedule();
    if (!navigator.onLine) { if (global.PMIS_APP) global.PMIS_APP.toast(T('nt_saved_local'), 'info'); return; }
    try {
      const res = await global.PMIS_API.call('saveNotificationPrefs', { prefs: st.prefs });
      if (res && res.success) { st.prefs = Object.assign({}, DEFAULTS, res.prefs); lsSet(K_PREFS, st.prefs); if (global.PMIS_APP) global.PMIS_APP.toast(T('nt_saved'), 'success'); }
    } catch (e) {
      if (global.PMIS_APP) global.PMIS_APP.toast(T('nt_saved_local'), 'info');
    }
  }

  function sendTest() {
    notify(T('nt_test_title'), T('nt_test_body'), { tab: 'tasks', tag: 'pmis-test' });
  }

  // ───────── 🔔 목록 모달 ─────────
  function openList() {
    const modal = $('notifyModal');
    if (!modal) return;
    renderList();
    modal.classList.remove('hidden');
  }
  function renderList() {
    const el = $('notifyList');
    if (!el) return;
    if (!st.list.length) { el.innerHTML = '<div class="empty-box">' + escHtml(T('nt_list_empty')) + '</div>'; return; }
    el.innerHTML = st.list.map((x, i) =>
      '<button type="button" class="nt-row' + (x.read ? '' : ' unread') + '" data-nt-idx="' + i + '">' +
        '<div class="nt-title">' + escHtml(x.title) + '</div>' +
        (x.body ? '<div class="small-muted">' + escHtml(x.body) + '</div>' : '') +
        '<div class="small-muted">' + escHtml(new Date(x.at).toLocaleString()) + '</div>' +
      '</button>').join('');
  }
  function markAllRead() {
    st.list.forEach((x) => { x.read = true; });
    lsSet(kList(), st.list);
    renderBell(); renderList();
  }

  function bindEvents() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('headerBellBtn', 'click', openList);
    on('notifyCloseBtn', 'click', () => $('notifyModal').classList.add('hidden'));
    on('notifyReadAllBtn', 'click', markAllRead);
    on('ntPermBtn', 'click', requestPermission);
    on('ntTestBtn', 'click', sendTest);
    ['ntRitChk', 'ntTaskChk', 'ntRemindChk', 'ntSoundChk', 'ntVibrateChk', 'ntPollSel'].forEach((id) => on(id, 'change', savePrefsFromUi));
    const list = $('notifyList');
    if (list) list.addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-nt-idx]');
      if (!row) return;
      const x = st.list[Number(row.getAttribute('data-nt-idx'))];
      if (x) { x.read = true; lsSet(kList(), st.list); renderBell(); }
      $('notifyModal').classList.add('hidden');
      openTab(x && x.tab);
    });
    // 서비스워커 알림 클릭 → 해당 탭 열기
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'PMIS_OPEN_TAB') openTab(ev.data.tab);
      });
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && st.timer) poll(); });
  }

  global.PMIS_NOTIFY = { start, stop, poll, bindEvents, renderSettings, requestPermission, sendTest, rerender: () => { renderSettings(); renderList(); } };
})(window);
