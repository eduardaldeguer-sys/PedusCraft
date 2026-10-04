// Mesh builder: converts chunk Uint16Array into GPU-ready vertex/index buffers.
// Two passes: opaque geometry and translucent (water/glass/leaves) geometry.
// Face culling + per-vertex ambient occlusion + biome tint + packed light attribute.
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, registry, BIOME_TINT, BLOCK as _B } from './blocks.js';
const BLOCK = { grassId: _B.grass, oakLeavesId: _B.oak_leaves, spruceLeavesId: _B.spruce_leaves };
import { tileUV, ATLAS_COLS } from '../core/atlas.js';

const idx = (x, y, z) => (y * CHUNK_SZ + z) * CHUNK_SX + x;

// Face definitions: [dirX,dirY,dirZ, 4 corner offsets (x,y,z), uvs]
// corners ordered CCW when viewed from outside
const FACES = [
  { dir: [0, 1, 0],  // top (+Y)
    corners: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], uvs: [[0,1],[1,1],[1,0],[0,0]] },
  { dir: [0, -1, 0], // bottom (-Y)
    corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
  { dir: [1, 0, 0],  // +X
    corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
  { dir: [-1, 0, 0], // -X
    corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
  { dir: [0, 0, 1],  // +Z
    corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
  { dir: [0, 0, -1], // -Z
    corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
];

// AO: for a face vertex, the three neighbor voxels beside the face plane
const FACE_AXES = [
  // [faceNormal, uAxis, vAxis] as index into corner coords
  { n: [0,1,0],  u: [1,0,0], v: [0,0,1] },
  { n: [0,-1,0], u: [1,0,0], v: [0,0,1] },
  { n: [1,0,0],  u: [0,0,1], v: [0,1,0] },
  { n: [-1,0,0], u: [0,0,1], v: [0,1,0] },
  { n: [0,0,1],  u: [1,0,0], v: [0,1,0] },
  { n: [0,0,-1], u: [1,0,0], v: [0,1,0] },
];
function aoOffsets(faceIdx, cornerIdx) {
  const A = FACE_AXES[faceIdx];
  const c = FACES[faceIdx].corners[cornerIdx];
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const su = dot(c, A.u) === 1 ? 1 : -1;
  const sv = dot(c, A.v) === 1 ? 1 : -1;
  const s1 = [A.n[0]+A.u[0]*su, A.n[1]+A.u[1]*su, A.n[2]+A.u[2]*su];
  const s2 = [A.n[0]+A.v[0]*sv, A.n[1]+A.v[1]*sv, A.n[2]+A.v[2]*sv];
  const cr = [A.n[0]+A.u[0]*su+A.v[0]*sv, A.n[1]+A.u[1]*su+A.v[1]*sv, A.n[2]+A.u[2]*su+A.v[2]*sv];
  return [s1, s2, cr];
}

/**
 * Build meshes for a chunk.
 * @param {Uint16Array} data chunk blocks
 * @param {Uint8Array} light packed sky/block light
 * @param {Uint8Array} biome per-column biome id
 * @param {Function} getBlockWorld (wx,wy,wz)=>id  for border faces & AO
 * @param {number} bx,bz chunk origin world coords
 */
export function buildChunkMesh(data, light, biome, getBlockWorld, bx, bz) {
  const opaque = { pos: [], uv: [], norm: [], light: [], ao: [], color: [], ind: [] };
  const trans = { pos: [], uv: [], norm: [], light: [], ao: [], color: [], ind: [] };

  const isOpaqueId = (id) => { const b = registry.get(id); return b && b.opaque; };

  for (let y = 0; y < CHUNK_SY; y++) {
    // quick skip empty column slices? minor; keep simple
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const i = idx(x, y, z);
        const id = data[i];
        if (id === 0) continue;
        const blk = registry.get(id);
        if (!blk) continue;
        const isLiquid = blk.liquid;
        const isCross = blk.cross;
        const out = (blk.opaque && !isCross) ? opaque : trans;

        let aboveIsLiquid = false;
        if (isLiquid) {
          const ai = y + 1 < CHUNK_SY ? data[idx(x, y + 1, z)] : getBlockWorld(bx + x, y + 1, bz + z);
          const ab = registry.get(ai);
          aboveIsLiquid = !!(ab && ab.liquid);
        }
        const wx = bx + x, wz = bz + z;
        const bio = biome[z * CHUNK_SX + x];
        const tint = blk.color ? blk.color : (BIOME_TINT[bio] || null);
        const needsTint = (id === BLOCK.grassId || id === BLOCK.oakLeavesId || id === BLOCK.spruceLeavesId);

        if (isCross) {
          // two diagonal quads (both sides)
          addCrossQuad(out, x, y, z, blk, light[i], tint, needsTint);
          continue;
        }

        for (let fi = 0; fi < 6; fi++) {
          const f = FACES[fi];
          const nx = x + f.dir[0], ny = y + f.dir[1], nz = z + f.dir[2];
          let nid;
          if (nx >= 0 && nx < CHUNK_SX && ny >= 0 && ny < CHUNK_SY && nz >= 0 && nz < CHUNK_SZ) {
            nid = data[idx(nx, ny, nz)];
          } else {
            nid = getBlockWorld(bx + nx, ny, bz + nz);
          }
          // Culling rule
          if (isOpaqueId(nid)) continue;
          if (isLiquid && nid === id) continue;           // water-water
          if ((id === _B.glass || isLiquid) && nid === id) continue; // glass-glass, water-water cull
          // liquid top face only when above is air
          const baseV = out.pos.length / 3;
          const tileIdx = fi === 0 ? blk.tiles[0] : fi === 1 ? blk.tiles[1] : blk.tiles[2];
          const uv = tileUV(tileIdx);
          const topDrop = isLiquid ? 0.12 : 0;

          for (let ci = 0; ci < 4; ci++) {
            const c = f.corners[ci];
            let px = x + c[0], py = y + c[1], pz = z + c[2];
            if (isLiquid && !aboveIsLiquid) {
              if (py === y + 1) py -= topDrop;
              // shrink side faces inward a hair at top? keep simple
            }
            out.pos.push(px, py, pz);
            const cu = f.uvs[ci][0], cv = f.uvs[ci][1];
            out.uv.push(cu ? uv.u1 : uv.u0, cv ? uv.v0 : uv.v1);
            out.norm.push(f.dir[0], f.dir[1], f.dir[2]);
            // light: sample the air block adjacent to face (or inside for liquids)
            let lv;
            const inChunk = nx >= 0 && nx < CHUNK_SX && ny >= 0 && ny < CHUNK_SY && nz >= 0 && nz < CHUNK_SZ;
            const li = inChunk ? light[idx(nx, ny, nz)] : light[i];
            const skyL = (li >> 4) & 15, blkL = li & 15;
            const ownSky = (light[i] >> 4) & 15, ownBlk = light[i] & 15;
            lv = Math.max(skyL, ownSky, (Math.max(blkL, ownBlk) * 1.0));
            out.light.push(Math.min(15, lv) / 15);
            // AO
            let aoVal = 1;
            if (blk.opaque) {
              const [s1, s2, crn] = aoOffsets(fi, ci);
              const occ = (ox, oy, oz) => {
                const qx = x + ox, qy = y + oy, qz = z + oz;
                if (qx < 0 || qx >= CHUNK_SX || qy < 0 || qy >= CHUNK_SY || qz < 0 || qz >= CHUNK_SZ) {
                  return isOpaqueId(getBlockWorld(bx + qx, qy, bz + qz)) ? 1 : 0;
                }
                return isOpaqueId(data[idx(qx, qy, qz)]) ? 1 : 0;
              };
              const o1 = occ(s1[0], s1[1], s1[2]), o2 = occ(s2[0], s2[1], s2[2]), oc = occ(crn[0], crn[1], crn[2]);
              const level = (o1 && o2) ? 3 : (o1 + o2 + oc);
              aoVal = [1.0, 0.82, 0.66, 0.5][level];
            }
            out.ao.push(aoVal);
            // tint color
            if (needsTint && tint) out.color.push(tint[0], tint[1], tint[2]);
            else out.color.push(1, 1, 1);
          }
          // flip triangle winding on -X/-Z to fix UV orientation artifacts
          out.ind.push(baseV, baseV + 1, baseV + 2, baseV, baseV + 2, baseV + 3);
        }
      }
    }
  }

  const pack = (o) => ({
    positions: new Float32Array(o.pos),
    uvs: new Float32Array(o.uv),
    normals: new Float32Array(o.norm),
    lights: new Float32Array(o.light),
    aos: new Float32Array(o.ao),
    colors: new Float32Array(o.color),
    indices: new Uint32Array(o.ind),
  });
  return { opaque: pack(opaque), transparent: pack(trans) };
}

function addCrossQuad(out, x, y, z, blk, lightPacked, tint, needsTint) {
  const uv = tileUV(blk.tiles[2]);
  const l = Math.max(lightPacked >> 4, lightPacked & 15) / 15;
  const diag = [
    [[0.15,0,0.15],[0.85,0,0.85],[0.85,1,0.85],[0.15,1,0.15]],
    [[0.85,0,0.15],[0.15,0,0.85],[0.15,1,0.85],[0.85,1,0.15]],
  ];
  for (const quad of diag) {
    const base = out.pos.length / 3;
    for (let s = 0; s < 2; s++) { // both facings
      for (let ci = 0; ci < 4; ci++) {
        const c = quad[s === 0 ? ci : (3 - ci)];
        out.pos.push(x + c[0], y + c[1], z + c[2]);
        const uvs = [[0,1],[1,1],[1,0],[0,0]];
        const uvo = uvs[ci];
        out.uv.push(uvo[0] ? uv.u1 : uv.u0, uvo[1] ? uv.v0 : uv.v1);
        out.norm.push(0, 1, 0);
        out.light.push(l);
        out.ao.push(1);
        if (needsTint && tint) out.color.push(tint[0], tint[1], tint[2]);
        else out.color.push(1, 1, 1);
      }
      out.ind.push(base, base+1, base+2, base, base+2, base+3);
    }
  }
}

