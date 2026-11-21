/* U-Tapao PMIS Mobile IndexedDB Store (Offline-First Queue & Caches) */
(function (global) {
  const DB_NAME = 'PMIS_Mobile_Offline_DB';
  const DB_VER = 1;
  const STORES = {
    QUEUE: 'rit_inspection_queue',
    TASKS: 'rit_tasks_cache',
    STATE: 'app_state_cache'
  };

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      let req;
      try {
        req = global.indexedDB.open(DB_NAME, DB_VER);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.QUEUE)) {
          const qs = db.createObjectStore(STORES.QUEUE, { keyPath: 'queueId' });
          qs.createIndex('status', 'status');
          qs.createIndex('ritNo', 'ritNo');
        }
        if (!db.objectStoreNames.contains(STORES.TASKS)) {
          db.createObjectStore(STORES.TASKS, { keyPath: 'userId' });
        }
        if (!db.objectStoreNames.contains(STORES.STATE)) {
          db.createObjectStore(STORES.STATE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  function run(storeName, mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let out;
      work(tx.objectStore(storeName), (val) => { out = val; });
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB tx error'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB tx aborted'));
    }));
  }

  global.PMIS_DB = {
    enqueueInspection: (item) => run(STORES.QUEUE, 'readwrite', (st) => { st.put(item); }),
    listQueue: () =>
      run(STORES.QUEUE, 'readonly', (st, set) => {
        const r = st.getAll();
        r.onsuccess = () => set(r.result || []);
      }).then((list) => (list || []).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))),
    updateQueueItem: (queueId, patch) =>
      run(STORES.QUEUE, 'readwrite', (st) => {
        const g = st.get(queueId);
        g.onsuccess = () => {
          if (g.result) st.put(Object.assign({}, g.result, patch));
        };
      }),
    removeQueueItem: (queueId) => run(STORES.QUEUE, 'readwrite', (st) => { st.delete(queueId); }),
    saveTasksCache: (userId, tasks, userOptions) => {
      if (!userId) return Promise.resolve();
      return run(STORES.TASKS, 'readwrite', (st) => {
        st.put({
          userId: String(userId),
          cachedAt: Date.now(),
          tasks: tasks || [],
          userOptions: userOptions || null
        });
      });
    },
    loadTasksCache: (userId) => {
      if (!userId) return Promise.resolve(null);
      return run(STORES.TASKS, 'readonly', (st, set) => {
        const r = st.get(String(userId));
        r.onsuccess = () => set(r.result || null);
      });
    },
    saveState: (key, data) =>
      run(STORES.STATE, 'readwrite', (st) => {
        st.put({ key: String(key), cachedAt: Date.now(), data: data });
      }),
    loadState: (key) =>
      run(STORES.STATE, 'readonly', (st, set) => {
        const r = st.get(String(key));
        r.onsuccess = () => set(r.result || null);
      })
  };
})(window);
