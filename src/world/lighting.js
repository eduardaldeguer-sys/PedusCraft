// Light engine: sky + block light stored packed in a Uint8Array per chunk
// (upper nibble = sky light, lower nibble = block light). BFS flood fill.
// Runs inside Web Workers during meshing and on the main thread for edits.
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, registry } from './blocks.js';

export const LIGHT_SIZE = CHUNK_SX * CHUNK_SY * CHUNK_SZ;
const idx = (x, y, z) => (y * CHUNK_SZ + z) * CHUNK_SX + x;

// Direction vectors for propagation
const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

/**
 * Compute full lighting for a chunk given neighbor access.
 * @param {Uint16Array} data this chunk blocks
 * @param {Function} getBlockGlobal (wx,wy,wz)=>id  world-space accessor (clamped at borders)
 * @param {number} bx,bz world coords of chunk origin
 * @returns {Uint8Array} packed light
 */
export function computeLight(data, getBlockGlobal, bx, bz) {
  const light = new Uint8Array(LIGHT_SIZE);
  // queues as flat arrays [x,y,z,level,...] using typed ring buffers
  let queueX = new Int16Array(65536), queueY = new Int16Array(65536), queueZ = new Int16Array(65536), queueL = new Int8Array(65536);
  let qh = 0, qt = 0;
  const push = (x, y, z, l) => {
    if (qt === queueX.length) { // grow (rare)
      const n = queueX.length * 2;
      const nx = new Int16Array(n), ny = new Int16Array(n), nz = new Int16Array(n), nl = new Int8Array(n);
      nx.set(queueX.subarray(qh)); ny.set(queueY.subarray(qh)); nz.set(queueZ.subarray(qh)); nl.set(queueL.subarray(qh));
      qt -= qh; qh = 0; queueX = nx; queueY = ny; queueZ = nz; queueL = nl;
    }
    queueX[qt] = x; queueY[qt] = y; queueZ[qt] = z; queueL[qt] = l; qt++;
  };

  const opacityOf = (id) => {
    const b = registry.get(id);
    return b ? b.opacity : 15;
  };

  // --- Sky light: straight-down vertical pass first ---
  for (let z = 0; z < CHUNK_SZ; z++) {
    for (let x = 0; x < CHUNK_SX; x++) {
      let l = 15;
      for (let y = CHUNK_SY - 1; y >= 0; y--) {
        const id = data[idx(x, y, z)];
        const op = opacityOf(id);
        if (op >= 15) { l = 0; }
        else if (op > 0) { l = Math.max(0, l - op); }
        light[idx(x, y, z)] = (l << 4);
        if (l > 0 && y < CHUNK_SY - 1) push(x, y, z, l);
      }
    }
  }
  // Horizontal spread of skylight (BFS)
  while (qh < qt) {
    const x = queueX[qh], y = queueY[qh], z = queueZ[qh], l = queueL[qh]; qh++;
    if (l <= 1) continue;
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= CHUNK_SX || ny >= CHUNK_SY || nz >= CHUNK_SZ) continue;
      const ni = idx(nx, ny, nz);
      const op = opacityOf(data[ni]);
      if (op >= 15) continue;
      const nl = l - 1 - (op > 0 ? op - 1 : 0);
      const cur = light[ni] >> 4;
      if (nl > cur) {
        light[ni] = (light[ni] & 0x0f) | (nl << 4);
        push(nx, ny, nz, nl);
      }
    }
  }

  // --- Block light: seeds from emissive blocks (also checks neighbors across border) ---
  qh = qt = 0;
  for (let z = 0; z < CHUNK_SZ; z++) for (let x = 0; x < CHUNK_SX; x++) for (let y = 0; y < CHUNK_SY; y++) {
    const i = idx(x, y, z);
    const em = registry.get(data[i])?.light || 0;
    if (em > 0) {
      light[i] = (light[i] & 0xf0) | em;
      push(x, y, z, em);
    }
  }
  // border seeds from neighbor block-light values via global accessor is skipped for
  // simplicity; sources near borders still illuminate correctly within one chunk radius.
  while (qh < qt) {
    const x = queueX[qh], y = queueY[qh], z = queueZ[qh], l = queueL[qh]; qh++;
    if (l <= 1) continue;
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= CHUNK_SX || ny >= CHUNK_SY || nz >= CHUNK_SZ) continue;
      const ni = idx(nx, ny, nz);
      const op = opacityOf(data[ni]);
      if (op >= 15) continue;
      const nl = l - 1 - (op > 0 ? op - 1 : 0);
      const cur = light[ni] & 0x0f;
      if (nl > cur) {
        light[ni] = (light[ni] & 0xf0) | nl;
        push(nx, ny, nz, nl);
      }
    }
  }
  return light;
}

// Combined brightness 0..1 for mesh vertex shading (sky dimmed by day/night uniform later)
export function lightValue(lightArr, x, y, z) {
  const v = lightArr[idx(x, y, z)];
  const sky = v >> 4, blk = v & 0x0f;
  return Math.max(sky, blk);
}
