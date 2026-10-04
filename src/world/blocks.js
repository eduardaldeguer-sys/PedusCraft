// Block Registry — shared by main thread and Web Workers.
// IDs are stable Uint16 values. Atlas tiles referenced by `tiles` indices.

export const CHUNK_SX = 16, CHUNK_SY = 128, CHUNK_SZ = 16;

// Tile indices into the texture atlas (atlas is a grid of TILE px tiles)
export const T = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, COBBLE: 4, SAND: 5,
  LOG_SIDE: 6, LOG_TOP: 7, LEAVES: 8, PLANKS: 9, WATER: 10, BEDROCK: 11,
  GRAVEL: 12, COAL_ORE: 13, IRON_ORE: 14, GOLD_ORE: 15, DIAMOND_ORE: 16,
  SNOW: 17, ICE: 18, BRICK: 19, GLASS: 20, OBSIDIAN: 21, GLOWSTONE: 22,
  CRAFT_TOP: 23, CRAFT_SIDE: 24, TNT: 25, PUMPKIN: 26, REDSTONE_ORE: 27,
  DEADBUSH: 28, CACTUS: 29, MUD: 30, BARK: 31,
};

// Block definition fields:
// id, name, display, solid, opaque(occludes faces & light), liquid, grassPave,
// hardness(sec), light(0-15), opacity(0-15), tiles{+y,-y,side} or tiles all
export class BlockRegistry {
  constructor() {
    this.byId = [];
    this.byName = new Map();
  }
  register(def) {
    const b = {
      id: def.id, name: def.name, display: def.display || def.name,
      solid: def.solid !== false,
      opaque: def.opaque !== false && !def.liquid && !def.cross,
      liquid: !!def.liquid,
      cross: !!def.cross,
      grassPave: !!def.grassPave,
      hardness: def.hardness ?? 1,
      light: def.light ?? 0,
      opacity: def.opaque === false ? 0 : 15,
      tiles: def.tiles, // [top, bottom, side] tile indices
      color: def.color ?? null, // tint multiplier [r,g,b] 0..1
      drop: def.drop ?? def.name,
      tool: def.tool ?? null,
      category: def.category || 'block',
    };
    this.byId[b.id] = b;
    this.byName.set(b.name, b);
    return b;
  }
  get(id) { return this.byId[id]; }
  byNameGet(name) { return this.byName.get(name) || this.byId[0]; }
}

export const registry = new BlockRegistry();

let _nextId = 0;
function reg(o) { o.id = _nextId++; registry.register(o); return o.id; }

export const BLOCK = {};
function def(name, opts) { BLOCK[name] = reg({ name, ...opts }); }

