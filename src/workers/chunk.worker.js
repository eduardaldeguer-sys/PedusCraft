// Chunk worker: generation + lighting + meshing off the main thread.
// Static imports so bundlers can inline everything into a classic worker script.
import { WorldSampler, generateChunk } from '../world/terrain.js';
import { computeLight } from '../world/lighting.js';
import { buildChunkMesh } from '../world/mesher.js';

const samplers = new Map();
function getSampler(seed) {
  let s = samplers.get(seed);
  if (!s) { s = new WorldSampler(seed); samplers.set(seed, s); }
  return s;
}

self.onmessage = (e) => {
  const { reqId, seed, cx, cz, edits } = e.data;
  const sampler = getSampler(seed);
  const { data, biome } = generateChunk(sampler, cx, cz, edits ? Int16Array.from(edits) : null);
  const light = computeLight(data, () => 0, cx * 16, cz * 16);
  const mesh = buildChunkMesh(data, light, biome, () => 0, cx * 16, cz * 16);

  const parts = [];
  const collect = (m) => {
    parts.push(m.positions.buffer, m.uvs.buffer, m.normals.buffer, m.lights.buffer, m.aos.buffer, m.colors.buffer, m.indices.buffer);
  };
  collect(mesh.opaque); collect(mesh.transparent);

  self.postMessage({
    reqId, cx, cz,
    blocks: data.buffer, biomeBuf: biome.buffer, lightBuf: light.buffer,
    opaque: mesh.opaque, transparent: mesh.transparent,
  }, [data.buffer, biome.buffer, light.buffer, ...parts]);
};
