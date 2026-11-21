/* U-Tapao PMIS Mobile Configuration */
(function (global) {
  const DEFAULT_API_URL =
    'https://script.google.com/macros/s/AKfycbxGK9FsMM-Lq3-pBFQAmjmYzoQURa9MR9hfklozXayVDDsvkzh0oXe35wPzkzR5tfQS/exec';

  const STORAGE_KEYS = {
    API_URL: 'pmis_mobile_api_url_v1',
    LANG: 'pmis_mobile_lang_v1',
    REMEMBER_TOKEN: 'pmis_mobile_remember_v1',
    USER_SNAPSHOT: 'pmis_mobile_user_v1'
  };

  function getApiUrl() {
    try {
      const custom = localStorage.getItem(STORAGE_KEYS.API_URL);
      return (custom && /^https:\/\//i.test(custom.trim())) ? custom.trim() : DEFAULT_API_URL;
    } catch (e) {
      return DEFAULT_API_URL;
    }
  }

  function setApiUrl(url) {
    const val = String(url || '').trim();
    if (!val) {
      localStorage.removeItem(STORAGE_KEYS.API_URL);
      return DEFAULT_API_URL;
    }
    localStorage.setItem(STORAGE_KEYS.API_URL, val);
    return val;
  }

  global.PMIS_CONFIG = {
    APP_NAME: 'U-Tapao PMIS',
    APP_VERSION: '0.9.3',
    TIMEZONE: 'Asia/Bangkok',
    DEFAULT_API_URL: DEFAULT_API_URL,
    STORAGE_KEYS: STORAGE_KEYS,
    RPC_TIMEOUT_MS: 120000,
    TASK_CACHE_MAX_AGE_MS: 7 * 24 * 3600 * 1000,
    getApiUrl: getApiUrl,
    setApiUrl: setApiUrl
  };
})(window);
