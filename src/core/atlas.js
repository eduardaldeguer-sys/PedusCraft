// Procedural 16x16 pixel-art texture atlas generator.
// Runs on the main thread; produces a canvas + per-tile UV data.
import { T } from '../world/blocks.js';

export const TILE = 16;          // px per tile
export const ATLAS_COLS = 8;     // 8 columns x 4 rows = 128x64 px atlas
export const ATLAS_ROWS = 4;
export const ATLAS_PX_W = TILE * ATLAS_COLS;  // 128
export const ATLAS_PX_H = TILE * ATLAS_ROWS;  // 64

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Base noise-ish hash for pixel variation
function h2(x, y, s) {
  let n = x * 374761393 + y * 668265263 + s * 1274126177;
  n = (n ^ (n >> 13)) * 1103515245;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}

/**
 * Build the atlas canvas. Each tile is drawn into its slot.
 * Tile layout index = T.* constants; col = idx % ATLAS_COLS, row = floor(idx / ATLAS_COLS)
 */
export function buildAtlasCanvas() {
  const c = document.createElement('canvas');
  c.width = ATLAS_PX_W; c.height = ATLAS_PX_H;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ATLAS_PX_W, ATLAS_PX_H);
  const S = TILE;

  function tile(idx, painter) {
    const col = (idx % ATLAS_COLS) * S;
    const row = Math.floor(idx / ATLAS_COLS) * S;
    const img = ctx.createImageData(S, S);
    const put = (x, y, r, g, b, a = 255) => {
      if (x < 0 || y < 0 || x >= S || y >= S) return;
      const i = (y * S + x) * 4;
      img.data[i] = r; img.data[i+1] = g; img.data[i+2] = b; img.data[i+3] = a;
    };
    painter(put, idx);
    ctx.putImageData(img, col, row);
  }

  const vary = (base, amt, seed) => (x, y) => {
    const v = (h2(x, y, seed) - 0.5) * 2 * amt;
    return [
      Math.max(0, Math.min(255, base[0] + v)),
      Math.max(0, Math.min(255, base[1] + v)),
      Math.max(0, Math.min(255, base[2] + v)),
    ];
  };

  function noisyTile(idx, base, amt, seed) {
    const f = vary(base, amt, seed);
    tile(idx, (put) => {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const [r,g,b] = f(x,y); put(x,y,r,g,b);
      }
    });
  }

  // --- Solid simple tiles ---
  noisyTile(T.STONE, [128,128,128], 18, 3);
  noisyTile(T.DIRT, [134,96,67], 16, 7);
  noisyTile(T.SAND, [219,211,160], 12, 11);
  noisyTile(T.GRAVEL, [130,126,122], 22, 13);
  noisyTile(T.BEDROCK, [85,85,85], 30, 17);
  noisyTile(T.SNOW, [245,245,250], 6, 19);
  noisyTile(T.MUD, [110,90,75], 14, 31);

  // Grass top (green with blade speckles)
  tile(T.GRASS_TOP, (put) => {
    const f = vary([106,170,64], 18, 23);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let [r,g,b] = f(x,y);
      if (h2(x, y*3, 5) > 0.93) { r -= 18; g += 12; b -= 10; }
      put(x,y,r,g,b);
    }
  });

  // Grass side: dirt with grass fringe on top
  tile(T.GRASS_SIDE, (put) => {
    const fd = vary([134,96,67], 16, 7);
    const fg = vary([106,170,64], 18, 23);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fringe = 3 + Math.floor(h2(x, 0, 41) * 3);
      let [r,g,b] = y < fringe ? fg(x,y) : fd(x,y);
      if (y === fringe) { r = (r+fd(x,y)[0])/2; g = (g+fd(x,y)[1])/2; b=(b+fd(x,y)[2])/2; }
      put(x,y,r,g,b);
    }
  });

  // Cobblestone: chunky circles
  tile(T.COBBLE, (put) => {
    const r = rng(101);
    const stones = [];
    for (let i = 0; i < 9; i++) stones.push({ x: r()*S, y: r()*S, rad: 2.5 + r()*3, tone: 100 + r()*60 });
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let best = null, bd = 1e9;
      for (const s of stones) {
        let dx = x - s.x, dy = y - s.y;
        dx -= S * Math.round(dx / S); dy -= S * Math.round(dy / S);
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = s; }
      }
      let v = best.tone;
      if (bd > best.rad - 0.8) v = 60 + h2(x,y,9)*20; // mortar
      v += (h2(x, y, 77) - 0.5) * 14;
      put(x,y,v,v,v);
    }
  });

  // Log side: vertical bark streaks
  tile(T.LOG_SIDE, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const stripe = Math.sin(x * 1.7 + h2(x,0,3)*2) * 0.5 + 0.5;
      let r = 110 + stripe * 40 + (h2(x,y,21)-0.5)*16;
      let g = 80 + stripe * 28 + (h2(x,y,21)-0.5)*12;
      let b = 48 + stripe * 14;
      if (h2(x, y*2, 8) > 0.96) { r -= 30; g -= 25; b -= 15; } // knots
      put(x,y,r,g,b);
    }
  });
  // Bark (spruce, darker)
  tile(T.BARK, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const stripe = Math.sin(x * 2.3 + h2(x,0,5)) * 0.5 + 0.5;
      put(x,y, 70 + stripe*30 + (h2(x,y,9)-0.5)*12, 50 + stripe*20, 32 + stripe*10);
    }
  });
  // Log top: rings
  tile(T.LOG_TOP, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const d = Math.hypot(x-7.5, y-7.5);
      const ring = Math.sin(d * 2.2) * 0.5 + 0.5;
      let r = 150 + ring*40 + (h2(x,y,4)-0.5)*10, g = 118 + ring*30, b = 70 + ring*18;
      if (d > 7) { r = 105; g = 78; b = 46; } // outer bark rim
      put(x,y,r,g,b);
    }
  });

  // Leaves: green with holes
  tile(T.LEAVES, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = h2(x, y, 55);
      if (n > 0.88) { put(x,y,0,0,0,0); continue; }
      const shade = 90 + n * 90;
      put(x,y, shade*0.45, shade, shade*0.4, 255);
    }
  });

  // Planks: horizontal boards
  tile(T.PLANKS, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const board = Math.floor(y / 4);
      const seam = (y % 4 === 0) ? -35 : 0;
      const vs = Math.sin((x + board * 5) * 1.3 + board) * 8;
      put(x,y, 172 + seam + vs + (h2(x,y,board+2)-0.5)*10, 132 + seam*0.8 + vs*0.8, 82 + seam*0.5 + vs*0.5);
    }
  });

  // Water: translucent blue waves
  tile(T.WATER, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const w = Math.sin(x * 0.9 + y * 0.5) * 0.5 + 0.5;
      put(x,y, 40 + w*20, 90 + w*30, 200 + w*40, 170);
    }
  });

  // Ores: stone base + colored blobs
  function oreTile(idx, blobColor, seed) {
    tile(idx, (put) => {
      const f = vary([128,128,128], 18, 3);
      const blobs = [];
      const r = rng(seed);
      for (let i = 0; i < 4; i++) blobs.push({ x: 2 + r()*12, y: 2 + r()*12 });
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let [rr,gg,bb] = f(x,y);
        for (const bl of blobs) {
          const d = Math.hypot(x-bl.x, y-bl.y);
          if (d < 2.2) { rr = blobColor[0] + (2.2-d)*10; gg = blobColor[1]; bb = blobColor[2]; }
          else if (d < 2.8) { rr = blobColor[0]*0.7; gg = blobColor[1]*0.7; bb = blobColor[2]*0.7; }
        }
        put(x,y,rr,gg,bb);
      }
    });
  }
  oreTile(T.COAL_ORE, [30,30,30], 211);
  oreTile(T.IRON_ORE, [200,160,120], 307);
  oreTile(T.GOLD_ORE, [240,210,80], 419);
  oreTile(T.DIAMOND_ORE, [110,230,235], 523);
  oreTile(T.REDSTONE_ORE, [220,40,40], 631);

  // Snow handled above; Ice: pale blue translucent-ish opaque tile
  tile(T.ICE, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const cr = h2(Math.floor(x/3), Math.floor(y/4), 12) > 0.7 ? 14 : 0;
      put(x,y, 150+cr+(h2(x,y,6)-0.5)*10, 190+cr, 240);
    }
  });

  // Bricks
  tile(T.BRICK, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const row = Math.floor(y / 4);
      const off = (row % 2) * 4;
      const mortarY = y % 4 === 0, mortarX = ((x + off) % 8) === 0;
      if (mortarY || mortarX) put(x,y, 188, 180, 172);
      else put(x,y, 150 + (h2(x,y,33)-0.5)*18, 74 + (h2(x,y,34)-0.5)*10, 60);
    }
  });

  // Glass: mostly transparent with frame
  tile(T.GLASS, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const edge = x === 0 || y === 0 || x === S-1 || y === S-1;
      const shine = (x + y) % 7 === 0 && !edge;
      if (edge) put(x,y, 210, 230, 240, 220);
      else if (shine) put(x,y, 255, 255, 255, 90);
      else put(x,y, 200, 225, 240, 40);
    }
  });

  // Obsidian: dark purple swirls
  tile(T.OBSIDIAN, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = h2(x, y, 88);
      const swirl = Math.sin(x*0.8 + y*0.6 + n*3) * 0.5 + 0.5;
      put(x,y, 22 + swirl*22, 14 + swirl*12, 34 + swirl*30);
    }
  });

  // Glowstone: warm speckled
  tile(T.GLOWSTONE, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = h2(x, y, 99);
      const bright = n > 0.75;
      put(x,y, bright? 255 : 190 + n*40, bright? 220 : 150 + n*30, bright? 130 : 70);
    }
  });

  // Crafting table top: planks + grid lines
  tile(T.CRAFT_TOP, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const grid = (x === 5 || x === 10 || y === 5 || y === 10);
      let r = 172, g = 132, b = 82;
      if (grid) { r = 90; g = 66; b = 40; }
      if (x===0||y===0||x===15||y===15) { r-=30; g-=25; b-=15; }
      put(x,y, r+(h2(x,y,44)-0.5)*10, g+(h2(x,y,45)-0.5)*8, b);
    }
  });
  // Crafting side: planks + tool marks
  tile(T.CRAFT_SIDE, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      let r = 160, g = 122, b = 76;
      if (y > 3 && y < 9 && ((x===3&&y%2===0)||(x===12&&y%2===1))) { r=90;g=70;b=45; }
      if (y % 4 === 0) { r-=30;g-=25;b-=15; }
      put(x,y,r,g,b);
    }
  });

  // TNT: red body with fuse band + "TNT" pixels
  tile(T.TNT, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (y >= 4 && y <= 11) {
        // white band with red letters
        const letter = ((x+y) % 5 === 0 && x > 2 && x < 13);
        put(x,y, letter? 200:240, letter? 30:240, letter? 30:240);
      } else put(x,y, 190 + (h2(x,y,66)-0.5)*20, 60, 50);
    }
  });

  // Pumpkin: orange ridged
  tile(T.PUMPKIN, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const ridge = Math.abs(Math.sin(x * 0.9)) ;
      put(x,y, 200 + ridge*30, 110 + ridge*25, 30 + ridge*8);
    }
  });

  // Dead bush: brown cross-branches on transparency
  tile(T.DEADBUSH, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) put(x,y,0,0,0,0);
    const pts = [[8,15],[8,12],[7,10],[9,10],[6,8],[10,8],[5,6],[8,7],[11,5],[9,4],[12,3],[4,4]];
    for (const [x,y] of pts) { put(x,y,140,100,50); put(Math.min(15,x+1),y,120,85,42); }
  });

  // Cactus: green with spines
  tile(T.CACTUS, (put) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const edge = x < 2 || x > 13;
      let r = 40, g = 140, b = 50;
      if (edge) { r=30; g=110; b=38; }
      if ((x*y) % 23 === 0) { r=200;g=210;b=120; }
      put(x,y,r,g,b);
    }
  });

  return c;
}

