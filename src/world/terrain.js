// Terrain + population generation. Runs inside Web Workers (pure functions, no DOM).
import { SimplexNoise, fbm, fbm3, ridged, mulberry32, hashSeed } from '../core/noise.js';
import { BLOCK, CHUNK_SX, CHUNK_SY, CHUNK_SZ } from './blocks.js';

export const BIOMES = {
  PLAINS: 0, FOREST: 1, DESERT: 2, SNOWY: 3, OCEAN: 4, HILLS: 5, BEACH: 6,
};
export const BIOME_NAMES = ['Plains', 'Forest', 'Desert', 'Snowy Plains', 'Ocean', 'Rolling Hills', 'Beach'];

const SEA_LEVEL = 62;
export { SEA_LEVEL };

// Deterministic per-position sampler shared by worker & main thread
export class WorldSampler {
  constructor(seed) {
    this.seed = seed | 0;
    this.heightN = new SimplexNoise(hashSeed(seed, 1));
    this.contN = new SimplexNoise(hashSeed(seed, 2));
    this.ridgeN = new SimplexNoise(hashSeed(seed, 3));
    this.riverN = new SimplexNoise(hashSeed(seed, 4));
    this.tempN = new SimplexNoise(hashSeed(seed, 5));
    this.humN = new SimplexNoise(hashSeed(seed, 6));
    this.detailN = new SimplexNoise(hashSeed(seed, 7));
    this.caveN = new SimplexNoise(hashSeed(seed, 8));
    this.caveN2 = new SimplexNoise(hashSeed(seed, 9));
  }

  biomeAt(x, z) {
    const t = fbm(this.tempN, x * 0.0015, z * 0.0015, 3);
    const h = fbm(this.humN, x * 0.0018, z * 0.0018, 3);
    // deterministic — must match across threads
    if (t > 0.55 && h < -0.1) return BIOMES.DESERT;
    if (t < -0.45) return BIOMES.SNOWY;
    const height = this.heightAt(x, z, true);
    if (height < SEA_LEVEL - 1) return BIOMES.OCEAN;
    if (height < SEA_LEVEL + 2) return BIOMES.BEACH;
    if (h > 0.15) return BIOMES.FOREST;
    if (t > 0.1 && height > SEA_LEVEL + 14) return BIOMES.HILLS;
    return BIOMES.PLAINS;
  }

  // Base surface height at column. `raw` skips river carve for biome decisions
  heightAt(x, z, rawOnly = false) {
    const cont = fbm(this.contN, x * 0.0035, z * 0.0035, 4);          // continents
    const base = fbm(this.heightN, x * 0.012, z * 0.012, 4);           // hills
    const mtnMask = Math.max(0, fbm(this.contN, x * 0.002 + 500, z * 0.002 - 300, 2));
    const ridge = ridged(this.ridgeN, x * 0.008, z * 0.008, 4);
    let hgt = SEA_LEVEL + cont * 22 + base * 10;
    hgt += Math.pow(mtnMask, 2) * ridge * 46;
    if (!rawOnly) {
      // River carving: narrow worm-like valleys
      const r = Math.abs(fbm(this.riverN, x * 0.004, z * 0.004, 3));
      if (r < 0.06) {
        const depth = (0.06 - r) / 0.06;
        hgt -= depth * 9;
      }
    }
    return Math.floor(hgt);
  }

  isCave(x, y, z) {
    if (y < 4) return false;
    // Two-sheet worm caves via product of noise fields
    const s1 = fbm3(this.caveN, x * 0.028, y * 0.045, z * 0.028, 2);
    const s2 = fbm3(this.caveN2, x * 0.028 + 100, y * 0.045, z * 0.028 - 100, 2);
    const worm = s1 * s1 + s2 * s2;
    if (worm < 0.035 && y < 90) return true;
    // occasional large caverns near the middle depths
    if (y > 16 && y < 50) {
      const cav = this.caveN.noise3D(x * 0.02, y * 0.03, z * 0.02);
      if (cav > 0.62) return true;
    }
    return false;
  }
}

/**
 * Generate one chunk's block array (Uint16Array) + biome byte array.
 * @param {WorldSampler} sampler
 * @param {number} cx, cz chunk coords
 * @param {Int16Array|null} edits  sparse edits [idx, id, idx, id...] from saves/players
 */
