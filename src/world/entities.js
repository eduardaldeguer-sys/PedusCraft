// Entities: simple ECS-flavored mob system with InstancedMesh rendering,
// state-machine AI (idle/wander/chase/flee), gravity + AABB-lite collision.
import * as THREE from 'three';
import { registry, CHUNK_SY } from '../world/blocks.js';

const GRAV = -32;

class Mob {
  constructor(type, x, y, z) {
    this.type = type; // 'pig' | 'zombie'
    this.pos = new THREE.Vector3(x, y, z);
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * Math.PI * 2;
    this.state = 'idle';
    this.stateTimer = Math.random() * 4;
    this.health = type === 'zombie' ? 10 : 8;
    this.onGround = false;
    this.hurtFlash = 0;
  }
}

export class EntityManager {
  constructor(scene, chunkManager) {
    this.scene = scene;
    this.cm = chunkManager;
    this.mobs = [];
    this.maxMobs = 64;
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();

    const geo = new THREE.BoxGeometry(0.8, 0.9, 1.2);
    const matPig = new THREE.MeshLambertMaterial({ color: 0xe89a9a });
    const matZom = new THREE.MeshLambertMaterial({ color: 0x4a7a3c });
    this.pigMesh = new THREE.InstancedMesh(geo, matPig, 64);
    this.zomMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 1.7, 0.5), matZom, 64);
    for (const m of [this.pigMesh, this.zomMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      scene.add(m);
    }
    this.spawnTimer = 0;
  }

  trySpawn(playerPos, isNight) {
    if (this.mobs.length >= this.maxMobs) return;
    // attempt a few random spots in a ring around player
    for (let i = 0; i < 6; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = 14 + Math.random() * 26;
      const x = Math.floor(playerPos.x + Math.cos(ang) * d);
      const z = Math.floor(playerPos.z + Math.sin(ang) * d);
      // find surface
      let y = -1;
      const topY = Math.min(CHUNK_SY - 3, Math.max(2, Math.floor(playerPos.y + 8)));
      for (let yy = topY; yy > 1; yy--) {
        const id = this.cm.getBlock(x, yy, z);
        if (id && registry.get(id).solid) { y = yy + 1; break; }
        if (yy < playerPos.y - 24) break;
      }
      if (y < 0) continue;
      const above1 = this.cm.getBlock(x, y, z), above2 = this.cm.getBlock(x, y + 1, z);
      if (above1 || above2) continue;
      const type = isNight && Math.random() < 0.6 ? 'zombie' : 'pig';
      if (type === 'zombie' && isSkyLit(x, y, z, this.cm) > 10) continue; // zombies prefer dark / spawn at night anyway
      this.mobs.push(new Mob(type, x + 0.5, y, z + 0.5));
      return;
    }
  }

  despawnFar(playerPos) {
    this.mobs = this.mobs.filter(m => m.pos.distanceToSquared(playerPos) < 96 * 96);
  }

  /** Fixed-timestep tick. Returns array of zombie attack events (player damage numbers). */
  update(dt, playerPos, playerHurtCb) {
    this.spawnTimer -= dt;
    const isNight = window.__isNight || false;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = isNight ? 1.2 : 3;
      this.trySpawn(playerPos, isNight);
    }
    if (Math.random() < dt * 0.2) this.despawnFar(playerPos);

    for (const m of this.mobs) {
      m.stateTimer -= dt;
      const distToPlayer = m.pos.distanceTo(playerPos);
      // AI transitions
      if (m.type === 'zombie') {
        if (distToPlayer < 16 && m.state !== 'attack') { m.state = 'chase'; }
        else if (distToPlayer > 24 && m.state === 'chase') m.state = 'idle';
        if (m.state === 'chase' && distToPlayer < 1.4) {
          m.state = 'attack';
          if (m.attackCd === undefined || m.attackCd <= 0) {
            playerHurtCb(2 + Math.floor(Math.random() * 3));
            m.attackCd = 1.0;
            window.__audio && window.__audio.play('zombie', { pos: m.pos, cat: 'mobs', vol: 0.6 });
          }
        }
      } else {
        if (distToPlayer < 5 && m.state === 'idle') { m.state = 'flee'; m.stateTimer = 2; }
      }
      if (m.attackCd > 0) m.attackCd -= dt;

      // Movement per state
      let wishX = 0, wishZ = 0;
      const speed = m.type === 'zombie' ? 2.6 : 1.6;
      if (m.state === 'chase' || m.state === 'attack') {
        if (m.state === 'chase') {
          wishX = (playerPos.x - m.pos.x); wishZ = (playerPos.z - m.pos.z);
        }
      } else if (m.state === 'flee') {
        wishX = (m.pos.x - playerPos.x); wishZ = (m.pos.z - playerPos.z);
      } else if (m.state === 'wander') {
        wishX = Math.cos(m.yaw); wishZ = Math.sin(m.yaw);
      } else if (m.stateTimer <= 0) {
        m.state = Math.random() < 0.5 ? 'idle' : 'wander';
        m.yaw = Math.random() * Math.PI * 2;
        m.stateTimer = 2 + Math.random() * 4;
      }
      const wl = Math.hypot(wishX, wishZ);
      if (wl > 0.01) { wishX /= wl; wishZ /= wl; m.yaw = Math.atan2(wishZ, wishX); }

      m.vel.x += (wishX * speed - m.vel.x) * Math.min(1, 10 * dt);
      m.vel.z += (wishZ * speed - m.vel.z) * Math.min(1, 10 * dt);
      m.vel.y += GRAV * dt;

      // collide & move (simple axis stepping)
      this._moveMob(m, dt);

      // jump if blocked ahead
      if (m.onGround) {
        const fx = m.pos.x + Math.cos(m.yaw) * 0.7, fz = m.pos.z + Math.sin(m.yaw) * 0.7;
        if (this._solidAt(fx, m.pos.y + 0.1, fz) && !this._solidAt(fx, m.pos.y + 1.2, fz)) {
          m.vel.y = 7.5;
        }
      }
      if (m.hurtFlash > 0) m.hurtFlash -= dt;
    }
  }

  _solidAt(x, y, z) {
    const id = this.cm.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    return id && registry.get(id).solid;
  }

  _moveMob(m, dt) {
    const hw = 0.4, h = m.type === 'zombie' ? 1.7 : 0.9;
    const step = (axis, amt) => {
      const old = m.pos[axis];
      m.pos[axis] += amt;
      const x0 = Math.floor(m.pos.x - hw), x1 = Math.floor(m.pos.x + hw);
      const z0 = Math.floor(m.pos.z - hw), z1 = Math.floor(m.pos.z + hw);
      const y0 = Math.floor(m.pos.y + 0.05), y1 = Math.floor(m.pos.y + h - 0.05);
      for (let by = y0; by <= y1; by++) for (let bz = z0; bz <= z1; bz++) for (let bx = x0; bx <= x1; bx++) {
        if (by >= 0 && by < CHUNK_SY && this._solidAt(bx, by, bz)) {
          m.pos[axis] = old;
          if (axis === 'y' && amt < 0) m.onGround = true;
          m.vel[axis] = 0;
          return;
        }
      }
    };
    m.onGround = false;
    step('x', m.vel.x * dt);
    step('z', m.vel.z * dt);
    const dy = Math.max(-1, Math.min(1, m.vel.y * dt));
    step('y', dy);
    if (m.pos.y < 0) { m.pos.y = 5; m.vel.y = 0; }
  }

  hurtNearest(playerPos, reach, dmg) {
    let best = null, bd = reach * reach;
    for (const m of this.mobs) {
      const d = m.pos.distanceToSquared(playerPos);
      if (d < bd) { bd = d; best = m; }
    }
    if (best) {
      best.health -= dmg;
      best.hurtFlash = 0.3;
      best.state = 'flee'; best.stateTimer = 3;
      // knockback
      const dx = best.pos.x - playerPos.x, dz = best.pos.z - playerPos.z;
      const l = Math.hypot(dx, dz) || 1;
      best.vel.x += dx / l * 6; best.vel.z += dz / l * 6; best.vel.y = 5;
      if (best.health <= 0) {
        this.mobs.splice(this.mobs.indexOf(best), 1);
        window.__audio && window.__audio.play('pig', { pos: best.pos, cat: 'mobs', rate: 0.7 });
        return best.type === 'zombie' ? 'rotten_flesh' : 'porkchop';
      }
      return '';
    }
    return null;
  }

  syncInstances(cameraPos) {
    let pi = 0, zi = 0;
    const d = this._dummy;
    for (const m of this.mobs) {
      const isPig = m.type === 'pig';
      const mesh = isPig ? this.pigMesh : this.zomMesh;
      const idx = isPig ? pi++ : zi++;
      if (idx >= 64) continue;
      d.position.set(m.pos.x, m.pos.y + (isPig ? 0.45 : 0.85), m.pos.z);
      d.rotation.set(0, -m.yaw + Math.PI / 2, 0);
      const bob = Math.sin(performance.now() * 0.006 + m.pos.x) * (Math.hypot(m.vel.x, m.vel.z) > 0.5 ? 0.06 : 0);
      d.position.y += bob;
      d.scale.setScalar(m.hurtFlash > 0 ? 1.15 : 1);
      d.updateMatrix();
      mesh.setMatrixAt(idx, d.matrix);
      if (mesh.setColorAt) {
        this._color.setHex(m.hurtFlash > 0 ? 0xff5555 : (isPig ? 0xffffff : 0xffffff));
        mesh.setColorAt(idx, this._color);
      }
    }
    this.pigMesh.count = pi;
    this.zomMesh.count = zi;
    this.pigMesh.instanceMatrix.needsUpdate = true;
    this.zomMesh.instanceMatrix.needsUpdate = true;
    if (this.pigMesh.instanceColor) this.pigMesh.instanceColor.needsUpdate = true;
    if (this.zomMesh.instanceColor) this.zomMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.pigMesh, this.zomMesh);
    this.pigMesh.geometry.dispose(); this.zomMesh.geometry.dispose();
    this.pigMesh.material.dispose(); this.zomMesh.material.dispose();
  }
}

function isSkyLit(x, y, z, cm) {
  // crude skylight probe: count air above
  for (let yy = y + 1; yy < CHUNK_SY; yy++) {
    const id = cm.getBlock(x, yy, z);
    if (id && registry.get(id).opaque) return 0;
  }
  return 15;
}
