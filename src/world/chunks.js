// ChunkManager: spiral loading, worker pool, mesh uploads, LRU unloading.
import * as THREE from 'three';
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, registry, BLOCK } from '../world/blocks.js';
import { WorldSampler, generateChunk } from '../world/terrain.js';
import { computeLight } from '../world/lighting.js';
import { buildChunkMesh } from '../world/mesher.js';

const STATE = { UNLOADED: 0, GENERATING: 1, LOADED: 2, DIRTY: 3 };
export { STATE };

const key = (cx, cz) => cx + ',' + cz;

export class ChunkManager {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Material} opaqueMat
   * @param {THREE.Material} transMat
   * @param {number} seed
   */
  constructor(scene, opaqueMat, transMat, seed) {
    this.scene = scene;
    this.opaqueMat = opaqueMat;
    this.transMat = transMat;
    this.seed = seed | 0;
    this.chunks = new Map();           // key -> chunk record
    this.renderDistance = 8;
    this.sampler = new WorldSampler(this.seed); // main-thread mirror for physics/raycast
    this.edits = new Map();            // key -> Int16Array sparse edits [idx,id,...]
    this.dirty = [];                   // keys needing remesh on main thread
    this._reqId = 1;
    this._pending = new Map();         // reqId -> {cx,cz}
    this._queue = [];                  // chunks waiting to be sent to a worker
    this._spiralCache = new Map();     // renderDistance -> ordered offsets
    this._workers = [];
    this._workerBusy = [];
    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(2, Math.min(6, hw - 1));
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('../workers/chunk.worker.js', import.meta.url), { type: 'classic' });
        w.onmessage = (e) => this._onWorkerMessage(e.data);
        this._workers.push(w);
        this._workerBusy.push(false);
      } catch (err) {
        console.warn('Worker spawn failed, falling back to main thread', err);
      }
    }
  }

  setSeed(seed) {
    this.seed = seed | 0;
    this.sampler = new WorldSampler(this.seed);
    for (const c of this.chunks.values()) this._dispose(c);
    this.chunks.clear();
    this.edits.clear();
  }

  // ---- accessors ----
  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_SY) return 0;
    const cx = wx >> 4, cz = wz >> 4;
    const c = this.chunks.get(key(cx, cz));
    if (!c || !c.blocks) return 0;
    return c.blocks[((wy * CHUNK_SZ) + (wz & 15)) * CHUNK_SX + (wx & 15)];
  }

  getBiome(wx, wz) {
    const cx = wx >> 4, cz = wz >> 4;
    const c = this.chunks.get(key(cx, cz));
    if (!c || !c.biome) return this.sampler.biomeAt(wx, wz);
    return c.biome[(wz & 15) * CHUNK_SX + (wx & 15)];
  }

  setBlock(wx, wy, wz, id, recordEdit = true) {
    if (wy < 1 || wy >= CHUNK_SY) return false;
    const cx = wx >> 4, cz = wz >> 4;
    const k = key(cx, cz);
    const c = this.chunks.get(k);
    if (!c || !c.blocks) return false;
    const li = ((wy * CHUNK_SZ) + (wz & 15)) * CHUNK_SX + (wx & 15);
    if (c.blocks[li] === id) return false;
    c.blocks[li] = id;
    if (recordEdit) this._recordEdit(k, li, id);
    this._remeshLocal(c);
    // neighbors need border re-mesh if on edge
    const lx = wx & 15, lz = wz & 15;
    if (lx === 0) this._remeshNeighbor(cx - 1, cz);
    if (lx === 15) this._remeshNeighbor(cx + 1, cz);
    if (lz === 0) this._remeshNeighbor(cx, cz - 1);
    if (lz === 15) this._remeshNeighbor(cx, cz + 1);
    return true;
  }

  _recordEdit(k, li, id) {
    let e = this.edits.get(k);
    // merge: replace existing entry for same index if present
    if (e) {
      for (let i = 0; i < e.length; i += 2) {
        if (e[i] === li) { e[i + 1] = id; this._markDirty(k); return; }
      }
      const ne = new Int16Array(e.length + 2);
      ne.set(e); ne[e.length] = li; ne[e.length + 1] = id;
      this.edits.set(k, ne);
    } else {
      this.edits.set(k, Int16Array.of(li, id));
    }
    this._markDirty(k);
  }

  _markDirty(k) {
    const c = this.chunks.get(k);
    if (c && c.state === STATE.LOADED) { c.state = STATE.DIRTY; if (!this.dirty.includes(k)) this.dirty.push(k); }
  }

  _remeshLocal(c) {
    const k = key(c.cx, c.cz);
    c.light = computeLight(c.blocks, () => 0, c.cx * 16, c.cz * 16);
    this._rebuildMesh(c);
    this._markDirtyNeighborsBorder(k);
  }

  _markDirtyNeighborsBorder() { /* handled via explicit neighbor calls in setBlock */ }

  _remeshNeighbor(cx, cz) {
    const c = this.chunks.get(key(cx, cz));
    if (c && c.blocks) {
      c.light = computeLight(c.blocks, () => 0, cx * 16, cz * 16);
      this._rebuildMesh(c);
    }
  }

  // Main-thread synchronous remesh using loaded neighbor data where possible
  _getBlockWorldForMesh(c) {
    return (wx, wy, wz) => this.getBlock(wx, wy, wz);
  }

  _rebuildMesh(c) {
    const mesh = buildChunkMesh(c.blocks, c.light, c.biome, this._getBlockWorldForMesh(c), c.cx * 16, c.cz * 16);
    this._applyMesh(c, mesh);
  }

  // ---- update loop (called each frame with player position) ----
  update(px, pz) {
    const pcx = Math.floor(px / 16), pcz = Math.floor(pz / 16);
    const rd = this.renderDistance;
    const order = this._getSpiral(rd);
    // Request needed chunks
    let queued = 0;
    for (const [ox, oz] of order) {
      if (queued > 4) break;
      const cx = pcx + ox, cz = pcz + oz;
      const k = key(cx, cz);
      if (this.chunks.has(k)) continue;
      const rec = { cx, cz, state: STATE.GENERATING, meshes: null, blocks: null, light: null, biome: null, lastUse: performance.now() };
      this.chunks.set(k, rec);
      this._requestGenerate(rec);
      queued++;
    }
    // Touch usage stamps for visible chunks
    for (const [ox, oz] of order) {
      const k = key(pcx + ox, pcz + oz);
      const c = this.chunks.get(k);
      if (c) c.lastUse = performance.now();
    }
    // Unload far chunks (LRU)
    const maxD = rd + 3;
    for (const [k, c] of this.chunks) {
      if (Math.abs(c.cx - pcx) > maxD || Math.abs(c.cz - pcz) > maxD) {
        this._dispose(c);
        this.chunks.delete(k);
      }
    }
    // Process dirty queue (throttled)
    let budget = 6;
    while (this.dirty.length && budget-- > 0) {
      const k = this.dirty.shift();
      const c = this.chunks.get(k);
      if (c && c.blocks) {
        c.state = STATE.LOADED;
        c.light = computeLight(c.blocks, () => 0, c.cx * 16, c.cz * 16);
        this._rebuildMesh(c);
        // also refresh neighbors' light border approximations
      }
    }
  }

  _getSpiral(rd) {
    const cached = this._spiralCache.get(rd);
    if (cached) return cached;
    const cells = [];
    for (let x = -rd; x <= rd; x++) for (let z = -rd; z <= rd; z++) {
      cells.push([x, z, x * x + z * z]);
    }
    cells.sort((a, b) => a[2] - b[2]);
    const out = cells.map(c => [c[0], c[1]]);
    this._spiralCache.set(rd, out);
    return out;
  }

  _requestGenerate(c) {
    const edits = this.edits.get(key(c.cx, c.cz));
    if (this._workers.length) {
      for (let i = 0; i < this._workers.length; i++) {
        if (!this._workerBusy[i]) {
          this._workerBusy[i] = true;
          const reqId = this._reqId++;
          this._pending.set(reqId, c);
          this._workers[i].postMessage({
            reqId, seed: this.seed, cx: c.cx, cz: c.cz,
            edits: edits ? Array.from(edits) : null,
          });
          return;
        }
      }
      // all busy: enqueue
      this._queue.push(c);
      return;
    }
    // Fallback: main-thread generation (async microtask to avoid blocking input)
    Promise.resolve().then(() => {
      const { data, biome } = generateChunk(this.sampler, c.cx, c.cz, edits || null);
      const light = computeLight(data, () => 0, c.cx * 16, c.cz * 16);
      const mesh = buildChunkMesh(data, light, biome, () => 0, c.cx * 16, c.cz * 16);
      this._finishChunk(c, data, biome, light, mesh);
    });
  }

  _onWorkerMessage(msg) {
    // free worker
    for (let i = 0; i < this._workers.length; i++) {
      if (this._workerBusy[i]) { /* can't map directly; use pending instead */ }
    }
    // Mark first busy worker free (simple policy — responses are FIFO per worker but we track by reqId)
    // Find any busy slot and release it (approximation is fine since work is uniform)
    const busyIdx = this._workerBusy.findIndex(b => b);
    if (busyIdx >= 0) this._workerBusy[busyIdx] = false;
    // Start queued work if any
    while (this._queue.length) {
      const free = this._workerBusy.findIndex(b => !b);
      if (free < 0) break;
      const c = this._queue.shift();
      if (c.state === STATE.GENERATING && this.chunks.get(key(c.cx, c.cz)) === c) {
        this._workerBusy[free] = true;
        const reqId = this._reqId++;
        this._pending.set(reqId, c);
        const edits = this.edits.get(key(c.cx, c.cz));
        this._workers[free].postMessage({ reqId, seed: this.seed, cx: c.cx, cz: c.cz, edits: edits ? Array.from(edits) : null });
      }
    }

    const c = this._pending.get(msg.reqId);
    this._pending.delete(msg.reqId);
    if (!c) return; // chunk was unloaded meanwhile
    if (this.chunks.get(key(c.cx, c.cz)) !== c) return;
    const blocks = new Uint16Array(msg.blocks);
    const biome = new Uint8Array(msg.biomeBuf);
    const light = new Uint8Array(msg.lightBuf);
    const mesh = { opaque: msg.opaque, transparent: msg.transparent };
    this._finishChunk(c, blocks, biome, light, mesh);
  }

  _finishChunk(c, blocks, biome, light, mesh) {
    c.blocks = blocks; c.biome = biome; c.light = light;
    c.state = STATE.LOADED;
    this._applyMesh(c, mesh);
  }

  _applyMesh(c, mesh) {
    // dispose old
    if (c.meshes) {
      for (const m of c.meshes) {
        this.scene.remove(m.mesh);
        m.mesh.geometry.dispose();
      }
      c.meshes = null;
    }
    if (!c.meshes) c.meshes = [];
    const mk = (m, mat, transp) => {
      if (m.indices.length === 0) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
      g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      g.setAttribute('a_light', new THREE.BufferAttribute(m.lights, 1));
      g.setAttribute('a_ao', new THREE.BufferAttribute(m.aos, 1));
      g.setAttribute('a_color', new THREE.BufferAttribute(m.colors, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      g.computeBoundingSphere();
      const meshObj = new THREE.Mesh(g, mat);
      meshObj.position.set(c.cx * 16, 0, c.cz * 16);
      meshObj.frustumCulled = true;
      meshObj.renderOrder = transp ? 1 : 0;
      if (transp) meshObj.material = this.transMat;
      this.scene.add(meshObj);
      c.meshes.push({ mesh: meshObj });
    };
    mk(mesh.opaque, this.opaqueMat, false);
    mk(mesh.transparent, this.transMat, true);
  }

  _dispose(c) {
    if (c.meshes) {
      for (const m of c.meshes) {
        this.scene.remove(m.mesh);
        m.mesh.geometry.dispose();
      }
    }
  }

  serializeEdits() {
    const out = {};
    for (const [k, v] of this.edits) out[k] = Array.from(v);
    return out;
  }

  loadEdits(obj) {
    this.edits.clear();
    for (const k of Object.keys(obj)) this.edits.set(k, Int16Array.from(obj[k]));
    // force regenerate loaded chunks
    for (const c of this.chunks.values()) {
      this._dispose(c);
      c.state = STATE.UNLOADED;
    }
    for (const [k, c] of [...this.chunks]) {
      this.chunks.delete(k);
    }
  }
}