export function generateChunk(sampler, cx, cz, edits) {
  const data = new Uint16Array(CHUNK_SX * CHUNK_SY * CHUNK_SZ);
  const biome = new Uint8Array(CHUNK_SX * CHUNK_SZ);
  const bx = cx * CHUNK_SX, bz = cz * CHUNK_SZ;
  const rand = mulberry32(hashSeed(sampler.seed, cx, cz));

  const idx = (x, y, z) => (y * CHUNK_SZ + z) * CHUNK_SX + x;

  // Column heights & biomes
  const heights = new Int16Array(CHUNK_SX * CHUNK_SZ);
  for (let z = 0; z < CHUNK_SZ; z++) {
    for (let x = 0; x < CHUNK_SX; x++) {
      const wx = bx + x, wz = bz + z;
      heights[z * CHUNK_SX + x] = sampler.heightAt(wx, wz);
      biome[z * CHUNK_SX + x] = sampler.biomeAt(wx, wz);
    }
  }

  for (let z = 0; z < CHUNK_SZ; z++) {
    for (let x = 0; x < CHUNK_SX; x++) {
      const h = heights[z * CHUNK_SX + x];
      const b = biome[z * CHUNK_SX + x];
      const detail = fbm(sampler.detailN, (bx + x) * 0.05, (bz + z) * 0.05, 2);
      for (let y = 0; y < CHUNK_SY; y++) {
        let id = BLOCK.air;
        if (y === 0) id = BLOCK.bedrock;
        else if (y <= 2 && rand() > 0.4) id = BLOCK.bedrock;
        else if (y <= h - 4) id = BLOCK.stone;
        else if (y < h) id = (b === BIOMES.DESERT || b === BIOMES.BEACH) ? BLOCK.sand : BLOCK.dirt;
        else if (y === h) {
          if (b === BIOMES.DESERT) id = BLOCK.sand;
          else if (b === BIOMES.BEACH) id = BLOCK.sand;
          else if (b === BIOMES.SNOWY) id = BLOCK.snow_block;
          else if (b === BIOMES.OCEAN) id = BLOCK.gravel;
          else id = detail > 0.25 ? BLOCK.cobblestone : BLOCK.grass;
        } else if (y <= SEA_LEVEL && y > h) {
          id = BLOCK.water;
        }
        // Caves (skip under oceans slightly to keep floors solid-ish)
        if (id !== BLOCK.air && id !== BLOCK.water && y > 1 && y < h && sampler.isCave(bx + x, y, bz + z)) {
          id = y < 8 ? BLOCK.air : BLOCK.air; // air pockets
        }
        // Ores in stone
        if (id === BLOCK.stone) {
          const r = rand();
          if (y < 14 && r < 0.004) id = BLOCK.diamond_ore;
          else if (y < 28 && r < 0.008) id = BLOCK.gold_ore;
          else if (y < 46 && r < 0.02) id = BLOCK.iron_ore;
          else if (r < 0.035) id = BLOCK.coal_ore;
          else if (r < 0.04 && y < 20) id = BLOCK.redstone_ore;
          else if (r < 0.048) id = BLOCK.gravel;
        }
        // Freeze water top in snowy biome
        if (id === BLOCK.water && b === BIOMES.SNOWY && y === SEA_LEVEL) id = BLOCK.ice;
        data[idx(x, y, z)] = id;
      }
    }
  }

  // ---- Population pass: trees, cacti, dead bushes ----
  placeFeatures(sampler, data, biome, heights, bx, bz, rand, idx);

  // ---- Apply player/save edits (sparse) ----
  if (edits && edits.length) {
    for (let i = 0; i < edits.length; i += 2) {
      const li = edits[i];
      if (li >= 0 && li < data.length) data[li] = edits[i + 1];
    }
  }

  return { data, biome };
}

function getOr(data, idx, lx, y, lz, def) {
  if (lx < 0 || lz < 0 || lx >= CHUNK_SX || lz >= CHUNK_SZ || y < 0 || y >= CHUNK_SY) return def;
  return data[idx(lx, y, lz)];
}