// UV helper: tile index -> {u0,v0,u1,v1} with tiny inset to prevent bleeding.
// v measured from TOP of image (canvas space). Shader flips as needed.
export function tileUV(idx, inset = 0.5 / ATLAS_PX_W) {
  const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS);
  const su = TILE / ATLAS_PX_W, sv = TILE / ATLAS_PX_H;
  return {
    u0: col * su + inset, u1: (col + 1) * su - inset,
    v0: row * sv + inset, v1: (row + 1) * sv - inset, // top..bottom in canvas coords
  };
}

// Item icon painters for the inventory UI (drawn onto small canvases)
export function drawItemIcon(canvas, itemName, atlasCanvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  const tileOf = ITEM_TILE[itemName];
  if (tileOf === undefined) return;
  const idx = tileOf;
  const col = (idx % ATLAS_COLS) * TILE, row = Math.floor(idx / ATLAS_COLS) * TILE;
  if (TOOL_KIND[itemName]) {
    drawToolIcon(ctx, TOOL_KIND[itemName], W, H);
    return;
  }
  // Draw an isometric-ish cube: top + two sides from atlas tiles
  const sideIdx = ITEM_SIDE[itemName] ?? idx;
  const sTop = TILE, half = W / 2, th = H / 4;
  // top face (diamond)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(half, 2); ctx.lineTo(W - 2, th + 2); ctx.lineTo(half, 2 * th + 2); ctx.lineTo(2, th + 2);
  ctx.closePath(); ctx.clip();
  ctx.drawImage(atlasCanvas, col, row, sTop, sTop, 2, 2, W - 4, 2 * th);
  ctx.restore();
  // left face
  const scol = (sideIdx % ATLAS_COLS) * TILE, srow = Math.floor(sideIdx / ATLAS_COLS) * TILE;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(2, th + 2); ctx.lineTo(half, 2 * th + 2); ctx.lineTo(half, H - 2); ctx.lineTo(2, H - th);
  ctx.closePath(); ctx.clip();
  ctx.drawImage(atlasCanvas, scol, srow, TILE, TILE, 2, th, half - 2, H - th - 2);
  ctx.restore();
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.moveTo(2, th + 2); ctx.lineTo(half, 2 * th + 2); ctx.lineTo(half, H - 2); ctx.lineTo(2, H - th);
  ctx.closePath(); ctx.fill();
  // right face
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(W - 2, th + 2); ctx.lineTo(half, 2 * th + 2); ctx.lineTo(half, H - 2); ctx.lineTo(W - 2, H - th);
  ctx.closePath(); ctx.clip();
  ctx.drawImage(atlasCanvas, scol, srow, TILE, TILE, half, th, W - half - 2, H - th - 2);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}

