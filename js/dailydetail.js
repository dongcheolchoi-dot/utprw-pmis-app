/* U-Tapao PMIS Mobile — 일일보고 상세 (DWR 작업보고 / DRQ 작업계획, 2026-11-21)
 * - 웹 통합 보고서(JS_Daily.html)의 휴대폰 카드 보기와 같은 내용: 문서별 공종·C/P·위치·작업 내용·인력/장비·PDF
 * - 번역: 선택 언어의 AI 번역(DB_Daily_Summary)이 있으면 그것을, 없으면 원문
 * - 서버: getDailyReportDetail (Code_Daily.js mobileGetDailyReportDetail_), 날짜·언어별로 기기에 저장 → 오프라인 열람
 * - 일일보고 탭(app.js renderDailyBriefing)이 #dailyDetailArea 를 만들고 load(date) 호출
 */
(function (global) {
  const st = { date: '', lang: '', data: null, offline: false, error: '', tab: 'DWR', disc: 'ALL', seq: 0, loading: false };

  function T(k) { return global.PMIS_I18N.t(k); }
  function TF(k, p) { return global.PMIS_I18N.tf(k, p); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const $ = (id) => document.getElementById(id);
  const tr = (it, k) => (it.tr && it.tr[k]) || it[k] || '';

  async function load(date) {
    if (!date) return;
    const lang = global.PMIS_I18N.getLang();
    if (st.data && st.date === date && st.lang === lang && !st.loading) { render(); return; }
    if (st.date !== date) { st.disc = 'ALL'; st.data = null; }
    st.date = date; st.lang = lang; st.error = ''; st.loading = true;
    const seq = ++st.seq;
    render();
    const key = 'daily_detail_' + date + '_' + lang;
    let res = null;
    if (navigator.onLine !== false) {
      try { res = await global.PMIS_API.call('getDailyReportDetail', { date, lang }, { timeoutMs: 60000 }); } catch (e) { res = null; }
    }
    if (seq !== st.seq) return;   // 그 사이 다른 날짜·언어를 고름
    if (res && res.success) {
      st.data = res; st.offline = false;
      global.PMIS_DB.saveState(key, res).catch(() => {});
    } else {
      const cached = await global.PMIS_DB.loadState(key).catch(() => null);
      if (seq !== st.seq) return;
      if (cached && cached.data) { st.data = cached.data; st.offline = true; }
      else { st.data = null; st.error = (res && (res.msg || res.error)) || T('dd_load_fail'); }
    }
    st.loading = false;
    render();
  }

  function countBy(list) {
    const m = {};
    list.forEach((it) => { const d = it.discipline || 'GEN'; m[d] = (m[d] || 0) + 1; });
    return m;
  }

  function resourceTotals(list, key) {
    const m = {};
    list.forEach((it) => (it[key] || []).forEach((r) => { m[r.name] = (m[r.name] || 0) + Number(r.count || 0); }));
    return Object.keys(m).map((k) => ({ name: k, count: m[k] })).sort((a, b) => b.count - a.count);
  }

  function pdfChip(it) {
    return it.pdf ? '<a class="chip-link" href="' + esc(it.pdf) + '" target="_blank" rel="noopener">📄 PDF</a>' : '';
  }

  function cardHead(it) {
    return '<div class="card-top"><div><span class="badge badge-blue">' + esc(it.discipline || 'GEN') + '</span> ' +
      '<span class="badge ' + (it.cp === 'C' ? 'badge-green' : 'badge-amber') + '">' + esc(it.cp) + '</span>' +
      (it.disciplineRaw && it.disciplineRaw !== it.discipline ? ' <span class="small-muted">' + esc(it.disciplineRaw) + '</span>' : '') +
      '</div><span class="small-muted dd-docno">' + esc(it.docNo) + '</span></div>';
  }

  function dwrCard(it) {
    const roles = (it.manpowerDetails || []).map((r) => esc(r.name) + ' ' + r.count).join(', ');
    const eqs = (it.equipmentDetails || []).map((r) => esc(r.name) + ' ' + r.count).join(', ');
    return '<article class="card dd-card">' + cardHead(it) +
      '<div class="dd-loc">📍 ' + esc(tr(it, 'loc') || '-') + '</div>' +
      '<div class="dd-act">' + esc(tr(it, 'activities') || '-') + '</div>' +
      (it.issues ? '<div class="dd-issue">⚠️ ' + esc(it.issues) + '</div>' : '') +
      '<div class="dd-foot"><span class="badge badge-slate">👷 ' + (it.manpower || 0) + '</span> <span class="badge badge-slate">🚜 ' + (it.equipment || 0) + '</span>' + pdfChip(it) + '</div>' +
      (roles || eqs ? '<div class="dd-res small-muted">' + (roles ? '👷 ' + roles : '') + (roles && eqs ? '<br>' : '') + (eqs ? '🚜 ' + eqs : '') + '</div>' : '') +
      '</article>';
  }

  function drqCard(it) {
    const night = /night|ค่ำ|กลางคืน|야간/i.test(it.shift || '');
    const safety = it.tr && it.tr.safetyPoint;
    return '<article class="card dd-card">' + cardHead(it) +
      '<div class="dd-time">' + (night ? '🌙 ' : '☀️ ') + esc(it.time || '-') + (it.shift ? ' · ' + esc(it.shift) : '') + '</div>' +
      '<div class="dd-loc">📍 ' + esc(tr(it, 'loc') || '-') + '</div>' +
      '<div class="dd-act">' + esc(tr(it, 'activities') || '-') + '</div>' +
      (tr(it, 'qty') ? '<div class="small-muted">📏 ' + esc(tr(it, 'qty')) + '</div>' : '') +
      (safety ? '<div class="dd-safety">🦺 ' + esc(safety) + '</div>' : '') +
      '<div class="dd-foot">' + (it.manpower ? '<span class="badge badge-slate">👷 ' + esc(it.manpower) + '</span> ' : '') +
      (it.equipment ? '<span class="badge badge-slate">🚜 ' + esc(it.equipment) + '</span>' : '') + pdfChip(it) + '</div>' +
      '</article>';
  }

  function dwrSummary(list) {
    const first = (k) => { for (const it of list) { const v = tr(it, k); if (v) return v; } return ''; };
    const mp = list.reduce((a, it) => a + (Number(it.manpower) || 0), 0);
    const eq = list.reduce((a, it) => a + (Number(it.equipment) || 0), 0);
    const roles = resourceTotals(list, 'manpowerDetails').slice(0, 12);
    const eqs = resourceTotals(list, 'equipmentDetails').slice(0, 12);
    const wd = first('weatherDay'), wn = first('weatherNight');
    return '<div class="card dd-summary">' +
      ((wd || wn) ? '<div class="dd-weather">' + (wd ? '☀️ ' + esc(wd) : '') + (wd && wn ? '<br>' : '') + (wn ? '🌙 ' + esc(wn) : '') + '</div>' : '') +
      '<div class="dd-totals"><span>👷 ' + esc(T('daily_manpower')) + ' <strong>' + mp + '</strong></span><span>🚜 ' + esc(T('daily_equipment')) + ' <strong>' + eq + '</strong></span></div>' +
      (roles.length ? '<div class="dd-chips">' + roles.map((r) => '<span class="dd-chip">' + esc(r.name) + ' <b>' + r.count + '</b></span>').join('') + '</div>' : '') +
      (eqs.length ? '<div class="dd-chips">' + eqs.map((r) => '<span class="dd-chip eq">' + esc(r.name) + ' <b>' + r.count + '</b></span>').join('') + '</div>' : '') +
      '</div>';
  }

  function render() {
    const area = $('dailyDetailArea');
    if (!area) return;
    if (!st.data) {
      area.innerHTML = st.loading
        ? '<div class="empty-box">' + esc(T('rit_loading')) + '</div>'
        : (st.error ? '<div class="empty-box">' + esc(st.error) + '</div>' : '');
      return;
    }
    const d = st.data;
    const all = st.tab === 'DWR' ? (d.dwr || []) : (d.drq || []);
    const counts = countBy(all);
    if (st.disc !== 'ALL' && !counts[st.disc]) st.disc = 'ALL';
    const list = all.filter((it) => st.disc === 'ALL' || (it.discipline || 'GEN') === st.disc);

    let html = '<div class="dd-head">📑 ' + esc(T('dd_title')) + '</div>';
    if (st.offline) html += '<div class="info-banner">' + esc(T('dd_offline')) + '</div>';
    html += '<div class="obs-seg dd-tabs">' +
      '<button type="button" class="filter-pill' + (st.tab === 'DWR' ? ' active' : '') + '" data-dd-tab="DWR">' + esc(T('dd_tab_dwr')) + ' ' + (d.dwr || []).length + '</button>' +
      '<button type="button" class="filter-pill' + (st.tab === 'DRQ' ? ' active' : '') + '" data-dd-tab="DRQ">' + esc(T('dd_tab_drq')) + ' ' + (d.drq || []).length + '</button>' +
      '</div>';
    if (!all.length) {
      area.innerHTML = html + '<div class="empty-box">' + esc(TF('dd_empty', { date: d.date })) + '</div>';
      return;
    }
    html += '<div class="filter-scroll">' +
      '<button type="button" class="filter-pill' + (st.disc === 'ALL' ? ' active' : '') + '" data-dd-disc="ALL">' + esc(T('tasks_all')) + ' <span class="pill-cnt">' + all.length + '</span></button>' +
      Object.keys(counts).sort().map((k) => '<button type="button" class="filter-pill' + (st.disc === k ? ' active' : '') + '" data-dd-disc="' + esc(k) + '">' + esc(k) + ' <span class="pill-cnt">' + counts[k] + '</span></button>').join('') +
      '</div>';
    if (st.tab === 'DWR') html += dwrSummary(list);
    html += list.map(st.tab === 'DWR' ? dwrCard : drqCard).join('');
    area.innerHTML = html;
  }

  // 탭·공종 필터 (영역이 다시 그려져도 동작하도록 문서 단위 위임)
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-dd-tab]');
    if (t) { st.tab = t.getAttribute('data-dd-tab'); st.disc = 'ALL'; render(); return; }
    const f = ev.target.closest && ev.target.closest('[data-dd-disc]');
    if (f) { st.disc = f.getAttribute('data-dd-disc'); render(); }
  });

  global.PMIS_DAILYDETAIL = { load, render };
})(window);
