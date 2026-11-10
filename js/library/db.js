// db.js — the track library, stored in the tablet's IndexedDB.
//
// Three object stores:
//   tracks  — metadata only (fast to list): title, format, bpm, duration, crates…
//   blobs   — the actual file bytes, keyed by the same id (loaded only when played)
//   crates  — named lists for prepping sets

const DB_NAME = 'modpod';
const DB_VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export class LibraryDB {
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        const tracks = db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
        tracks.createIndex('key', 'key', { unique: false });
        db.createObjectStore('blobs', { keyPath: 'id' });
        db.createObjectStore('crates', { keyPath: 'id', autoIncrement: true });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }

  async tx(stores, mode, fn) {
    const db = await this.open();
    const t = db.transaction(stores, mode);
    const done = new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
    const result = await fn(t);
    await done;
    return result;
  }

  /** Add a track. Returns its id, or null if a file with the same name+size already exists. */
  async addTrack(meta, blob) {
    const db = await this.open();
    const existing = await req(db.transaction('tracks').objectStore('tracks').index('key').get(meta.key));
    if (existing) return null;
    return this.tx(['tracks', 'blobs'], 'readwrite', async (t) => {
      const id = await req(t.objectStore('tracks').add(meta));
      t.objectStore('blobs').put({ id, blob });
      return id;
    });
  }

  async allTracks() {
    const db = await this.open();
    return req(db.transaction('tracks').objectStore('tracks').getAll());
  }

  async getTrack(id) {
    const db = await this.open();
    return req(db.transaction('tracks').objectStore('tracks').get(id));
  }

  async findByKey(key) {
    const db = await this.open();
    return req(db.transaction('tracks').objectStore('tracks').index('key').get(key));
  }

  async getBlob(id) {
    const db = await this.open();
    const r = await req(db.transaction('blobs').objectStore('blobs').get(id));
    return r ? r.blob : null;
  }

  /** Merge fields into a track's metadata. */
  async updateTrack(id, fields) {
    return this.tx(['tracks'], 'readwrite', async (t) => {
      const s = t.objectStore('tracks');
      const cur = await req(s.get(id));
      if (cur) s.put({ ...cur, ...fields });
    });
  }

  async deleteTrack(id) {
    return this.tx(['tracks', 'blobs'], 'readwrite', async (t) => {
      t.objectStore('tracks').delete(id);
      t.objectStore('blobs').delete(id);
    });
  }

  async allCrates() {
    const db = await this.open();
    return req(db.transaction('crates').objectStore('crates').getAll());
  }

  async addCrate(name) {
    return this.tx(['crates'], 'readwrite', (t) => req(t.objectStore('crates').add({ name })));
  }

  async renameCrate(id, name) {
    return this.tx(['crates'], 'readwrite', async (t) => { t.objectStore('crates').put({ id, name }); });
  }

  async deleteCrate(id) {
    // Also remove the crate from every track that's in it.
    const tracks = await this.allTracks();
    return this.tx(['crates', 'tracks'], 'readwrite', async (t) => {
      t.objectStore('crates').delete(id);
      const s = t.objectStore('tracks');
      for (const tr of tracks) {
        if (tr.crates && tr.crates.includes(id)) s.put({ ...tr, crates: tr.crates.filter((c) => c !== id) });
      }
    });
  }

  /** Ask the browser not to evict the library when storage gets tight. */
  static async persist() {
    try {
      if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
        return await navigator.storage.persist();
      }
    } catch { /* ignore */ }
    return false;
  }

  static async usage() {
    try { return await navigator.storage.estimate(); } catch { return null; }
  }
}