def('air', { solid: false, opaque: false, hardness: 0, tiles: [0,0,0] });
def('stone', { hardness: 1.5, tiles: [T.STONE, T.STONE, T.STONE], drop: 'cobblestone', tool: 'pickaxe' });
def('grass', { display: 'Grass Block', hardness: 0.6, tiles: [T.GRASS_TOP, T.DIRT, T.GRASS_SIDE], drop: 'dirt', grassPave: true });
def('dirt', { hardness: 0.5, tiles: [T.DIRT, T.DIRT, T.DIRT] });
def('cobblestone', { hardness: 2, tiles: [T.COBBLE, T.COBBLE, T.COBBLE], tool: 'pickaxe' });
def('bedrock', { hardness: Infinity, tiles: [T.BEDROCK, T.BEDROCK, T.BEDROCK] });
def('sand', { hardness: 0.5, tiles: [T.SAND, T.SAND, T.SAND] });
def('gravel', { hardness: 0.6, tiles: [T.GRAVEL, T.GRAVEL, T.GRAVEL] });
def('oak_log', { display: 'Oak Log', hardness: 2, tiles: [T.LOG_TOP, T.LOG_TOP, T.LOG_SIDE], tool: 'axe' });
def('oak_leaves', { display: 'Oak Leaves', hardness: 0.2, opaque: false, tiles: [T.LEAVES, T.LEAVES, T.LEAVES] });
def('oak_planks', { display: 'Oak Planks', hardness: 2, tiles: [T.PLANKS, T.PLANKS, T.PLANKS], tool: 'axe' });
def('water', { liquid: true, solid: false, opaque: false, hardness: Infinity, tiles: [T.WATER, T.WATER, T.WATER] });
def('coal_ore', { hardness: 3, tiles: [T.COAL_ORE, T.COAL_ORE, T.COAL_ORE], tool: 'pickaxe' });
def('iron_ore', { hardness: 3, tiles: [T.IRON_ORE, T.IRON_ORE, T.IRON_ORE], tool: 'pickaxe' });
def('gold_ore', { hardness: 3, tiles: [T.GOLD_ORE, T.GOLD_ORE, T.GOLD_ORE], tool: 'pickaxe' });
def('diamond_ore', { hardness: 3, tiles: [T.DIAMOND_ORE, T.DIAMOND_ORE, T.DIAMOND_ORE], tool: 'pickaxe' });
def('redstone_ore', { hardness: 3, light: 7, tiles: [T.REDSTONE_ORE, T.REDSTONE_ORE, T.REDSTONE_ORE], tool: 'pickaxe' });
def('snow_block', { display: 'Snow Block', hardness: 0.4, tiles: [T.SNOW, T.SNOW, T.SNOW] });
def('ice', { hardness: 0.5, opaque: false, tiles: [T.ICE, T.ICE, T.ICE], tool: 'pickaxe' });
def('brick_block', { display: 'Bricks', hardness: 2, tiles: [T.BRICK, T.BRICK, T.BRICK], tool: 'pickaxe' });
def('glass', { hardness: 0.3, opaque: false, tiles: [T.GLASS, T.GLASS, T.GLASS] });
def('obsidian', { hardness: 10, tiles: [T.OBSIDIAN, T.OBSIDIAN, T.OBSIDIAN], tool: 'pickaxe' });
def('glowstone', { hardness: 0.3, light: 15, tiles: [T.GLOWSTONE, T.GLOWSTONE, T.GLOWSTONE] });
def('crafting_table', { display: 'Crafting Table', hardness: 2.5, tiles: [T.CRAFT_TOP, T.PLANKS, T.CRAFT_SIDE], tool: 'axe' });
def('tnt', { hardness: 0.5, tiles: [T.TNT, T.PLANKS, T.TNT] });
def('pumpkin', { hardness: 1, tiles: [T.PUMPKIN, T.PUMPKIN, T.PUMPKIN] });
def('dead_bush', { display: 'Dead Bush', solid: false, opaque: false, cross: true, hardness: 0.1, tiles: [T.DEADBUSH, T.DEADBUSH, T.DEADBUSH] });
def('cactus', { hardness: 0.4, tiles: [T.CACTUS, T.CACTUS, T.CACTUS] });
def('mud', { hardness: 0.5, tiles: [T.MUD, T.MUD, T.MUD] });
def('spruce_log', { display: 'Spruce Log', hardness: 2, tiles: [T.LOG_TOP, T.LOG_TOP, T.BARK], tool: 'axe' });
def('spruce_leaves', { display: 'Spruce Leaves', hardness: 0.2, opaque: false, color: [0.4, 0.7, 0.45], tiles: [T.LEAVES, T.LEAVES, T.LEAVES] });

export const AIR = BLOCK.air;
export const MAX_BLOCK_ID = _nextId;

// Biome tint table for grass/leaves top/side colors per biome id
export const BIOME_TINT = [
  [0.47, 0.78, 0.35], // plains
  [0.35, 0.65, 0.30], // forest
  [0.90, 0.88, 0.60], // desert (sandy green-ish, mostly unused)
  [0.75, 0.85, 0.95], // snowy
  [0.40, 0.62, 0.35], // ocean/floor
  [0.55, 0.72, 0.40], // hills
  [0.50, 0.68, 0.42], // savanna-ish / beach variant
];
