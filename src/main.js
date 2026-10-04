// App bootstrap: main menu, world creation/loading, wiring Game <-> UI <-> storage,
// interaction handling (break/place/hotbar/keys), commands, autosave.
import * as THREE from 'three';
import { Game, atlasCanvas } from './game.js';
import { UI } from './ui/ui.js';
import { Inventory } from './ui/inventory.js';
import { registry, BLOCK, CHUNK_SY } from './world/blocks.js';
import { saveWorldMeta, listWorlds, deleteWorld, saveEdits, loadAllEdits, savePlayer, loadPlayer } from './core/storage.js';

const canvas = document.getElementById('game');
let game = null;
let ui = null;
let inv = null;
let currentWorld = null;   // {id, name, seed}
let spawnPoint = new THREE.Vector3(0, 80, 0);
let autosaveTimer = 0;

// ---------------- Menu ----------------
function showMenu() {
  const el = document.getElementById('menu-screen');
  el.classList.remove('hidden');
  renderWorldList();
}
function hideMenu() { document.getElementById('menu-screen').classList.add('hidden'); }

async function renderWorldList() {
  const list = document.getElementById('world-list');
  list.innerHTML = '';
  let worlds = [];
  try { worlds = await listWorlds(); } catch (e) { console.warn('IDB unavailable', e); }
  if (!worlds.length) { list.innerHTML = '<div class="world-empty">No saved worlds yet — create one!</div>'; }
  for (const w of worlds) {
    const row = document.createElement('div');
    row.className = 'world-row';
    const info = document.createElement('div');
    info.className = 'world-info';
    info.innerHTML = `<b>${escapeHtml(w.name)}</b><span>seed ${w.seed} · ${new Date(w.savedAt || w.createdAt).toLocaleString()}</span>`;
    info.onclick = () => startGame(w);
    const del = document.createElement('button');
    del.className = 'world-del';
    del.textContent = '✕';
    del.title = 'Delete world';
    del.onclick = async (ev) => { ev.stopPropagation(); await deleteWorld(w.id); renderWorldList(); };
    row.appendChild(info); row.appendChild(del);
    list.appendChild(row);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('world-name').value.trim() || 'New World';
  const seedStr = document.getElementById('world-seed').value.trim();
  let seed;
  if (seedStr) {
    // hash string seeds deterministically
    let h = 2166136261 >>> 0;
    for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    seed = h | 0;
  } else seed = (Math.random() * 2 ** 31) | 0;
  const rd = parseInt(document.getElementById('render-dist').value, 10) || 8;
  const world = { id: 'w_' + Date.now().toString(36) + Math.floor(Math.random()*1e4).toString(36), name, seed, createdAt: Date.now(), savedAt: Date.now(), renderDistance: rd };
  saveWorldMeta(world).then(() => startGame(world)).catch(() => startGame(world));
});

// ---------------- Game lifecycle ----------------
async function startGame(world) {
  hideMenu();
  cleanupGame();
  currentWorld = world;
  inv = new Inventory();
  game = new Game(canvas, { seed: world.seed, renderDistance: world.renderDistance || 8 });
  game.cm.renderDistance = Math.max(4, Math.min(16, world.renderDistance || 8));
  game.camera.far = 16 * game.cm.renderDistance * 1.6;
  game.camera.updateProjectionMatrix();

  ui = new UI(inv, atlasCanvas);
  wireUI();

  // Load persisted edits & player state
  try {
    const edits = await loadAllEdits(world.id);
    if (Object.keys(edits).length) game.cm.loadEdits(edits);
    const ps = await loadPlayer(world.id);
    if (ps) {
      spawnPoint.set(ps.x ?? 0, ps.y ?? 80, ps.z ?? 0);
      game.player.pos.copy(spawnPoint);
      game.player.yaw = ps.yaw || 0; game.player.pitch = ps.pitch || 0;
      game.timeOfDay = ps.time ?? 0.3;
      if (ps.inventory) restoreInventory(ps.inventory);
    }
  } catch (e) { console.warn('load failed', e); }

  findSpawnAndStart();
  game.startLoop({ afterRender: onFrame });
  game.audio.init();
}