import { BLOCK, registry } from '../world/blocks.js';
const ITEM_TILE = {
  dirt: 2, grass_block: 1, stone: 3, cobblestone: 4, sand: 5, gravel: 12,
  oak_log: 6, oak_planks: 9, oak_leaves: 8, spruce_log: 31, spruce_leaves: 8,
  glass: 20, brick_block: 19, glowstone: 22, obsidian: 21, tnt: 25, pumpkin: 26,
  ice: 18, snow_block: 17, mud: 30, cactus: 29, crafting_table: 24, bedrock: 11,
  coal: 13, iron_ingot: 14, gold_ingot: 15, diamond: 16, redstone: 27, stick: 9, water_bucket: 10, dead_bush: 28,
};
const ITEM_SIDE = {
  grass_block: 1, oak_log: 6, spruce_log: 31, crafting_table: 24, tnt: 25,
};
const TOOL_KIND = { pickaxe: 'pickaxe', axe: 'axe', shovel: 'shovel', sword: 'sword' };

function drawToolIcon(ctx, kind, W, H) {
  // pixel-art tool: wooden handle + colored head
  const px = W / 16;
  const P = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x * px, y * px, px + 0.5, px + 0.5); };
  const wood = '#8a5a2b', dark = '#5c3d1c';
  const head = kind === 'sword' ? '#c8c8c8' : '#9aa0a6';
  // handle diagonal
  for (let i = 0; i < 8; i++) { P(4 + i, 12 - i, i % 2 ? wood : dark); }
  if (kind === 'pickaxe') {
    for (let i = 0; i < 6; i++) { P(5 + i, 3 + (i > 2 ? 1 : 0), head); }
    P(5, 4, head); P(10, 4, head);
  } else if (kind === 'axe') {
    P(9, 2, head); P(10, 2, head); P(9, 3, head); P(10, 3, head); P(11, 3, head); P(10, 4, head); P(11, 4, head);
  } else if (kind === 'shovel') {
    P(10, 2, head); P(11, 2, head); P(10, 3, head); P(11, 3, head);
  } else if (kind === 'sword') {
    for (let i = 0; i < 7; i++) P(10 - i + 1, 3 + i - 1, head);
    P(4, 9, '#666'); P(5, 8, '#666');
  }
}
