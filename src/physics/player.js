// Player physics: AABB collision, gravity, jump/sneak/sprint/swim/fly, auto-step.
import { CHUNK_SY, registry } from '../world/blocks.js';
import * as THREE from 'three';

const PLAYER_W = 0.6, PLAYER_H = 1.8, EYE = 1.62;
const GRAVITY = -32;          // blocks/s^2 (MC-like)
const JUMP_VEL = 8.6;         // ~1.25 block jump
const TERMINAL = -78;

export class Player {
  constructor(chunkManager) {
    this.cm = chunkManager;
    this.pos = new THREE.Vector3(0, 80, 0);   // feet position
    this.vel = new THREE.Vector3(0, 0, 0);
    this.prevPos = new THREE.Vector3().copy(this.pos);
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.inWater = false; this.headInWater = false;
    this.flying = false; this.sprinting = false; this.sneaking = false;
    this.gamemode = 'survival'; // 'creative' too
    this.health = 20; this.hunger = 20;
    this.fallStart = this.pos.y;
    this.stepSoundTimer = 0;
    this.spawnProtectY = null;
  }

  get aabb() {
    const hw = PLAYER_W / 2;
    return { x0: this.pos.x - hw, x1: this.pos.x + hw, y0: this.pos.y, y1: this.pos.y + PLAYER_H, z0: this.pos.z - hw, z1: this.pos.z + hw };
  }

  blockAt(wx, wy, wz) { return this.cm.getBlock(Math.floor(wx), Math.floor(wy), Math.floor(wz)); }

  // Sweep-AABB per-axis move with auto-step
  update(dt, wishDir /*{x,z} normalized-ish*/, wantJump) {
    this.prevPos.copy(this.pos);
    const reg = registry;
    const solidId = (id) => { const b = reg.get(id); return b && b.solid; };
    const liquidId = (id) => { const b = reg.get(id); return b && b.liquid; };

    // Water checks
    const feetBlock = this.blockAt(this.pos.x, this.pos.y + 0.2, this.pos.z);
    const midBlock = this.blockAt(this.pos.x, this.pos.y + 0.9, this.pos.z);
    const headBlock = this.blockAt(this.pos.x, this.pos.y + EYE, this.pos.z);
    this.inWater = liquidId(feetBlock) || liquidId(midBlock);
    this.headInWater = liquidId(headBlock);

    const sprintMul = this.sprinting && !this.sneaking ? 1.6 : 1;
    let speed;
    if (this.flying) speed = (this.sprinting ? 34 : 16);
    else if (this.inWater) speed = 4.4;
    else speed = (this.sneaking ? 2.0 : 4.317) * sprintMul;

    // Horizontal acceleration toward wish direction
    const accel = this.onGround ? 60 : (this.inWater ? 20 : 12);
    this.vel.x += (wishDir.x * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wishDir.z * speed - this.vel.z) * Math.min(1, accel * dt);

    // Vertical
    if (this.flying) {
      let vy = 0;
      if (wantJump) vy += speed;
      if (this.sneaking) vy -= speed;
      this.vel.y += (vy - this.vel.y) * Math.min(1, 20 * dt);
    } else if (this.inWater) {
      this.vel.y += GRAVITY * 0.35 * dt;
      if (wantJump) this.vel.y = 4.2;
      this.vel.y = Math.max(this.vel.y, -4);
      // water drag horizontal
      this.vel.x *= (1 - Math.min(1, 2.5 * dt));
      this.vel.z *= (1 - Math.min(1, 2.5 * dt));
    } else {
      this.vel.y += GRAVITY * dt;
      if (wantJump && this.onGround) {
        this.vel.y = JUMP_VEL;
        this.onGround = false;
      }
      if (this.vel.y < TERMINAL) this.vel.y = TERMINAL;
    }

    // Move & collide per axis
    this._moveAxis('x', this.vel.x * dt, solidId);
    this._moveAxis('z', this.vel.z * dt, solidId);
    const wasGround = this.onGround;
    this._moveAxisY(this.vel.y * dt, solidId);

    // Fall damage bookkeeping
    if (!this.flying && !this.inWater) {
      if (!wasGround && this.onGround) {
        const fallDist = this.fallStart - this.pos.y;
        if (fallDist > 3 && this.gamemode === 'survival') {
          const dmg = Math.floor(fallDist - 3);
          this.health = Math.max(0, this.health - dmg);
        }
        this.fallDamageEvent = fallDist > 0.5 ? fallDist : 0;
      }
      if (this.onGround) this.fallStart = this.pos.y;
      else if (this.vel.y > 0) this.fallStart = Math.max(this.fallStart, this.pos.y);
    } else {
      this.fallStart = this.pos.y;
    }

    // Void safety
    if (this.pos.y < -10 && this.spawnPoint) { this.pos.copy(this.spawnPoint); this.pos.y += 2; this.vel.set(0,0,0); }
  }

