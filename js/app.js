/* U-Tapao PMIS Mobile Main Controller (Auth, Attendance, My Tasks, Daily Briefing, PWA/Capacitor) */
(function (global) {
  let activeTab = 'rit';
  let tasksData = null;
  let tasksFilter = 'ALL';
  let dailyData = null;
  let clockTimer = null;
  let renewTimer = null;

  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBangkokNow() {
    try {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: PMIS_CONFIG.TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(new Date());
    } catch (e) {
      return new Date().toISOString().slice(0, 19).replace('T', ' ');
    }
  }

  function toast(msg, type) {
    const box = document.getElementById('toastBox');
    if (!box) return;
    box.textContent = msg;
    box.className = 'toast-box toast-' + (type || 'info');
    box.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => box.classList.add('hidden'), 3600);
  }

  function updateNetworkBadge() {
    const online = navigator.onLine !== false;
    const badge = document.getElementById('netStatusBadge');
    if (badge) {
      badge.textContent = online ? ('🟢 ' + PMIS_I18N.t('net_online')) : ('🔴 ' + PMIS_I18N.t('net_offline'));
      badge.className = 'net-badge ' + (online ? 'online' : 'offline');
    }
    if (global.PMIS_RIT) global.PMIS_RIT.refreshQueueBanner();
  }

  function showAuthenticatedWorkspace(user) {
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('mainView').classList.remove('hidden');
    document.getElementById('headerUserChip').textContent = (user.name || user.id) + ' (' + (user.role || '') + ')';

    // Keep session warm every 10 min when online
    clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      if (navigator.onLine) global.PMIS_API.trySilentRenew();
    }, 10 * 60 * 1000);

    if (user.todayAttendance) renderAttendanceCard(user.todayAttendance, null);
    switchTab(activeTab || 'rit');
    if (navigator.onLine) global.PMIS_RIT.scheduleAutoFlush();
    if (global.PMIS_FIELDMAP) global.PMIS_FIELDMAP.resume();   // 이 기기에서 위치 공유가 켜져 있었으면 자동 갱신 재개
    if (global.PMIS_OBS && navigator.onLine) setTimeout(() => global.PMIS_OBS.flushQueue(), 4000);   // 오프라인 보관 특이사항 전송
    if (global.PMIS_NOTIFY) global.PMIS_NOTIFY.start();   // 앱 자체 알림 엔진 (결재함 변화 확인)
    // 기기 알림을 눌러 앱이 새로 열린 경우 (#tab=rit 등) 해당 탭으로 이동
    const hashTab = (location.hash.match(/tab=(rit|att|tasks|daily|map)/) || [])[1];
    if (hashTab) { history.replaceState(null, '', location.pathname); switchTab(hashTab); }
  }

  function showLoginView() {
    clearInterval(renewTimer);
    document.getElementById('mainView').classList.add('hidden');
    document.getElementById('loginView').classList.remove('hidden');
  }

  async function tryAutoLogin() {
    const rmb = global.PMIS_API.getRememberToken();
    const snap = global.PMIS_API.getStoredUserSnapshot();
    if (!rmb || rmb.indexOf('rmb_') !== 0) {
      showLoginView();
      return;
    }

    // Complete offline launch support: if device is offline and has rmb_ + user snapshot, open offline workspace immediately
    if (!navigator.onLine && snap) {
      global.PMIS_API.setSession(snap);
      showAuthenticatedWorkspace(snap);
      return;
    }

    const statusEl = document.getElementById('loginAutoStatus');
    if (statusEl) {
      statusEl.textContent = PMIS_I18N.t('login_auto_restoring');
      statusEl.classList.remove('hidden');
    }

    try {
      const res = await global.PMIS_API.call('resumeRememberedLogin', {
        rememberToken: rmb,
        clientInfo: { deviceSummary: global.PMIS_API.getDeviceSummary() },
        silent: false
      }, { noRenew: true, timeoutMs: 25000 });

      if (res && res.success) {
        global.PMIS_API.setSession(res);
        showAuthenticatedWorkspace(res);
        return;
      }
      if (res && (res.code === 'REMEMBER_INVALID' || res.code === 'REMEMBER_EXPIRED' || res.code === 'ACCOUNT_INACTIVE')) {
        global.PMIS_API.setRememberToken('');
      }
      showLoginView();
    } catch (e) {
      // Network unreachable even though navigator.onLine is true -> still allow offline workspace if snapshot exists
      if (snap) {
        global.PMIS_API.setSession(snap);
        showAuthenticatedWorkspace(snap);
      } else {
        showLoginView();
      }
    } finally {
      if (statusEl) statusEl.classList.add('hidden');
    }
  }

  async function handleLoginSubmit(ev) {
    ev.preventDefault();
    const id = document.getElementById('loginId').value.trim();
    const pw = document.getElementById('loginPw').value;
    const rememberChecked = document.getElementById('loginRememberChk').checked;
    const rememberDays = rememberChecked ? Number(document.getElementById('loginRememberDays').value || 7) : 0;

    if (!id || !pw) {
      toast(PMIS_I18N.t('login_err_empty'), 'warning');
      return;
    }
    if (!navigator.onLine) {
      toast(PMIS_I18N.t('login_err_offline'), 'danger');
      return;
    }

    const btn = document.getElementById('loginSubmitBtn');
    btn.disabled = true;
    btn.textContent = PMIS_I18N.t('login_logging_in');

    try {
      const res = await global.PMIS_API.call('checkLogin', {
        id, pw,
        clientInfo: {
          deviceSummary: global.PMIS_API.getDeviceSummary(),
          screenInfo: window.innerWidth + 'x' + window.innerHeight,
          lang: PMIS_I18N.getLang(),
          rememberDays: rememberDays
        }
      }, { noRenew: true });

      if (res && res.success) {
        global.PMIS_API.setSession(res);
        if (res.rememberToken) global.PMIS_API.setRememberToken(res.rememberToken);
        else global.PMIS_API.setRememberToken('');
        document.getElementById('loginPw').value = '';
        showAuthenticatedWorkspace(res);
      } else {
        toast((res && (res.msg || res.error)) || 'Login failed', 'danger');
      }
    } catch (err) {
      toast(err.message || 'Network error', 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = PMIS_I18N.t('login_btn');
    }
  }

  async function handleLogout() {
    if (!confirm(PMIS_I18N.t('logout_confirm'))) return;
    if (global.PMIS_FIELDMAP) await global.PMIS_FIELDMAP.onLogout().catch(() => {});   // 위치 공유 종료 기록 (세션이 살아 있을 때)
    if (global.PMIS_NOTIFY) global.PMIS_NOTIFY.stop();
    const rmb = global.PMIS_API.getRememberToken();
    if (rmb && navigator.onLine) {
      global.PMIS_API.call('forgetRememberedLogin', { rememberToken: rmb }, { noRenew: true }).catch(() => {});
    }
    global.PMIS_API.setRememberToken('');
    global.PMIS_API.setSession(null);
    showLoginView();
  }

  function switchTab(tab) {
    activeTab = tab;
    ['rit', 'att', 'tasks', 'daily', 'map'].forEach((tName) => {
      document.getElementById('tab-' + tName).classList.toggle('hidden', tName !== tab);
      document.querySelector(`[data-nav-tab="${tName}"]`).classList.toggle('active', tName === tab);
    });
    if (tab === 'rit') global.PMIS_RIT.loadTasks(false);
    else if (tab === 'att') loadAttendance(false);
    else if (tab === 'tasks') loadMyTasks(false);
    else if (tab === 'daily') loadDailyBriefing('');
    else if (tab === 'map' && global.PMIS_FIELDMAP) global.PMIS_FIELDMAP.load(false);
  }

  // ───────── Attendance Tab ─────────
  async function loadAttendance(forceOnline) {
    clearInterval(clockTimer);
    const updateClock = () => {
      const el = document.getElementById('attLiveClock');
      if (el) el.textContent = formatBangkokNow() + ' (GMT+7)';
    };
    updateClock();
    clockTimer = setInterval(updateClock, 1000);

    const user = global.PMIS_API.getUser();
    if (!user) return;
    const cacheKey = 'att_' + user.id;

    if (!navigator.onLine && !forceOnline) {
      const cached = await global.PMIS_DB.loadState(cacheKey).catch(() => null);
      if (cached && cached.data) renderAttendanceCard(cached.data.attendance, cached.data.monthly);
      return;
    }

    try {
      const res = await global.PMIS_API.call('getAttendance', { includeMonthly: true });
      if (res && res.success) {
        renderAttendanceCard(res.attendance, res.monthly);
        global.PMIS_DB.saveState(cacheKey, { attendance: res.attendance, monthly: res.monthly }).catch(() => {});
      }
    } catch (err) {
      const cached = await global.PMIS_DB.loadState(cacheKey).catch(() => null);
      if (cached && cached.data) renderAttendanceCard(cached.data.attendance, cached.data.monthly);
    }
  }

  function renderAttendanceCard(att, monthly) {
    att = att || {};
    const statusBadge = document.getElementById('attStatusBadge');
    const inTime = document.getElementById('attClockInTime');
    const outTime = document.getElementById('attClockOutTime');
    const hrs = document.getElementById('attWorkHours');
    const btnIn = document.getElementById('attClockInBtn');
    const btnOut = document.getElementById('attClockOutBtn');
    const summaryWrap = document.getElementById('attSummaryWrap');

    let stText = PMIS_I18N.t('att_status_none');
    let stCls = 'badge-slate';
    if (att.clockedOut) { stText = PMIS_I18N.t('att_status_out'); stCls = 'badge-green'; }
    else if (att.clockedIn) { stText = PMIS_I18N.t('att_status_in'); stCls = 'badge-blue'; }
    else if (att.openShift) { stText = PMIS_I18N.t('att_status_open'); stCls = 'badge-amber'; }

    if (statusBadge) { statusBadge.textContent = stText; statusBadge.className = 'badge ' + stCls; }
    const rec = att.record || att.openShift || {};
    if (inTime) inTime.textContent = rec.clockIn ? String(rec.clockIn).slice(11, 16) : '-';
    if (outTime) outTime.textContent = rec.clockOut ? String(rec.clockOut).slice(11, 16) : '-';
    if (hrs) hrs.textContent = (rec.workHours !== null && rec.workHours !== undefined && rec.workHours !== '') ? (rec.workHours + ' h') : '-';

    if (btnIn) btnIn.classList.toggle('hidden', !att.canClockIn);
    if (btnOut) btnOut.classList.toggle('hidden', !att.canClockOut);
    if (summaryWrap) summaryWrap.classList.toggle('hidden', !att.canClockOut);

    if (monthly && monthly.success && monthly.summary) {
      const s = monthly.summary;
      document.getElementById('attMonDays').textContent = s.workDays || 0;
      document.getElementById('attMonHours').textContent = s.totalHours || 0;
      document.getElementById('attMonOt').textContent = s.otHours || 0;
      document.getElementById('attMonMissing').textContent = s.missingClockOut || 0;
    }
  }

  async function doClock(type) {
    if (!navigator.onLine) {
      toast(PMIS_I18N.t('att_offline_err'), 'danger');
      return;
    }
    const payload = { type };
    if (type === 'OUT') {
      const sum = document.getElementById('attWorkSummaryInput').value.trim();
      if (!sum) {
        toast(PMIS_I18N.t('att_summary_req'), 'warning');
        document.getElementById('attWorkSummaryInput').focus();
        return;
      }
      payload.workSummary = sum;
    }
    try {
      const res = await global.PMIS_API.call('recordAttendance', payload);
      if (res && res.success) {
        toast(type === 'IN' ? PMIS_I18N.t('att_in_ok') : PMIS_I18N.tf('att_out_ok', { h: res.workHours || 0 }), 'success');
        if (type === 'OUT') document.getElementById('attWorkSummaryInput').value = '';
        await loadAttendance(true);
      } else {
        toast((res && (res.msg || res.error)) || 'Attendance failed', 'danger');
      }
    } catch (err) {
      toast(err.message || 'Network error', 'danger');
    }
  }

  // ───────── My Tasks Tab ─────────
  async function loadMyTasks(forceOnline) {
    const user = global.PMIS_API.getUser();
    if (!user) return;
    const listEl = document.getElementById('myTasksList');
    const banner = document.getElementById('myTasksCacheBanner');
    if (banner) banner.classList.add('hidden');
    const cacheKey = 'mytasks_' + user.id;

    if (!navigator.onLine && !forceOnline) {
      const cached = await global.PMIS_DB.loadState(cacheKey).catch(() => null);
      if (cached && cached.data) {
        tasksData = cached.data;
        if (banner) {
          banner.textContent = PMIS_I18N.tf('tasks_offline_cache', { time: formatBangkokNow().slice(5, 16) });
          banner.classList.remove('hidden');
        }
        renderMyTasks();
      } else if (listEl) {
        listEl.innerHTML = '<div class="empty-box">' + escHtml(PMIS_I18N.t('tasks_empty')) + '</div>';
      }
      return;
    }

    if (listEl && !tasksData) {
      listEl.innerHTML = '<div class="empty-box">' + escHtml(PMIS_I18N.t('rit_loading')) + '</div>';
    }

    try {
      const res = await global.PMIS_API.call('getAllMyTasks', {});
      if (res && res.success) {
        tasksData = res;
        global.PMIS_DB.saveState(cacheKey, res).catch(() => {});
        renderMyTasks();
      } else {
        throw new Error((res && (res.msg || res.error)) || 'Failed');
      }
    } catch (err) {
      const cached = await global.PMIS_DB.loadState(cacheKey).catch(() => null);
      if (cached && cached.data) {
        tasksData = cached.data;
        renderMyTasks();
      }
    }
  }

  function renderMyTasks() {
    if (!tasksData) return;
    const c = tasksData.counts || {};
    const topBadge = document.getElementById('navTasksBadge');
    if (topBadge) {
      topBadge.textContent = c.total ? String(c.total) : '';
      topBadge.classList.toggle('hidden', !c.total);
    }

    const pills = [
      { key: 'ALL', label: PMIS_I18N.t('tasks_all'), count: c.total || 0 },
      { key: 'rit', label: 'RIT', count: c.rit || 0 },
      { key: 'mar', label: 'MAR', count: c.mar || 0 },
      { key: 'rfa', label: 'RFA', count: c.rfa || 0 },
      { key: 'rfi', label: 'RFI', count: c.rfi || 0 },
      { key: 'letter', label: 'Letter', count: c.letter || 0 }
    ];
    document.getElementById('myTasksFilterBar').innerHTML = pills.map((p) => `
      <button type="button" class="filter-pill ${tasksFilter === p.key ? 'active' : ''}" data-task-mod="${p.key}">
        ${escHtml(p.label)} <span class="pill-cnt">${p.count}</span>
      </button>
    `).join('');

    const mods = tasksFilter === 'ALL' ? ['mar', 'rfa', 'rfi', 'letter', 'rit'] : [tasksFilter];
    const items = [];
    mods.forEach((m) => {
      ((tasksData.items && tasksData.items[m]) || []).forEach((it) => {
        items.push(Object.assign({ _mod: m.toUpperCase() }, it));
      });
    });

    const listEl = document.getElementById('myTasksList');
    if (!items.length) {
      listEl.innerHTML = '<div class="empty-box">' + escHtml(PMIS_I18N.t('tasks_empty')) + '</div>';
      return;
    }

    listEl.innerHTML = items.map((it) => {
      const fileUrl = it.incomingLink || it.reviewedLink || it.closedLink || '';
      const due = it.extDue || it.intDue || it.dueDate || it.reqDate || '';
      return `
        <article class="card task-card">
          <div class="card-top">
            <div>
              <span class="mod-tag mod-${escHtml(it._mod.toLowerCase())}">${escHtml(it._mod)}</span>
              <span class="doc-no">${escHtml(it.docNo || it.cscRefNo || '')}</span>
              ${it.rev ? `<span class="rev-tag">R${escHtml(it.rev)}</span>` : ''}
              ${it.otherDisc ? `<span class="badge-warn">${escHtml(PMIS_I18N.t('rit_other_disc'))}</span>` : ''}
            </div>
            <span class="badge badge-blue">${escHtml(PMIS_I18N.translateStatus(it.status))}</span>
          </div>
          <div class="card-subject">${escHtml(it.subject || '-')}</div>
          ${it.aiSummary ? `<div class="ai-snippet">🤖 ${escHtml(it.aiSummary)}</div>` : ''}
          <div class="card-meta">
            ${due ? `<span>⏳ ${escHtml(PMIS_I18N.t('tasks_due'))}: ${escHtml(due)}</span>` : ''}
            <span>👤 ${escHtml(PMIS_I18N.t('tasks_reviewer'))}: ${escHtml(it.reviewer || it.assignedInsp || '-')}</span>
          </div>
          ${fileUrl ? `<div class="chip-row"><a class="chip-link" href="${escHtml(fileUrl)}" target="_blank" rel="noopener">📄 ${escHtml(PMIS_I18N.t('tasks_open_pdf'))}</a></div>` : ''}
        </article>`;
    }).join('');
  }

  // ───────── Daily Briefing Tab ─────────
  async function loadDailyBriefing(dateStr) {
    const cacheKey = 'daily_' + (dateStr || 'latest');
    const banner = document.getElementById('dailyCacheBanner');
    if (banner) banner.classList.add('hidden');

    if (!navigator.onLine) {
      const cached = await global.PMIS_DB.loadState(cacheKey).catch(() => null);
      if (cached && cached.data) {
        dailyData = cached.data;
        if (banner) {
          banner.textContent = PMIS_I18N.tf('daily_offline_cache', { time: formatBangkokNow().slice(5, 16) });
          banner.classList.remove('hidden');
        }
        renderDailyBriefing();
      }
      return;
    }

    try {
      const res = await global.PMIS_API.call('getDailyBriefing', { date: dateStr || '' });
      if (res && res.success) {
        dailyData = res;
        global.PMIS_DB.saveState(cacheKey, res).catch(() => {});
        if (!dateStr) global.PMIS_DB.saveState('daily_latest', res).catch(() => {});
        renderDailyBriefing();
      }
    } catch (err) {
      const cached = await global.PMIS_DB.loadState(cacheKey).catch(() => null);
      if (cached && cached.data) {
        dailyData = cached.data;
        renderDailyBriefing();
      }
    }
  }

  function renderDailyBriefing() {
    if (!dailyData) return;
    const dateInput = document.getElementById('dailyDateInput');
    if (dateInput && dailyData.date) dateInput.value = dailyData.date;

    const chipsEl = document.getElementById('dailyDateChips');
    if (chipsEl && Array.isArray(dailyData.availableDates)) {
      chipsEl.innerHTML = dailyData.availableDates.slice(0, 10).map((d) => `
        <button type="button" class="date-chip ${d === dailyData.date ? 'active' : ''}" data-daily-date="${escHtml(d)}">${escHtml(d.slice(5))}</button>
      `).join('');
    }

    const fbEl = document.getElementById('dailyFallbackNote');
    if (fbEl) {
      fbEl.textContent = dailyData.fallbackUsed ? PMIS_I18N.tf('daily_fallback_note', { date: dailyData.date }) : '';
      fbEl.classList.toggle('hidden', !dailyData.fallbackUsed);
    }

    const contentEl = document.getElementById('dailyContentArea');
    if (!dailyData.exists) {
      contentEl.innerHTML = '<div class="empty-box">' + escHtml(PMIS_I18N.tf('daily_empty', { date: dailyData.date || '-' })) + '</div>';
      return;
    }

    const lang = PMIS_I18N.getLang();
    const execText = (lang === 'en' ? dailyData.briefingEn : (lang === 'th' ? dailyData.briefingTh : dailyData.briefingKo))
      || dailyData.briefingEn || dailyData.briefingKo || dailyData.briefingTh || '-';
    const patrolText = (lang === 'en' ? dailyData.patrolBriefingEn : (lang === 'th' ? dailyData.patrolBriefingTh : dailyData.patrolBriefingKo))
      || dailyData.patrolBriefingEn || dailyData.patrolBriefingKo || dailyData.patrolBriefingTh || '-';

    const formatBullets = (txt) => String(txt || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => `<li>${escHtml(l)}</li>`).join('');

    contentEl.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${dailyData.dwrCount || 0}</div><div class="stat-lbl">${escHtml(PMIS_I18N.t('daily_dwr_cnt'))}</div></div>
        <div class="stat-card"><div class="stat-val">${dailyData.drqCount || 0}</div><div class="stat-lbl">${escHtml(PMIS_I18N.t('daily_drq_cnt'))}</div></div>
        <div class="stat-card"><div class="stat-val">${dailyData.totalManpower || 0}</div><div class="stat-lbl">${escHtml(PMIS_I18N.t('daily_manpower'))}</div></div>
        <div class="stat-card"><div class="stat-val">${dailyData.totalEquipment || 0}</div><div class="stat-lbl">${escHtml(PMIS_I18N.t('daily_equipment'))}</div></div>
      </div>
      ${dailyData.disciplines ? `<div class="disc-bar">🏷 ${escHtml(dailyData.disciplines)}</div>` : ''}
      <div class="card briefing-card">
        <div class="briefing-title">📊 ${escHtml(PMIS_I18N.t('daily_exec_title'))}</div>
        <ul class="briefing-list">${formatBullets(execText)}</ul>
      </div>
      <div class="card briefing-card safety">
        <div class="briefing-title">🦺 ${escHtml(PMIS_I18N.t('daily_patrol_title'))}</div>
        <ul class="briefing-list">${formatBullets(patrolText)}</ul>
      </div>`;
  }

  // ───────── Settings Modal ─────────
  function openSettingsModal() {
    document.getElementById('settingsApiUrlInput').value = global.PMIS_CONFIG.getApiUrl();
    document.getElementById('settingsPingResult').textContent = '';
    if (global.PMIS_NOTIFY) global.PMIS_NOTIFY.renderSettings();
    if (global.PMIS_UPDATER) global.PMIS_UPDATER.rerender();
    document.getElementById('settingsModal').classList.remove('hidden');
  }

  function closeSettingsModal() {
    document.getElementById('settingsModal').classList.add('hidden');
  }

  async function testServerPing() {
    const out = document.getElementById('settingsPingResult');
    out.textContent = '...';
    try {
      global.PMIS_CONFIG.setApiUrl(document.getElementById('settingsApiUrlInput').value);
      const res = await global.PMIS_API.ping();
      if (res && res.success) {
        out.textContent = '✅ ' + PMIS_I18N.tf('settings_ping_ok', { ver: res.version, time: res.serverTime });
        out.className = 'ping-out ok';
      } else {
        throw new Error((res && res.msg) || 'Error');
      }
    } catch (err) {
      out.textContent = '❌ ' + PMIS_I18N.tf('settings_ping_fail', { msg: err.message });
      out.className = 'ping-out err';
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()) return;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  function init() {
    PMIS_I18N.applyI18nToDom();
    updateNetworkBadge();
    registerServiceWorker();
    global.PMIS_RIT.bindEvents();
    if (global.PMIS_FIELDMAP) global.PMIS_FIELDMAP.bindEvents();
    if (global.PMIS_OBS) global.PMIS_OBS.bindEvents();
    if (global.PMIS_NOTIFY) global.PMIS_NOTIFY.bindEvents();
    if (global.PMIS_UPDATER) global.PMIS_UPDATER.bindEvents();

    window.addEventListener('online', () => {
      updateNetworkBadge();
      global.PMIS_RIT.scheduleAutoFlush();
    });
    window.addEventListener('offline', updateNetworkBadge);

    document.querySelectorAll('.lang-pill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        PMIS_I18N.setLang(btn.getAttribute('data-lang'));
        updateNetworkBadge();
        global.PMIS_RIT.renderTaskList();
        if (tasksData) renderMyTasks();
        if (dailyData) renderDailyBriefing();
        if (global.PMIS_FIELDMAP) global.PMIS_FIELDMAP.rerender();
        if (global.PMIS_OBS) global.PMIS_OBS.rerender();
        if (global.PMIS_NOTIFY) global.PMIS_NOTIFY.rerender();
        if (global.PMIS_UPDATER) global.PMIS_UPDATER.rerender();
      });
    });

    document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);
    document.getElementById('loginRememberChk').addEventListener('change', (e) => {
      document.getElementById('loginRememberDays').disabled = !e.target.checked;
    });

    document.querySelectorAll('[data-nav-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-nav-tab')));
    });

    document.getElementById('headerRefreshBtn').addEventListener('click', () => switchTab(activeTab));
    document.getElementById('headerSettingsBtn').addEventListener('click', openSettingsModal);
    document.getElementById('loginSettingsBtn').addEventListener('click', openSettingsModal);
    document.getElementById('headerLogoutBtn').addEventListener('click', handleLogout);

    document.getElementById('attClockInBtn').addEventListener('click', () => doClock('IN'));
    document.getElementById('attClockOutBtn').addEventListener('click', () => doClock('OUT'));

    document.getElementById('myTasksFilterBar').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-task-mod]');
      if (!btn) return;
      tasksFilter = btn.getAttribute('data-task-mod');
      renderMyTasks();
    });

    document.getElementById('dailyDateInput').addEventListener('change', (e) => {
      if (e.target.value) loadDailyBriefing(e.target.value);
    });
    document.getElementById('dailyDateChips').addEventListener('click', (ev) => {
      const chip = ev.target.closest('[data-daily-date]');
      if (chip) loadDailyBriefing(chip.getAttribute('data-daily-date'));
    });

    document.getElementById('settingsCloseBtn').addEventListener('click', closeSettingsModal);
    document.getElementById('settingsPingBtn').addEventListener('click', testServerPing);
    document.getElementById('settingsSaveBtn').addEventListener('click', () => {
      global.PMIS_CONFIG.setApiUrl(document.getElementById('settingsApiUrlInput').value);
      toast(PMIS_I18N.t('settings_saved'), 'success');
      closeSettingsModal();
    });
    document.getElementById('settingsSwReloadBtn').addEventListener('click', async () => {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      window.location.reload();
    });

    // [0.9.3] 설치형 앱: 화면 정상 동작 알림 + 받아 둔 새 화면은 앱을 켤 때만 적용(적용 중이면 로그인 진행 안 함)
    if (global.PMIS_UPDATER) {
      global.PMIS_UPDATER.boot()
        .then((reloading) => { if (!reloading) tryAutoLogin(); })
        .catch(() => tryAutoLogin());
    } else {
      tryAutoLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  global.PMIS_APP = {
    toast,
    refreshBadgeCounts: () => loadMyTasks(false),
    switchTab: (tab) => { if (!document.getElementById('mainView').classList.contains('hidden')) switchTab(tab); }
  };
})(window);
