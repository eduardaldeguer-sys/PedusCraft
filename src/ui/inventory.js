// Inventory + crafting model (pure JS state, emits events for the DOM UI).
import { registry } from '../world/blocks.js';

export const STACK_MAX = 64;

export class Inventory extends EventTarget {
  constructor() {
    super();
    this.hotbar = new Array(9).fill(null);   // {item:'dirt', count:20} | null
    this.main = new Array(27).fill(null);
    this.cursor = null;                       // stack held by mouse during drag
    this.selected = 0;
    // give starter kit (creative-flavored survival start)
    this.give('oak_log', 32);
    this.give('oak_planks', 16);
    this.give('cobblestone', 32);
    this.give('dirt', 32);
    this.give('glowstone', 8);
    this.give('glass', 16);
    this.give('crafting_table', 1);
    this.give('tnt', 4);
  }

  _emit() { this.dispatchEvent(new CustomEvent('inventoryUpdated')); }

  allSlots() { return [...this.hotbar, ...this.main]; }

  get(slotIdx) {
    return slotIdx < 9 ? this.hotbar[slotIdx] : this.main[slotIdx - 9];
  }
  set(slotIdx, stack) {
    if (slotIdx < 9) this.hotbar[slotIdx] = stack; else this.main[slotIdx - 9] = stack;
    this._emit();
  }

  selectedStack() { return this.hotbar[this.selected]; }

  /** Add items to inventory. Returns leftover count. */
  give(item, count = 1) {
    // merge into existing stacks first (hotbar then main)
    const slots = [...this.hotbar.keys(), ...this.main.map((_, i) => i + 9)];
    for (const s of slots) {
      const st = this.get(s);
      if (st && st.item === item && st.count < STACK_MAX) {
        const add = Math.min(count, STACK_MAX - st.count);
        st.count += add; count -= add;
        if (count <= 0) { this._emit(); return 0; }
      }
    }
    for (const s of slots) {
      if (!this.get(s)) {
        const add = Math.min(count, STACK_MAX);
        this.set(s, { item, count: add });
        count -= add;
        if (count <= 0) { this._emit(); return 0; }
      }
    }
    this._emit();
    return count;
  }

  /** Remove up to `count` of item; returns true if enough existed and was removed. */
  consume(item, count = 1) {
    let have = 0;
    for (const st of this.allSlots()) if (st && st.item === item) have += st.count;
    if (have < count) return false;
    for (let s = 0; s < 36; s++) {
      const st = this.get(s);
      if (st && st.item === item) {
        const take = Math.min(count, st.count);
        st.count -= take; count -= take;
        if (st.count <= 0) this.set(s, null);
        if (count <= 0) break;
      }
    }
    this._emit();
    return true;
  }

  hasItem(item, count = 1) {
    let have = 0;
    for (const st of this.allSlots()) if (st && st.item === item) have += st.count;
    return have >= count;
  }

  selectSlot(i) { this.selected = ((i % 9) + 9) % 9; this._emit(); }

  // --- Drag & drop via cursor stack ---
  clickSlot(slotIdx, rightClick = false) {
    const st = this.get(slotIdx);
    if (this.cursor) {
      if (!st) {
        if (rightClick && this.cursor.count > 1) {
          const half = Math.ceil(this.cursor.count / 2);
          this.set(slotIdx, { item: this.cursor.item, count: half });
          this.cursor.count -= half;
          if (this.cursor.count <= 0) this.cursor = null;
        } else {
          this.set(slotIdx, this.cursor); this.cursor = null;
        }
      } else if (st.item === this.cursor.item) {
        const space = STACK_MAX - st.count;
        const add = rightClick ? Math.min(space, 1) : Math.min(space, this.cursor.count);
        st.count += add; this.cursor.count -= add;
        if (this.cursor.count <= 0) this.cursor = null;
      } else {
        this.set(slotIdx, this.cursor); this.cursor = st;
      }
    } else {
      if (!st) { this._emit(); return; }
      if (rightClick) {
        const half = Math.ceil(st.count / 2);
        this.cursor = { item: st.item, count: half };
        st.count -= half;
        if (st.count <= 0) this.set(slotIdx, null);
      } else {
        this.cursor = st; this.set(slotIdx, null);
      }
    }
    this._emit();
  }
}

// ---- Crafting ----
// Recipes: shapeless or shaped with a normalized key. Grid is array of (item|null), size n x n.
export const RECIPES = [
  { out: ['oak_planks', 4], shapeless: ['oak_log'] },
  { out: ['oak_planks', 4], shapeless: ['spruce_log'] },
  { out: ['stick', 4], shaped: ['P', 'P'], size: [1, 2], key: { P: 'oak_planks' } },
  { out: ['crafting_table', 1], shaped: ['PP', 'PP'], size: [2, 2], key: { P: 'oak_planks' } },
  { out: ['brick_block', 4], shaped: ['CC', 'CC'], size: [2, 2], key: { C: 'cobblestone' } },
  { out: ['glass', 4], shapeless: ['sand', 'sand', 'coal'] },
  { out: ['glowstone', 4], shaped: ['GG', 'GG'], size: [2, 2], key: { G: 'gold_ingot' } },
  { out: ['tnt', 1], shaped: ['SGS', 'GSG', 'SGS'], size: [3, 3], key: { S: 'sand', G: 'gunpowder_fake' } },
  { out: ['pumpkin', 1], shapeless: ['pumpkin'] }, // no-op guard example
];

/** Match a grid (array length n*n row-major, entries item|null) against recipes. */
export function matchRecipe(grid, n) {
  const items = grid.filter(Boolean);
  if (items.length === 0) return null;
  for (const r of RECIPES) {
    if (r.shapeless) {
      if (items.length !== r.shapeless.length) continue;
      const need = [...r.shapeless].sort().join(',');
      const got = [...items].sort().join(',');
      if (need === got) return r.out;
    } else {
      const [w, h] = r.size;
      if (n < w || n < h) continue;
      // trim empty border rows/cols from grid
      let cells = [];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cells.push(grid[y * n + x]);
      // find bounding box
      let minX = 99, maxX = -1, minY = 99, maxY = -1;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (grid[y * n + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      if (maxX - minX + 1 !== w || maxY - minY + 1 !== h) continue;
      let ok = true;
      for (let y = 0; y < h && ok; y++) for (let x = 0; x < w && ok; x++) {
        const got = grid[(minY + y) * n + (minX + x)];
        const want = r.shaped[y * w + x];
        const wantItem = want === ' ' ? null : r.key[want];
        if ((got || null) !== (wantItem || null)) ok = false;
      }
      if (ok) return r.out;
    }
  }
  return null;
}
