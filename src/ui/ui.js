// HTML/CSS UI layer: HUD, hotbar, inventory+crafting screen, pause menu, debug (F3),
// chat/commands, crosshair, break progress. All DOM; nothing per-frame except cheap updates.
import { registry } from '../world/blocks.js';
import { drawItemIcon } from '../core/atlas.js';
import { Inventory, matchRecipe } from './inventory.js';

export class UI extends EventTarget {
  /**
   * @param {Inventory} inv
   * @param {HTMLCanvasElement} atlasCanvas
   */
  constructor(inv, atlasCanvas) {
    super();
    this.inv = inv;
    this.atlas = atlasCanvas;
    this.visible = true;
    this.invOpen = false;
    this.craftGrid = new Array(9).fill(null); // up to 3x3
    this.craftN = 2;
    this._iconCache = new Map();
    this._lastDebugUpdate = 0;
    this._buildDOM();
    inv.addEventListener('inventoryUpdated', () => this.refreshInventoryDOM());
  }

  _icon(itemName) {
    if (this._iconCache.has(itemName)) return this._iconCache.get(itemName);
    const c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    c.className = 'item-icon';
    drawItemIcon(c, itemName, this.atlas);
    this._iconCache.set(itemName, c);
    return c;
  }

  _buildDOM() {
    const root = document.getElementById('ui-root');
    root.innerHTML = `
      <div id="hud">
        <div id="crosshair"><span></span><span></span></div>
        <div id="break-progress"><div id="break-fill"></div></div>
        <div id="health-bar"></div>
        <div id="hunger-bar"></div>
        <div id="hotbar"></div>
        <div id="debug" class="hidden"></div>
        <div id="chat-log"></div>
        <div id="toast"></div>
      </div>
      <div id="inventory-screen" class="hidden">
        <div id="inv-panel">
          <div class="inv-title">Inventory <span id="inv-mode-label"></span></div>
          <div id="craft-area">
            <div class="craft-label">Crafting (<span id="craft-size">2×2</span>)</div>
            <div id="craft-grid"></div>
            <div id="craft-arrow">➡</div>
            <div id="craft-out" class="slot big"></div>
            <button id="btn-craft-3" title="Use a crafting table for 3×3">3×3 mode only near crafting table</button>
          </div>
          <div id="inv-main"></div>
          <div id="inv-hotbar"></div>
          <div class="inv-hint">E / Esc close · Left-click pick/place · Right-click split/one · Q drop</div>
        </div>
        <div id="cursor-stack"></div>
      </div>
      <div id="pause-screen" class="hidden">
        <div id="pause-panel">
          <h1>VoxelCraft</h1>
          <button id="btn-resume">Resume Game</button>
          <button id="btn-save">Save World</button>
          <button id="btn-quit">Save & Quit to Menu</button>
          <div id="pause-help">
            <b>Controls</b><br/>
            WASD move · Mouse look · Space jump · Ctrl sneak · Shift sprint<br/>
            Left click break (hold) · Right click place · Wheel/1-9 hotbar<br/>
            E inventory · F fly toggle · F3 debug · T chat · Esc pause<br/>
            Commands: /gamemode creative|survival · /tp x y z · /time day|night · /give item count · /seed
          </div>
        </div>
      </div>
      <div id="chat-input-wrap" class="hidden"><input id="chat-input" type="text" maxlength="120" autocomplete="off" spellcheck="false"/></div>
      <div id="water-overlay" class="hidden"></div>
      <div id="damage-overlay" class="hidden"></div>
      <div id="flash-overlay" class="hidden"></div>
    `;

    // Hotbar
    const hb = this.$('#hotbar');
    for (let i = 0; i < 9; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.dataset.slot = i;
      hb.appendChild(s);
    }

    // Inventory main grid
    const im = this.$('#inv-main');
    for (let i = 0; i < 27; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.dataset.slot = i + 9;
      im.appendChild(s);
    }
    const ih = this.$('#inv-hotbar');
    for (let i = 0; i < 9; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.dataset.slot = i;
      ih.appendChild(s);
    }

    this._buildCraftGrid();

    // Slot click handling (event delegation)
    document.getElementById('inventory-screen').addEventListener('mousedown', (e) => {
      const slotEl = e.target.closest('.slot');
      if (!slotEl) return;
      e.preventDefault();
      const idx = parseInt(slotEl.dataset.slot, 10);
      if (slotEl.classList.contains('craft-slot')) {
        this._craftClick(parseInt(slotEl.dataset.ci, 10), e.button === 2);
        return;
      }
      if (slotEl.id === 'craft-out') { this.dispatchEvent(new CustomEvent('craftTake')); return; }
      this.inv.clickSlot(idx, e.button === 2);
    });
    document.getElementById('inventory-screen').addEventListener('contextmenu', e => e.preventDefault());

    this.$('#btn-resume').onclick = () => this.dispatchEvent(new Event('resume'));
    this.$('#btn-save').onclick = () => this.dispatchEvent(new Event('save'));
    this.$('#btn-quit').onclick = () => this.dispatchEvent(new Event('quit'));

    this.chatInput = this.$('#chat-input');
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = this.chatInput.value.trim();
        this.closeChat();
        if (v) this.dispatchEvent(new CustomEvent('chatCommand', { detail: v }));
      } else if (e.key === 'Escape') { this.closeChat(); }
    });

    this.refreshInventoryDOM();
  }

  _buildCraftGrid() {
    const cg = this.$('#craft-grid');
    cg.innerHTML = '';
    cg.style.gridTemplateColumns = `repeat(${this.craftN}, 48px)`;
    for (let y = 0; y < this.craftN; y++) for (let x = 0; x < this.craftN; x++) {
      const s = document.createElement('div');
      s.className = 'slot craft-slot';
      s.dataset.ci = y * this.craftN + x;
      cg.appendChild(s);
    }
    this.$('#craft-size').textContent = `${this.craftN}×${this.craftN}`;
    this.refreshCraftDOM();
  }

  setCraftSize(n) {
    if (n === this.craftN) return;
    this.craftN = n;
    const old = this.craftGrid.slice(0, 4);
    this.craftGrid = new Array(9).fill(null);
    if (n === 2) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) this.craftGrid[y*2+x] = old[y*2+x];
    else this.craftGrid = old.concat(this.craftGrid.slice(4, 9)).slice(0, 9);
    this._buildCraftGrid();
  }

  $sel(sel) { return [...document.querySelectorAll(sel)]; }
  $(sel) { return document.querySelector(sel); }

  // ---- Rendering slots ----
  _renderSlot(el, stack, selected) {
    el.innerHTML = '';
    el.classList.toggle('selected', !!selected);
    if (!stack) return;
    el.appendChild(this._icon(stack.item));
    const cnt = document.createElement('span');
    cnt.className = 'count';
    cnt.textContent = stack.count > 1 ? stack.count : '';
    el.appendChild(cnt);
    const b = registry.byNameGet(stack.item);
    el.title = b ? b.display : stack.item;
  }

  refreshInventoryDOM() {
    if (!this.invOpen) {
      // just hotbar
      this.$sel('#hotbar .slot').forEach((el, i) => this._renderSlot(el, this.inv.hotbar[i], i === this.inv.selected));
      return;
    }
    this.$sel('#inv-main .slot').forEach((el, i) => this._renderSlot(el, this.inv.main[i], false));
    this.$sel('#inv-hotbar .slot').forEach((el, i) => this._renderSlot(el, this.inv.hotbar[i], i === this.inv.selected));
    this._renderCursorStack();
    this.refreshCraftDOM();
  }

  refreshCraftDOM() {
    this.$sel('.craft-slot').forEach((el) => {
      const ci = parseInt(el.dataset.ci, 10);
      this._renderSlot(el, this.craftGrid[ci], false);
    });
    const out = matchRecipe(this.craftGrid.slice(0, this.craftN * this.craftN), this.craftN);
    const outEl = this.$('#craft-out');
    outEl.innerHTML = '';
    outEl.dataset.recipe = out ? JSON.stringify(out) : '';
    if (out) outEl.appendChild(this._icon(out[0]));
  }

  _craftClick(ci, right) {
    const cur = this.inv.cursor;
    if (cur) {
      if (!this.craftGrid[ci]) {
        if (right && cur.count > 1) {
          const half = Math.ceil(cur.count / 2);
          this.craftGrid[ci] = { item: cur.item, count: half };
          cur.count -= half; if (cur.count <= 0) this.inv.cursor = null;
        } else { this.craftGrid[ci] = cur; this.inv.cursor = null; }
      } else if (this.craftGrid[ci].item === cur.item) {
        this.craftGrid[ci].count = Math.min(64, this.craftGrid[ci].count + (right ? 1 : cur.count));
        cur.count -= right ? 1 : cur.count; if (cur.count <= 0) this.inv.cursor = null;
      } else {
        const t = this.craftGrid[ci]; this.craftGrid[ci] = cur; this.inv.cursor = t;
      }
    } else {
      const st = this.craftGrid[ci];
      if (st) {
        if (right) {
          const half = Math.ceil(st.count / 2);
          this.inv.cursor = { item: st.item, count: half };
          st.count -= half; if (st.count <= 0) this.craftGrid[ci] = null;
        } else { this.inv.cursor = st; this.craftGrid[ci] = null; }
      }
    }
    this._renderCursorStack();
    this.refreshCraftDOM();
  }

  takeCraftOutput() {
    const outEl = this.$('#craft-out');
    if (!outEl.dataset.recipe) return false;
    const [item, count] = JSON.parse(outEl.dataset.recipe);
    // consume one of each ingredient
    for (let i = 0; i < this.craftN * this.craftN; i++) {
      const st = this.craftGrid[i];
      if (st) { st.count--; if (st.count <= 0) this.craftGrid[i] = null; }
    }
    this.inv.give(item, count);
    this.refreshCraftDOM();
    return true;
  }

  _renderCursorStack() {
    const el = this.$('#cursor-stack');
    el.innerHTML = '';
    if (this.inv.cursor) {
      el.appendChild(this._icon(this.inv.cursor.item));
      const c = document.createElement('span');
      c.className = 'count'; c.textContent = this.inv.cursor.count;
      el.appendChild(c);
      el.style.display = 'block';
    } else el.style.display = 'none';
  }

  updateCursorFollow(e) {
    const el = this.$('#cursor-stack');
    if (el) { el.style.left = (e.clientX + 8) + 'px'; el.style.top = (e.clientY + 8) + 'px'; }
  }

  // ---- Screens ----
  openInventory(creative = false, craft3 = false) {
    this.invOpen = true;
    this.setCraftSize(craft3 ? 3 : 2);
    this.$('#inventory-screen').classList.remove('hidden');
    this.$('#inv-mode-label').textContent = creative ? '(Creative — click items below palette)' : '';
    if (creative) this._buildCreativePalette();
    this.refreshInventoryDOM();
    this.dispatchEvent(new Event('uiOpened'));
  }
  closeInventory() {
    this.invOpen = false;
    // return craft grid + cursor to inventory
    for (let i = 0; i < 9; i++) if (this.craftGrid[i]) { this.inv.give(this.craftGrid[i].item, this.craftGrid[i].count); this.craftGrid[i] = null; }
    if (this.inv.cursor) { this.inv.give(this.inv.cursor.item, this.inv.cursor.count); this.inv.cursor = null; }
    this.$('#inventory-screen').classList.add('hidden');
    this.dispatchEvent(new Event('uiClosed'));
    this.refreshInventoryDOM();
  }
  _buildCreativePalette() {
    let pal = this.$('#creative-palette');
    if (pal) return;
    pal = document.createElement('div');
    pal.id = 'creative-palette';
    const names = Object.values(registry.byId).filter(b => b && b.id !== 0).map(b => b.name);
    for (const n of names) {
      const s = document.createElement('div');
      s.className = 'slot palette-slot';
      s.appendChild(this._icon(n));
      s.title = registry.byNameGet(n).display;
      s.addEventListener('mousedown', () => {
        if (this.inv.cursor) { this.inv.cursor = null; }
        this.inv.cursor = { item: n, count: 64 };
        this._renderCursorStack();
      });
      pal.appendChild(s);
    }
    this.$('#inv-panel').insertBefore(pal, this.$('#inv-main'));
  }

  showPause(show) {
    this.$('#pause-screen').classList.toggle('hidden', !show);
    if (show) this.dispatchEvent(new Event('uiOpened'));
  }

  openChat(prefill = '') {
    this.$('#chat-input-wrap').classList.remove('hidden');
    this.chatInput.value = prefill;
    this.chatInput.focus();
    this.dispatchEvent(new Event('chatOpened'));
  }
  closeChat() {
    this.$('#chat-input-wrap').classList.add('hidden');
    this.chatInput.blur();
    this.dispatchEvent(new Event('chatClosed'));
  }
  get chatOpen() { return !this.$('#chat-input-wrap').classList.contains('hidden'); }
  get uiActive() { return this.invOpen || this.chatOpen || !this.$('#pause-screen').classList.contains('hidden'); }

  addChatLine(text, cls = '') {
    const log = this.$('#chat-log');
    const d = document.createElement('div');
    d.className = 'chat-line ' + cls;
    d.textContent = text;
    log.appendChild(d);
    while (log.children.length > 8) log.removeChild(log.firstChild);
    clearTimeout(this._chatTimer);
    this._chatTimer = setTimeout(() => { log.innerHTML = ''; }, 12000);
  }

  toast(text) {
    const t = this.$('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  setBreakProgress(p) {
    const el = this.$('#break-fill');
    if (el) el.style.width = Math.round(p * 100) + '%';
  }

  setHealth(hp) {
    const bar = this.$('#health-bar');
    if (!bar) return;
    const hearts = Math.max(0, Math.ceil(hp / 2));
    let s = '';
    for (let i = 0; i < 10; i++) s += `<span class="heart ${i < hearts ? '' : 'empty'}">${i < hearts ? '❤' : '🖤'}</span>`;
    if (bar.dataset.hearts !== String(hearts)) { bar.innerHTML = s; bar.dataset.hearts = String(hearts); }
  }

  setHunger(v) {
    const bar = this.$('#hunger-bar');
    if (!bar) return;
    const drumsticks = Math.max(0, Math.ceil(v / 2));
    if (bar.dataset.v !== String(drumsticks)) {
      let s = '';
      for (let i = 0; i < 10; i++) s += `<span class="food ${i < drumsticks ? '' : 'empty'}">${i < drumsticks ? '🍗' : '·'}</span>`;
      bar.innerHTML = s; bar.dataset.v = String(drumsticks);
    }
  }

  toggleWaterOverlay(on) { this.$('#water-overlay').classList.toggle('hidden', !on); }
  flashDamage() {
    const o = this.$('#damage-overlay');
    o.classList.remove('hidden');
    setTimeout(() => o.classList.add('hidden'), 220);
  }
  flashThunder() {
    const o = this.$('#flash-overlay');
    o.classList.remove('hidden');
    setTimeout(() => o.classList.add('hidden'), 120);
  }

  updateDebug(info) {
    const now = performance.now();
    if (now - this._lastDebugUpdate < 100) return; // 10 Hz
    this._lastDebugUpdate = now;
    const el = this.$('#debug');
    if (el.classList.contains('hidden')) return;
    el.innerText = info;
  }
  toggleDebug() { this.$('#debug').classList.toggle('hidden'); }
}