  _collides(solidId, px, py, pz) {
    const hw = PLAYER_W / 2, h = PLAYER_H;
    const x0 = Math.floor(px - hw + 1e-4), x1 = Math.floor(px + hw - 1e-4);
    const y0 = Math.floor(py + 1e-4), y1 = Math.floor(py + h - 1e-4);
    const z0 = Math.floor(pz - hw + 1e-4), z1 = Math.floor(pz + hw - 1e-4);
    for (let by = y0; by <= y1; by++)
      for (let bz = z0; bz <= z1; bz++)
        for (let bx = x0; bx <= x1; bx++)
          if (by >= 0 && by < CHUNK_SY && solidId(this.cm.getBlock(bx, by, bz))) return true;
    return false;
  }

  _moveAxis(axis, amount, solidId) {
    if (amount === 0) return;
    const stepSign = Math.sign(amount);
    const absStep = Math.abs(amount);
    let moved = 0;
    while (moved < absStep) {
      const inc = Math.min(0.25, absStep - moved);
      const nx = this.pos.x + (axis === 'x' ? stepSign * inc : 0);
      const nz = this.pos.z + (axis === 'z' ? stepSign * inc : 0);
      if (!this._collides(solidId, nx, this.pos.y, nz)) {
        if (axis === 'x') this.pos.x = nx; else this.pos.z = nz;
        moved += inc;
      } else {
        // try auto-step up (only horizontal axes, only when grounded-ish and step <= 0.6)
        if (this.onGround || this.inWater) {
          const upY = this.pos.y + 0.6;
          if (!this._collides(solidId, nx, upY, nz) && !this._collides(solidId, this.pos.x, upY, this.pos.z)) {
            this.pos.y = upY;
            if (axis === 'x') this.pos.x = nx; else this.pos.z = nz;
            moved = absStep; // allow rest of movement at stepped height
            continue;
          }
        }
        this.vel[axis] = 0;
        return;
      }
    }
  }

  _moveAxisY(amount, solidId) {
    if (amount === 0) return;
    const stepSign = Math.sign(amount);
    const absStep = Math.abs(amount);
    let moved = 0;
    this.onGround = false;
    while (moved < absStep) {
      const inc = Math.min(0.25, absStep - moved);
      const ny = this.pos.y + stepSign * inc;
      if (!this._collides(solidId, this.pos.x, ny, this.pos.z)) {
        this.pos.y = ny;
        moved += inc;
      } else {
        if (stepSign < 0) this.onGround = true;
        this.vel.y = 0;
        return;
      }
    }
    // ground check when moving up slightly? standard: probe below
    if (!this.onGround && this.vel.y <= 0) {
      if (this._collides(solidId, this.pos.x, this.pos.y - 0.02, this.pos.z)) this.onGround = true;
    }
  }

  respawn(spawn) {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.health = 20;
    this.fallStart = spawn.y;
  }
}

export { PLAYER_W, PLAYER_H, EYE };
