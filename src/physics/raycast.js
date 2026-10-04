// DDA voxel raycasting (Amanatides & Woo). Returns first solid/liquid hit within reach.
import { CHUNK_SY, registry } from '../world/blocks.js';

/**
 * @param {Function} getBlock (x,y,z)=>id
 * @returns null | { x,y,z, nx,ny,nz, dist, id }
 */
export function raycastVoxel(getBlock, ox, oy, oz, dx, dy, dz, maxDist = 5, includeLiquid = false) {
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  dx /= len; dy /= len; dz /= len;

  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY) : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ) : Infinity;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;
  // Check the origin voxel too (e.g., head inside water)
  for (let i = 0; i < 256; i++) {
    if (y >= 0 && y < CHUNK_SY) {
      const id = getBlock(x, y, z);
      if (id !== 0) {
        const b = registry.get(id);
        if (b && (b.solid || (includeLiquid && b.liquid))) {
          return { x, y, z, nx, ny, nz, dist: t, id };
        }
      }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
    }
    if (t > maxDist) return null;
  }
  return null;
}