function placeFeatures(sampler, data, biome, heights, bx, bz, rand, idx) {
  // Trees are placed with a margin so they mostly fit in-chunk; cross-chunk trunks
  // are handled by re-generating neighbors identically (deterministic seeds per column).
  for (let z = 0; z < CHUNK_SZ; z++) {
    for (let x = 0; x < CHUNK_SX; x++) {
      const wx = bx + x, wz = bz + z;
      const b = biome[z * CHUNK_SX + x];
      const h = heights[z * CHUNK_SX + x];
      if (h <= SEA_LEVEL) continue;
      // deterministic per-column RNG for feature placement
      const cr = mulberry32(hashSeed(sampler.seed ^ 0x5bf03, wx, wz));
      const surface = data[idx(x, h, z)];
      if (b === BIOMES.FOREST && cr() < 0.055 && x > 1 && x < 14 && z > 1 && z < 14 && surface === BLOCK.grass) {
        plantOak(data, idx, x, h + 1, z, cr);
      } else if (b === BIOMES.PLAINS && cr() < 0.006 && x > 1 && x < 14 && z > 1 && z < 14 && surface === BLOCK.grass) {
        plantOak(data, idx, x, h + 1, z, cr);
      } else if (b === BIOMES.SNOWY && cr() < 0.02 && x > 1 && x < 14 && z > 1 && z < 14 && surface === BLOCK.snow_block) {
        plantSpruce(data, idx, x, h + 1, z, cr);
      } else if (b === BIOMES.DESERT) {
        if (cr() < 0.004 && surface === BLOCK.sand) {
          // cactus 1-3 tall
          const n = 1 + Math.floor(cr() * 3);
          for (let i = 0; i < n; i++) {
            if (data[idx(x, h + 1 + i, z)] === BLOCK.air) data[idx(x, h + 1 + i, z)] = BLOCK.cactus;
          }
        } else if (cr() < 0.02 && surface === BLOCK.sand) {
          if (data[idx(x, h + 1, z)] === BLOCK.air) data[idx(x, h + 1, z)] = BLOCK.dead_bush;
        }
      }
    }
  }
}

function plantOak(data, idx, x, y, z, cr) {
  const th = 4 + Math.floor(cr() * 3);
  for (let i = 0; i < th; i++) {
    if (y + i < CHUNK_SY) data[idx(x, y + i, z)] = BLOCK.oak_log;
  }
  const cy = y + th - 2;
  for (let dy = 0; dy < 4; dy++) {
    const rad = dy >= 2 ? 1 : 2;
    for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
      if (dx === 0 && dz === 0 && dy < 2) continue;
      if (Math.abs(dx) === rad && Math.abs(dz) === rad && cr() < 0.6) continue;
      const yy = cy + dy, xx = x + dx, zz = z + dz;
      if (yy >= CHUNK_SY) continue;
      if (xx < 0 || zz < 0 || xx >= CHUNK_SX || zz >= CHUNK_SZ) continue;
      if (data[idx(xx, yy, zz)] === BLOCK.air) data[idx(xx, yy, zz)] = BLOCK.oak_leaves;
    }
  }
}

function plantSpruce(data, idx, x, y, z, cr) {
  const th = 6 + Math.floor(cr() * 4);
  for (let i = 0; i < th; i++) {
    if (y + i < CHUNK_SY) data[idx(x, y + i, z)] = BLOCK.spruce_log;
  }
  for (let layer = 0; layer < 4; layer++) {
    const rad = layer === 3 ? 0 : 2 - Math.floor(layer / 2);
    const yy = y + th - 3 + layer;
    if (yy >= CHUNK_SY) break;
    for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
      if (dx === 0 && dz === 0 && layer < 3) continue;
      const xx = x + dx, zz = z + dz;
      if (xx < 0 || zz < 0 || xx >= CHUNK_SX || zz >= CHUNK_SZ || yy < 0) continue;
      if (data[idx(xx, yy, zz)] === BLOCK.air) data[idx(xx, yy, zz)] = BLOCK.spruce_leaves;
    }
  }
  if (y + th < CHUNK_SY) data[idx(x, y + th, z)] = BLOCK.spruce_leaves;
}
