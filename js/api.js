/* U-Tapao PMIS Mobile API Client (CORS-safe Simple POST + Auto Session Renewal) */
(function (global) {
  let sessionToken = '';
  let currentUser = null;
  let renewPromise = null;

  function setSession(userObj) {
    currentUser = userObj || null;
    sessionToken = (userObj && userObj.sessionToken) ? String(userObj.sessionToken) : '';
    try {
      if (userObj) {
        const snap = Object.assign({}, userObj);
        delete snap.sessionToken; // Keep short-lived token in memory; rmb_ handles persistence
        localStorage.setItem(global.PMIS_CONFIG.STORAGE_KEYS.USER_SNAPSHOT, JSON.stringify(snap));
      } else {
        localStorage.removeItem(global.PMIS_CONFIG.STORAGE_KEYS.USER_SNAPSHOT);
      }
    } catch (e) {}
  }

  function getStoredUserSnapshot() {
    try {
      const raw = localStorage.getItem(global.PMIS_CONFIG.STORAGE_KEYS.USER_SNAPSHOT);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function getRememberToken() {
    try {
      return localStorage.getItem(global.PMIS_CONFIG.STORAGE_KEYS.REMEMBER_TOKEN) || '';
    } catch (e) {
      return '';
    }
  }

  function setRememberToken(token) {
    try {
      if (token) localStorage.setItem(global.PMIS_CONFIG.STORAGE_KEYS.REMEMBER_TOKEN, String(token));
      else localStorage.removeItem(global.PMIS_CONFIG.STORAGE_KEYS.REMEMBER_TOKEN);
    } catch (e) {}
  }

  function getAuthToken() {
    return sessionToken;
  }

  function getUser() {
    return currentUser;
  }

  function getDeviceSummary() {
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isCap = !!(global.Capacitor && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform());
    return (isCap ? 'Capacitor-' : 'PWA-') + (isAndroid ? 'Android' : (isIOS ? 'iOS' : 'Web'));
  }

  function postRaw(action, payload, timeoutMs) {
    const controller = new AbortController();
    const ms = timeoutMs || global.PMIS_CONFIG.RPC_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), ms);

    return fetch(global.PMIS_CONFIG.getApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        source: 'PMIS_MOBILE_APP',
        action: action,
        authToken: sessionToken,
        payload: payload || {}
      }),
      redirect: 'follow',
      signal: controller.signal
    })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then((txt) => {
        try {
          return JSON.parse(txt);
        } catch (e) {
          throw new Error('Invalid JSON response from server');
        }
      })
      .finally(() => clearTimeout(timer));
  }

  function isAuthExpiredResult(res) {
    if (!res || res.success !== false) return false;
    const code = String(res.code || '');
    const msg = String(res.msg || res.error || '');
    return code === 'srv_auth_required' || code === 'AUTH_REQUIRED' || /세션이 만료|인증 정보가 없/.test(msg);
  }

  async function trySilentRenew() {
    const rmb = getRememberToken();
    if (!rmb || rmb.indexOf('rmb_') !== 0) return false;
    if (renewPromise) return renewPromise;
    renewPromise = postRaw('resumeRememberedLogin', {
      rememberToken: rmb,
      clientInfo: { deviceSummary: getDeviceSummary() },
      silent: true
    }, 20000)
      .then((res) => {
        if (res && res.success && res.sessionToken) {
          setSession(res);
          return true;
        }
        if (res && (res.code === 'REMEMBER_INVALID' || res.code === 'REMEMBER_EXPIRED' || res.code === 'ACCOUNT_INACTIVE')) {
          setRememberToken('');
        }
        return false;
      })
      .catch(() => false)
      .finally(() => { renewPromise = null; });
    return renewPromise;
  }

  async function call(action, payload, opts) {
    opts = opts || {};
    const res = await postRaw(action, payload, opts.timeoutMs);
    if (!opts.noRenew && isAuthExpiredResult(res)) {
      const renewed = await trySilentRenew();
      if (renewed) {
        return postRaw(action, payload, opts.timeoutMs);
      }
    }
    return res;
  }

  global.PMIS_API = {
    call,
    ping: () => postRaw('ping', {}, 15000),
    setSession,
    getUser,
    getAuthToken,
    getRememberToken,
    setRememberToken,
    getStoredUserSnapshot,
    getDeviceSummary,
    trySilentRenew
  };
})(window);
