// IndexedDB persistence via raw IDB (no external deps). Stores world metadata,
// player state, and sparse block edits. Chunk terrain is deterministic from seed.
const DB_NAME = 'voxelcraft';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: ['worldId', 'chunkKey'] });
      if (!db.objectStoreNames.contains('player')) db.createObjectStore('player', { keyPath: 'worldId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _dbP = null;
function db() { if (!_dbP) _dbP = openDB(); return _dbP; }

export async function listWorlds() {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('worlds', 'readonly');
    const r = tx.objectStore('worlds').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

export async function saveWorldMeta(meta) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('worlds', 'readwrite');
    tx.objectStore('worlds').put(meta);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

export async function deleteWorld(id) {
  const d = await db();
  await new Promise((res, rej) => {
    const tx = d.transaction(['worlds', 'edits', 'player'], 'readwrite');
    tx.objectStore('worlds').delete(id);
    const idx = tx.objectStore('edits').index ? null : null;
    // delete all edits with matching worldId via cursor
    const store = tx.objectStore('edits');
    const req = store.openCursor(IDBKeyRange.bound([id, ''], [id, '\uffff']));
    req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
    tx.objectStore('player').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

export async function saveEdits(worldId, editsObj) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('edits', 'readwrite');
    const store = tx.objectStore('edits');
    for (const chunkKey of Object.keys(editsObj)) {
      store.put({ worldId, chunkKey, data: editsObj[chunkKey] });
    }
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

export async function loadAllEdits(worldId) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('edits', 'readonly');
    const out = {};
    const req = tx.objectStore('edits').openCursor(IDBKeyRange.bound([worldId, ''], [worldId, '\uffff']));
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out[c.value.chunkKey] = c.value.data; c.continue(); }
      else res(out);
    };
    req.onerror = () => rej(req.error);
  });
}

export async function savePlayer(worldId, state) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('player', 'readwrite');
    tx.objectStore('player').put({ worldId, ...state });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

export async function loadPlayer(worldId) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('player', 'readonly');
    const r = tx.objectStore('player').get(worldId);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}