function restoreInventory(saved) {
  try {
    inv.hotbar = saved.hotbar.map(s => s ? { ...s } : null);
    inv.main = saved.main.map(s => s ? { ...s } : null);
    inv.selected = saved.selected || 0;
  } catch (e) {}
}

function findSpawnAndStart() {
  // Find surface near x=0,z=0 using the deterministic sampler mirror in ChunkManager
  const s = game.cm.sampler;
  const h = s.heightAt(0, 0);
  spawnPoint.set(0.5, Math.max(65, h + 2), 0.5);
  game.player.pos.copy(spawnPoint);
  game.player.spawnPoint = spawnPoint.clone();
  game.paused = false;
  // Lock pointer via a click handler on canvas (Input handles it)
  ui.toast(`Welcome to ${currentWorld.name}! Click to play.`);
}

function cleanupGame() {
  if (game) { game.dispose(); game = null; }
  if (ui) { ui.removeAllListeners?.(); ui = null; }
  document.exitPointerLock?.();
}

// ---------------- Wiring ----------------
function wireUI() {
  ui.addEventListener('resume', () => { game.paused = false; game.input.requestLock(); ui.showPause(false); });
  ui.addEventListener('save', () => doSave());
  ui.addEventListener('quit', async () => { await doSave(); cleanupGame(); showMenu(); });
  ui.addEventListener('craftTake', () => { if (ui.takeCraftOutput()) game.audio.play('craft', { cat: 'ui' }); });
  ui.addEventListener('uiOpened', () => { game.paused = true; document.exitPointerLock?.(); });
  ui.addEventListener('uiClosed', () => { game.paused = false; game.input.requestLock(); });
  ui.addEventListener('chatOpened', () => { game.paused = true; document.exitPointerLock?.(); });
  ui.addEventListener('chatClosed', () => { game.paused = false; game.input.requestLock(); });
  ui.addEventListener('chatCommand', (e) => runCommand(e.detail));
  document.addEventListener('mousemove', (e) => { if (ui.invOpen) ui.updateCursorFollow(e); });

  game.onGameOver = () => {
    ui.flashDamage();
    ui.addChatLine('You died! Respawning...', 'error');
    setTimeout(() => { game.respawn(spawnPoint); }, 800);
  };
  game.onPlayerHurt = () => ui.flashDamage();
  game.onThunder = () => ui.flashThunder();
  game.onBreakProgress = (p) => ui.setBreakProgress(p);
  game.onBlockBroken = (drop) => {
    if (drop && drop !== 'none') {
      const left = inv.give(dropName(drop), 1);
      if (left > 0) ui.toast('Inventory full!');
    }
  };
  ui.setHealth(game.player.health);
  ui.setHunger(game.player.hunger);
}

// map drops like 'cobblestone' directly; ores drop raw items names
function dropName(drop) {
  const map = { coal_ore: 'coal', iron_ore: 'iron_ingot', gold_ore: 'gold_ingot', diamond_ore: 'diamond', redstone_ore: 'redstone' };
  return map[drop] || drop;
}

function runCommand(raw) {
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const p = game.player;
  switch (cmd) {
    case '/gamemode': case '/gm': {
      const m = parts[1];
      if (m === 'creative' || m === 'c' || m === '1') { p.gamemode = 'creative'; p.flying = true; ui.addChatLine('Gamemode: creative'); }
      else if (m === 'survival' || m === 's' || m === '0') { p.gamemode = 'survival'; p.flying = false; ui.addChatLine('Gamemode: survival'); }
      else ui.addChatLine('Usage: /gamemode creative|survival', 'error');
      break;
    }
    case '/tp': case '/teleport': {
      const [x, y, z] = parts.slice(1, 4).map(Number);
      if ([x, y, z].every(v => isFinite(v))) { p.pos.set(x, y, z); p.vel.set(0,0,0); ui.addChatLine(`Teleported to ${x} ${y} ${z}`); }
      else ui.addChatLine('Usage: /tp <x> <y> <z>', 'error');
      break;
    }
    case '/time': {
      if (parts[1] === 'day') { game.timeOfDay = 0.32; ui.addChatLine('Time set to day'); }
      else if (parts[1] === 'night') { game.timeOfDay = 0.8; ui.addChatLine('Time set to night'); }
      else ui.addChatLine('Usage: /time day|night', 'error');
      break;
    }
    case '/give': {
      const item = parts[1], count = parseInt(parts[2] || '1', 10);
      if (item && registry.byNameGet(item)) { inv.give(item, count); ui.addChatLine(`Gave ${count} ${item}`); }
      else ui.addChatLine('Usage: /give <item> [count]', 'error');
      break;
    }
    case '/seed': ui.addChatLine('Seed: ' + game.seed); break;
    case '/help': ui.addChatLine('/gamemode · /tp x y z · /time day|night · /give item n · /seed · /kill'); break;
    case '/kill': game.hurtPlayer(999); break;
    default: ui.addChatLine('Unknown command. Try /help', 'error');
  }
}

