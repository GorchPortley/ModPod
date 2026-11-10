// library-ui.js — the track browser: search, filter, sort, crates, import.

import { LibraryDB } from './db.js';
import { probe, isZip } from './formats.js';
import { unzip } from './zip.js';

const ROW_H = 58;
const $ = (id) => document.getElementById(id);

const SORTS = {
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  bpm: (a, b) => (a.bpm || 999) - (b.bpm || 999) || SORTS.title(a, b),
  duration: (a, b) => (a.duration || 1e9) - (b.duration || 1e9),
  added: (a, b) => b.added - a.added,
  played: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0),
  format: (a, b) => a.format.localeCompare(b.format) || SORTS.title(a, b),
};

function fmtDur(s) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export class LibraryUI {
  constructor({ onLoad, toast }) {
    this.db = new LibraryDB();
    this.onLoad = onLoad;           // (blob, meta) => Promise
    this.toast = toast;
    this.tracks = [];
    this.crates = [];
    this.view = [];                 // filtered + sorted
    this.crate = 'all';             // 'all' | 'history' | 'recent' | crate id
    this.kind = 'all';
    this.sort = localStorage.getItem('modpod.lib.sort') || 'title';
    this.query = '';
    this.history = [];              // track ids played this session, in order
    this.bind();
  }

  // ------------------------------------------------------------ data

  async refresh() {
    [this.tracks, this.crates] = await Promise.all([this.db.allTracks(), this.db.allCrates()]);
    this.renderCrates();
    this.applyFilter();
    this.updateFooter();
  }

  applyFilter() {
    const q = this.query.trim().toLowerCase();
    let list = this.tracks;
    if (this.crate === 'history') {
      const byId = new Map(list.map((t) => [t.id, t]));
      list = this.history.map((id) => byId.get(id)).filter(Boolean).reverse();
    } else if (this.crate === 'recent') {
      const weekAgo = Date.now() - 7 * 86400e3;
      list = list.filter((t) => t.added > weekAgo);
    } else if (this.crate !== 'all') {
      list = list.filter((t) => t.crates && t.crates.includes(this.crate));
    }
    if (this.kind !== 'all') list = list.filter((t) => t.kind === this.kind);
    if (q) {
      const num = parseFloat(q);
      if (/^\d+(\.\d+)?$/.test(q) && num > 40 && num < 300) {
        // A number searches by BPM: everything reachable within ±8 % of the tempo fader.
        list = list.filter((t) => t.bpm && Math.abs(t.bpm / num - 1) <= 0.08);
      } else {
        const words = q.split(/\s+/);
        list = list.filter((t) => {
          const hay = `${t.title} ${t.artist} ${t.name} ${t.format}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
      }
    }
    if (this.crate !== 'history') list = [...list].sort(SORTS[this.sort] || SORTS.title);
    this.view = list;
    $('lib-spacer').style.height = `${list.length * ROW_H}px`;
    $('lib-empty').hidden = this.tracks.length > 0;
    this.renderRows(true);
  }

  // ------------------------------------------------------------ rendering

  renderCrates() {
    const nav = $('lib-crates');
    const item = (id, label, count) =>
      `<button class="crate${this.crate === id ? ' sel' : ''}" data-crate="${id}">${esc(label)}${count != null ? `<span>${count}</span>` : ''}</button>`;
    let html = item('all', 'All tracks', this.tracks.length)
      + item('recent', 'Added this week')
      + item('history', 'Played this session', this.history.length)
      + '<div class="crate-head">CRATES</div>';
    for (const c of this.crates) {
      const n = this.tracks.filter((t) => t.crates && t.crates.includes(c.id)).length;
      html += item(c.id, c.name, n);
    }
    html += '<button class="crate add" data-crate="new">+ New crate</button>';
    nav.innerHTML = html;
  }

  renderRows(force) {
    const list = $('lib-list');
    const first = Math.max(0, Math.floor(list.scrollTop / ROW_H) - 4);
    const last = Math.min(this.view.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW_H) + 4);
    if (!force && first === this.first && last === this.last) return;
    this.first = first; this.last = last;
    const played = new Set(this.history);
    let html = '';
    for (let i = first; i < last; i++) {
      const t = this.view[i];
      const sub = [t.artist, t.channels ? `${t.channels} ch` : '', t.name].filter(Boolean).join(' · ');
      html += `<div class="trk${played.has(t.id) ? ' played' : ''}${t.id === this.loadedId ? ' loaded' : ''}" style="top:${i * ROW_H}px" data-i="${i}">
        <span class="fmt fmt-${t.kind}">${esc(t.format)}</span>
        <span class="main"><b>${esc(t.title)}</b><small>${esc(sub)}</small></span>
        <span class="bpm">${t.bpm ? t.bpm.toFixed(1) : ''}</span>
        <span class="dur">${fmtDur(t.duration)}</span>
        <button class="more" data-more="${i}">⋯</button>
      </div>`;
    }
    $('lib-rows').innerHTML = html;
  }

  async updateFooter(msg) {
    if (msg) { $('lib-foot').textContent = msg; return; }
    const u = await LibraryDB.usage();
    const mb = (x) => (x / 1048576).toFixed(0);
    const shown = this.view.length === this.tracks.length ? `${this.tracks.length} tracks` : `${this.view.length} of ${this.tracks.length} tracks`;
    $('lib-foot').textContent = shown + (u ? ` · ${mb(u.usage)} MB used of ~${mb(u.quota)} MB available` : '');
  }

  // ------------------------------------------------------------ actions

  show() { $('library').hidden = false; this.refresh(); }
  hide() { $('library').hidden = true; $('lib-search').blur(); }
  get open() { return !$('library').hidden; }

  async load(t) {
    const blob = await this.db.getBlob(t.id);
    if (!blob) { this.toast('That file is missing from storage.'); return; }
    try { await this.onLoad(blob, t); } catch { return; } // cancelled or failed (app shows why)
    this.loadedId = t.id;
    this.history = this.history.filter((id) => id !== t.id).concat(t.id);
    await this.db.updateTrack(t.id, { plays: (t.plays || 0) + 1, lastPlayed: Date.now() });
    this.hide();
  }

  /** Called by the app once a track has been decoded, to fill in things only known after decoding. */
  async learn(id, fields) {
    if (!id) return;
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
    if (Object.keys(clean).length) await this.db.updateTrack(id, clean);
  }

  async importFiles(files) {
    await LibraryDB.persist();
    let added = 0, dupes = 0, skipped = 0, n = 0;
    const firstAdded = [];
    const add = async (name, data) => {
      const meta = probe(data, name);
      if (!meta) { skipped++; return; }
      const id = await this.db.addTrack(meta, new Blob([data]));
      if (id == null) dupes++; else { added++; if (firstAdded.length < 1) firstAdded.push(id); }
    };
    for (const f of files) {
      n++;
      this.updateFooter(`Importing ${n}/${files.length}: ${f.name}…`);
      try {
        const data = await f.arrayBuffer();
        if (isZip(data)) {
          for await (const entry of unzip(data)) await add(entry.name, entry.data);
        } else {
          await add(f.name, data);
        }
      } catch (err) {
        console.error(err);
        skipped++;
      }
    }
    const parts = [`Added ${added} track${added === 1 ? '' : 's'}`];
    if (dupes) parts.push(`${dupes} already in library`);
    if (skipped) parts.push(`${skipped} not recognised`);
    this.toast(parts.join(' · '));
    await this.refresh();
    return firstAdded;
  }

  openSheet(t) {
    const sheet = $('sheet');
    const crateRows = this.crates.map((c) =>
      `<label class="sheet-row"><input type="checkbox" data-crate="${c.id}" ${t.crates && t.crates.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('');
    sheet.innerHTML = `
      <div class="sheet-box">
        <h3>${esc(t.title)}</h3>
        <p class="hint">${esc(t.name)} · ${esc(t.format)} · ${(t.size / 1024).toFixed(0)} KB · played ${t.plays || 0}×</p>
        <button class="btn" data-act="load">Load to deck</button>
        <div class="sheet-crates"><div class="crate-head">CRATES</div>${crateRows || '<p class="hint">No crates yet.</p>'}
          <button class="btn small" data-act="newcrate">+ New crate with this track</button></div>
        <div class="sheet-buttons">
          <button class="btn danger" data-act="delete">Remove from library</button>
          <button class="btn" data-act="close">Close</button>
        </div>
      </div>`;
    sheet.hidden = false;
    sheet.onclick = async (e) => {
      const act = e.target.dataset.act;
      if (e.target === sheet || act === 'close') { sheet.hidden = true; return; }
      if (act === 'load') { sheet.hidden = true; this.load(t); }
      if (act === 'delete' && confirm(`Remove "${t.title}" from this tablet?`)) {
        await this.db.deleteTrack(t.id); sheet.hidden = true; this.refresh();
      }
      if (act === 'newcrate') {
        const name = prompt('Crate name');
        if (name) {
          const id = await this.db.addCrate(name.trim());
          await this.db.updateTrack(t.id, { crates: [...(t.crates || []), id] });
          sheet.hidden = true; this.refresh();
        }
      }
    };
    sheet.onchange = async (e) => {
      const id = +e.target.dataset.crate;
      if (!id) return;
      const cur = new Set(t.crates || []);
      if (e.target.checked) cur.add(id); else cur.delete(id);
      t.crates = [...cur];
      await this.db.updateTrack(t.id, { crates: t.crates });
      this.refresh();
    };
  }

  async crateAction(id) {
    if (id === 'new') {
      const name = prompt('New crate name (e.g. "Warm-up", "Amiga bangers")');
      if (name && name.trim()) { await this.db.addCrate(name.trim()); await this.refresh(); }
      return;
    }
    this.crate = /^\d+$/.test(id) ? +id : id;
    this.renderCrates();
    this.applyFilter();
    $('lib-list').scrollTop = 0;
  }

  async crateLongPress(id) {
    if (!/^\d+$/.test(id)) return;
    const c = this.crates.find((x) => x.id === +id);
    const name = prompt(`Rename crate "${c.name}" (leave empty to delete it)`, c.name);
    if (name === null) return;
    if (name.trim()) await this.db.renameCrate(c.id, name.trim());
    else if (confirm(`Delete crate "${c.name}"? The tracks stay in the library.`)) {
      await this.db.deleteCrate(c.id);
      if (this.crate === c.id) this.crate = 'all';
    }
    this.refresh();
  }

  // ------------------------------------------------------------ events

  bind() {
    $('lib-close').addEventListener('click', () => this.hide());
    $('lib-add').addEventListener('click', () => $('lib-input').click());
    $('lib-input').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) await this.importFiles(files);
    });
    $('lib-search').addEventListener('input', (e) => { this.query = e.target.value; this.applyFilter(); this.updateFooter(); });
    $('lib-sort').value = this.sort;
    $('lib-sort').addEventListener('change', (e) => {
      this.sort = e.target.value;
      localStorage.setItem('modpod.lib.sort', this.sort);
      this.applyFilter();
    });
    $('lib-kind').addEventListener('click', (e) => {
      const k = e.target.dataset.kind;
      if (!k) return;
      this.kind = k;
      for (const b of $('lib-kind').children) b.classList.toggle('on', b.dataset.kind === k);
      this.applyFilter();
      this.updateFooter();
    });
    $('lib-list').addEventListener('scroll', () => this.renderRows(false), { passive: true });
    window.addEventListener('resize', () => { if (this.open) this.renderRows(true); });

    // Tap a row to load; ⋯ for the menu. Use click (not pointerdown) so scrolling doesn't load tracks.
    $('lib-rows').addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) { this.openSheet(this.view[+more.dataset.more]); return; }
      const row = e.target.closest('.trk');
      if (row) this.load(this.view[+row.dataset.i]);
    });

    // Crates: tap to select, long-press to rename/delete.
    let timer = null, longFired = false;
    $('lib-crates').addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-crate]');
      if (!b) return;
      longFired = false;
      timer = setTimeout(() => { longFired = true; this.crateLongPress(b.dataset.crate); }, 700);
    });
    $('lib-crates').addEventListener('pointerup', () => clearTimeout(timer));
    $('lib-crates').addEventListener('pointercancel', () => clearTimeout(timer));
    $('lib-crates').addEventListener('click', (e) => {
      const b = e.target.closest('[data-crate]');
      if (b && !longFired) this.crateAction(b.dataset.crate);
    });
  }
}