async function doSave() {
  if (!currentWorld || !game) return;
  try {
    const p = game.player;
    await saveEdits(currentWorld.id, game.cm.serializeEdits());
    await savePlayer(currentWorld.id, {
      x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch,
      time: game.timeOfDay, health: p.health,
      inventory: { hotbar: inv.hotbar, main: inv.main, selected: inv.selected },
    });
    await saveWorldMeta({ ...currentWorld, savedAt: Date.now() });
    ui.toast('World saved ✓');
  } catch (e) { console.error('save failed', e); ui.toast('Save failed'); }
}

// ---------------- Per-frame input glue ----------------
let prevWheel = 0;
function onFrame(alpha) {
  const inp = game.input;

  // Hotbar wheel & number keys
  if (inp.wheelDelta !== 0) {
    inv.selectSlot(inv.selected + Math.sign(inp.wheelDelta));
  }
  for (let i = 0; i < 9; i++) if (inp.wasPressed('Digit' + (i + 1))) inv.selectSlot(i);

  // Toggle fly (F) double-tap space in creative handled simply by F
  if (inp.wasPressed('KeyF')) {
    if (game.player.gamemode === 'creative') { game.player.flying = !game.player.flying; ui.toast(game.player.flying ? 'Flight ON' : 'Flight OFF'); }
  }
  if (inp.wasPressed('KeyG') && game.player.gamemode === 'creative') {
    // instant break in creative on click handled below
  }
  if (inp.wasPressed('F3')) ui.toggleDebug();
  if (inp.wasPressed('KeyE')) {
    if (ui.invOpen) ui.closeInventory();
    else {
      // 3x3 crafting if looking at a crafting table within reach
      const hit = game.currentHit;
      let craft3 = false;
      if (hit && registry.get(hit.id)?.name === 'crafting_table' && hit.dist < 4.5) craft3 = true;
      ui.openInventory(game.player.gamemode === 'creative', craft3);
    }
  }
  if (inp.wasPressed('KeyT')) ui.openChat('');
  if (inp.wasPressed('Slash') || (inp.wasPressed('KeyK') && inp.isDown('ShiftLeft'))) ui.openChat('/');
  if (inp.wasPressed('Escape')) {
    if (ui.invOpen) ui.closeInventory();
    else if (!ui.chatOpen) { game.paused = true; ui.showPause(true); document.exitPointerLock?.(); }
  }
  if (inp.wasPressed('KeyQ') && !ui.uiActive) {
    const st = inv.selectedStack();
    if (st) { st.count--; if (st.count <= 0) inv.set(inv.selected, null); ui.toast('Dropped ' + st?.item || ''); }
  }

  // Mouse interactions (only when locked and not paused)
  if (inp.pointerLocked && !game.paused) {
    const p = game.player;
    // Left button: break / attack
    if (inp.mouseJustDown[0]) {
      const hit = game.currentHit;
      if (hit) {
        const b = registry.get(hit.id);
        // attack mobs first if closer than block
        const drop = game.entityMgr.hurtNearest(game.camera.position, 3.5, p.gamemode === 'creative' ? 99 : 3);
        let attackedMob = drop !== null;
        if (!attackedMob && b && isFinite(b.hardness)) {
          game.breaking.active = true;
          game.breaking.x = hit.x; game.breaking.y = hit.y; game.breaking.z = hit.z;
          game.breaking.progress = p.gamemode === 'creative' ? 0.9 : 0;
          game.breaking.targetChanged = false;
        }
      }
    }
    if (inp.mouseJustUp[0]) { game.breaking.active = false; game.breaking.progress = 0; ui.setBreakProgress(0); }
    // re-target breaking if aim moves to another block
    if (game.breaking.active && game.currentHit) {
      const h = game.currentHit;
      if (h.x !== game.breaking.x || h.y !== game.breaking.y || h.z !== game.breaking.z) {
        game.breaking.x = h.x; game.breaking.y = h.y; game.breaking.z = h.z; game.breaking.progress = 0;
      }
    } else if (game.breaking.active && !game.currentHit) {
      game.breaking.targetChanged = true;
    }

    // Right button: place / use
    if (inp.mouseJustDown[2]) {
      const hit = game.currentHit;
      if (hit) {
        const b = registry.get(hit.id);
        if (b?.name === 'crafting_table' && hit.dist < 4.5) { ui.openInventory(p.gamemode === 'creative', true); }
        else {
          const st = inv.selectedStack();
          if (st) {
            const def = registry.byNameGet(st.item);
            if (def && def.id !== undefined && def.id !== BLOCK.air) {
              if (game.placeBlock(hit, st.item)) {
                if (p.gamemode !== 'creative') { st.count--; if (st.count <= 0) inv.set(inv.selected, null); }
              }
            }
          }
        }
      }
    }
  }

  // HUD cheap updates
  ui.setHealth(game.player.health);
  ui.setHunger(game.player.hunger);
  ui.toggleWaterOverlay(game.player.headInWater);

  // Debug screen
  const p = game.player;
  ui.updateDebug(
    `VoxelCraft · FPS ${game.fps.toFixed(0)} (${(performance.now() / 1000).toFixed(0)}s)\n` +
    `XYZ: ${p.pos.x.toFixed(1)} ${p.pos.y.toFixed(1)} ${p.pos.z.toFixed(1)}\n` +
    `Chunk: ${Math.floor(p.pos.x / 16)}, ${Math.floor(p.pos.z / 16)} · Loaded: ${game.cm.chunks.size}\n` +
    `Biome: ${game.cm.sampler.biomeAt(Math.floor(p.pos.x), Math.floor(p.pos.z)) >= 0 ? ['Plains','Forest','Desert','Snowy','Ocean','Hills','Beach'][game.cm.getBiome(Math.floor(p.pos.x), Math.floor(p.pos.z))] : '?'}\n` +
    `Light: sky ${(skyProbe(game, p))} · Time: ${(game.timeOfDay * 24).toFixed(1)}h · ${game.weather.raining ? '🌧 Rain' : '☀ Clear'}\n` +
    `Mobs: ${game.entityMgr.mobs.length} · Seed: ${game.seed}\n` +
    `Facing: ${facingName(p.yaw)} · Mode: ${p.gamemode}${p.flying ? ' (flying)' : ''}`
  );

  // Autosave every 5 minutes
  autosaveTimer += 1 / 60;
  if (autosaveTimer > 300) { autosaveTimer = 0; doSave(); }
}

function skyProbe(game, p) {
  // crude: check blocks above head
  const x = Math.floor(p.pos.x), z = Math.floor(p.pos.z);
  for (let y = Math.floor(p.pos.y) + 1; y < CHUNK_SY; y++) {
    const id = game.cm.getBlock(x, y, z);
    if (id && registry.get(id).opaque) return 0;
  }
  return 15;
}

function facingName(yaw) {
  const a = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
  if (a < 45 || a >= 315) return 'South (+Z)';
  if (a < 135) return 'West (-X)';
  if (a < 225) return 'North (-Z)';
  return 'East (+X)';
}

// expose for entity AI hooks
window.__registry = registry;

// ---------------- Boot ----------------
showMenu();
