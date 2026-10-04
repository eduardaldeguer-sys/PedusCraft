// Main game: renderer, shaders (custom GLSL), sky/fog/day-night, weather,
// camera/FPS controls, interaction loop, fixed-timestep game loop.
import * as THREE from 'three';
import { CHUNK_SY, registry, BLOCK } from './world/blocks.js';
import { ChunkManager } from './world/chunks.js';
import { buildAtlasCanvas, ATLAS_COLS } from './core/atlas.js';
import { Input } from './core/input.js';
import { Player, EYE } from './physics/player.js';
import { raycastVoxel } from './physics/raycast.js';
import { EntityManager } from './world/entities.js';
import { AudioEngine } from './audio/audio.js';

const TICK = 1 / 20;

export const atlasCanvas = buildAtlasCanvas();

// ---------- Shaders ----------
const VERT = /* glsl */`
  attribute float a_light;
  attribute float a_ao;
  attribute vec3 a_color;
  varying vec2 vUv;
  varying float vLight;
  varying float vAO;
  varying vec3 vColor;
  varying float vFogDepth;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vLight = a_light;
    vAO = a_ao;
    vColor = a_color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mv.z;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D u_atlas;
  uniform float u_daylight;     // 0..1 sun strength
  uniform vec3 u_fogColor;
  uniform float u_fogDensity;
  uniform float u_waterWave;
  uniform float u_alphaTest;
  uniform float u_isWater;
  varying vec2 vUv;
  varying float vLight;
  varying float vAO;
  varying vec3 vColor;
  varying float vFogDepth;
  varying vec3 vWorld;
  void main() {
    vec2 uvv = vUv;
    if (u_isWater > 0.5) {
      uvv.x += sin(vWorld.z * 1.8 + u_waterWave) * 0.006;
      uvv.y += cos(vWorld.x * 1.6 + u_waterWave * 1.3) * 0.006;
    }
    vec4 tex = texture2D(u_atlas, uvv);
    if (tex.a < u_alphaTest) discard;
    float light = clamp(vLight * mix(0.25, 1.0, u_daylight) + vLight * 0.0, 0.0, 1.0);
    // block light already folded into vLight max; add warm tint for strong block light at night
    vec3 warm = mix(vec3(1.0), vec3(1.0, 0.85, 0.6), smoothstep(0.55, 1.0, vLight) * (1.0 - u_daylight));
    vec3 col = tex.rgb * vColor * light * vAO * warm;
    float fogF = 1.0 - exp(-u_fogDensity * u_fogDensity * vFogDepth * vFogDepth);
    col = mix(col, u_fogColor, clamp(fogF, 0.0, 1.0));
    gl_FragColor = vec4(col, tex.a * (u_isWater > 0.5 ? 0.8 : 1.0));
  }
`;

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */`
  precision highp float;
  uniform vec3 u_sunDir;
  uniform float u_daylight;
  uniform float u_rain;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 dayTop = vec3(0.42, 0.62, 0.95);
    vec3 dayHor = vec3(0.75, 0.85, 0.98);
    vec3 nightTop = vec3(0.02, 0.03, 0.09);
    vec3 nightHor = vec3(0.08, 0.09, 0.18);
    vec3 duskHor = vec3(0.95, 0.5, 0.25);
    float dusk = smoothstep(0.0, 0.35, u_daylight) * (1.0 - smoothstep(0.35, 0.75, u_daylight));
    vec3 top = mix(nightTop, dayTop, u_daylight);
    vec3 hor = mix(nightHor, dayHor, u_daylight);
    hor = mix(hor, duskHor, dusk * 0.8);
    top = mix(top, mix(top, duskHor, 0.3), dusk * 0.4);
    top = mix(top, vec3(0.35, 0.37, 0.4), u_rain * 0.6);
    hor = mix(hor, vec3(0.45, 0.47, 0.5), u_rain * 0.6);
    vec3 col = mix(hor, top, pow(h, 0.7));
    // sun & moon discs
    float sun = max(dot(d, u_sunDir), 0.0);
    col += vec3(1.0, 0.9, 0.6) * smoothstep(0.9965, 0.9985, sun) * 2.0 * step(0.05, u_daylight);
    float moon = max(dot(d, -u_sunDir), 0.0);
    col += vec3(0.9, 0.93, 1.0) * smoothstep(0.9972, 0.9988, moon) * (1.0 - u_daylight) * 1.4;
    // stars at night
    if (u_daylight < 0.25 && d.y > 0.0) {
      vec3 sp = d * 60.0;
      float n = fract(sin(dot(floor(sp.xz + sp.y), vec2(12.9898, 78.233))) * 43758.5453);
      if (n > 0.995) col += vec3(1.0) * (0.25 - u_daylight) * 4.0;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

const RAIN_VERT = /* glsl */`
  uniform float u_time;
  attribute float a_seed;
  varying float vA;
  void main() {
    vec3 p = position;
    float t = mod(p.y - u_time * 30.0, 60.0);
    p.y = t;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vA = 1.0;
    gl_PointSize = 2.0;
    gl_Position = projectionMatrix * mv;
  }
`;
const RAIN_FRAG = /* glsl */`
  precision mediump float;
  varying float vA;
  void main() {
    gl_FragColor = vec4(0.75, 0.82, 0.95, 0.45);
  }
`;

// ---------- Game ----------
export class Game {
  constructor(canvas, opts = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 16 * (opts.renderDistance || 8) * 1.6);
    this.baseFov = 70;

    // Atlas texture
    const tex = new THREE.CanvasTexture(atlasCanvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    this.atlasTex = tex;

    this.opaqueMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        u_atlas: { value: tex }, u_daylight: { value: 1 }, u_fogColor: { value: new THREE.Color(0.75, 0.85, 0.98) },
        u_fogDensity: { value: 0.007 }, u_waterWave: { value: 0 }, u_alphaTest: { value: 0.5 }, u_isWater: { value: 0 },
      },
    });
    this.transMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.clone(this.opaqueMat.uniforms),
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.transMat.uniforms.u_isWater.value = 1;
    this.transMat.uniforms.u_alphaTest.value = 0.05;
    // share dynamic uniforms by reference where possible
    const link = ['u_daylight', 'u_fogColor', 'u_fogDensity', 'u_waterWave'];
    for (const k of link) this.transMat.uniforms[k] = this.opaqueMat.uniforms[k];

    this.seed = opts.seed ?? ((Math.random() * 2 ** 31) | 0);
    this.cm = new ChunkManager(this.scene, this.opaqueMat, this.transMat, this.seed);
    this.player = new Player(this.cm);
    this.entities = new THREE.Scene(); // placeholder replaced below
    this.entityMgr = new EntityManager(this.scene, this.cm);
    this.audio = new AudioEngine();
    window.__audio = this.audio;

    this.input = new Input(canvas);

    // Sky dome
    this.skyUniforms = { u_sunDir: { value: new THREE.Vector3(0, 1, 0) }, u_daylight: { value: 1 }, u_rain: { value: 0 } };
    const skyGeo = new THREE.SphereGeometry(1, 24, 16);
    this.sky = new THREE.Mesh(skyGeo, new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: this.skyUniforms,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    }));
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Sun directional light for mobs (Lambert)
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.7));

    // Block highlight
    const hlGeo = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(hlGeo),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 })
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    // Crack overlay cube
    this.crackMesh = new THREE.Mesh(hlGeo.clone(), new THREE.MeshBasicMaterial({
      color: 0x222222, transparent: true, opacity: 0.0, depthWrite: false,
    }));
    this.crackMesh.visible = false;
    this.scene.add(this.crackMesh);

    // Rain particle system
    const rainCount = 5000;
    const rp = new Float32Array(rainCount * 3);
    const rs = new Float32Array(rainCount);
    for (let i = 0; i < rainCount; i++) {
      rp[i*3] = (Math.random() - 0.5) * 64;
      rp[i*3+1] = Math.random() * 60;
      rp[i*3+2] = (Math.random() - 0.5) * 64;
      rs[i] = Math.random();
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    rainGeo.setAttribute('a_seed', new THREE.BufferAttribute(rs, 1));
    this.rainMat = new THREE.ShaderMaterial({ vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, uniforms: { u_time: { value: 0 } }, transparent: true, depthWrite: false });
    this.rain = new THREE.Points(rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);

    // Time & weather state
    this.timeOfDay = 0.3;   // 0..1 (0.25 sunrise, 0.5 noon, 0.75 sunset)
    this.dayLength = 20 * 60; // seconds per full cycle (accelerated default 10 min)
    this.weather = { raining: false, timer: 120, thunderTimer: 30 };

    // Interaction state
    this.breaking = { active: false, x: 0, y: 0, z: 0, progress: 0 };
    this.accumulator = 0;
    this.lastTime = performance.now();
    this.paused = false;
    this.running = true;
    this.fps = 60; this._fpsAcc = 0; this._fpsN = 0;
    this._tmpVec = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this.bobPhase = 0;
    this.currentFov = 70;

    this.onGameOver = null;
    this.onUpdateHud = null;

    window.addEventListener('resize', () => this._onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.autoPaused = true;
      else { this.lastTime = performance.now(); }
    });
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  placeBlock(hit, itemName) {
    const id = registry.byNameGet(itemName)?.id;
    if (!id) return false;
    const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
    // don't place inside player AABB
    const p = this.player.pos;
    const b = registry.get(id);
    if (b.solid) {
      if (px + 1 > p.x - 0.3 && px < p.x + 0.3 && py + 1 > p.y && py < p.y + 1.8 && pz + 1 > p.z - 0.3 && pz < p.z + 0.3) return false;
    }
    const cur = this.cm.getBlock(px, py, pz);
    if (cur !== 0 && !registry.get(cur).liquid) return false;
    if (this.cm.setBlock(px, py, pz, id)) {
      this.audio.play('place_block', { pos: { x: px + 0.5, y: py + 0.5, z: pz + 0.5 }, vol: 0.5 });
      return true;
    }
    return false;
  }

  breakBlock(x, y, z) {
    const id = this.cm.getBlock(x, y, z);
    if (!id) return null;
    const b = registry.get(id);
    if (!isFinite(b.hardness)) return null;
    let drop = b.drop;
    // silk-like simplification: grass drops dirt handled in registry; ores drop raw items
    this.cm.setBlock(x, y, z, 0);
    this.audio.play('break_block', { pos: { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, vol: 0.6 });
    // TNT explosion chain
    if (id === BLOCK.tnt) this.explode(x, y, z, 3.5);
    return drop;
  }

  explode(cx, cy, cz, radius) {
    this.audio.play('explode', { pos: { x: cx, y: cy, z: cz }, vol: 1 });
    const r2 = radius * radius;
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++)
      for (let dz = -Math.ceil(radius); dz <= Math.ceil(radius); dz++)
        for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
          const d2 = dx*dx + dy*dy + dz*dz;
          if (d2 > r2) continue;
          const x = cx + dx, y = cy + dy, z = cz + dz;
          const id = this.cm.getBlock(x, y, z);
          if (!id) continue;
          const b = registry.get(id);
          if (b.name === 'bedrock' || b.name === 'obsidian') continue;
          if (b.liquid) continue;
          if (b.name === 'tnt') { this.cm.setBlock(x, y, z, 0); setTimeout(() => this.explode(x, y, z, 3.5), 300 + Math.random()*300); continue; }
          this.cm.setBlock(x, y, z, 0);
        }
    // damage nearby mobs and player
    this.entityMgr.mobs.forEach(m => {
      const d = Math.sqrt((m.pos.x-cx)**2 + (m.pos.y-cy)**2 + (m.pos.z-cz)**2);
      if (d < radius + 2) { m.health -= 8; if (m.health <= 0) this.entityMgr.mobs.splice(this.entityMgr.mobs.indexOf(m),1); }
    });
    const pd = this.player.pos.distanceTo(new THREE.Vector3(cx, cy, cz));
    if (pd < radius + 1 && this.player.gamemode === 'survival') this.hurtPlayer(Math.max(1, Math.floor(radius + 1 - pd)));
  }

  hurtPlayer(dmg) {
    if (this.player.gamemode === 'creative' || this.player.flying) return;
    this.player.health = Math.max(0, this.player.health - dmg);
    this.audio.play('hurt', { cat: 'mobs', vol: 0.8 });
    if (this.onPlayerHurt) this.onPlayerHurt();
    if (this.player.health <= 0 && this.onGameOver) this.onGameOver();
  }

  respawn(spawn) {
    this.player.respawn(spawn);
  }

  getSunDirection(out) {
    const ang = (this.timeOfDay - 0.25) * Math.PI * 2;
    out.set(Math.cos(ang) * 0.6, Math.sin(ang), Math.cos(ang) * 0.35).normalize();
    return out;
  }

  tick(dt) {
    // ---- input -> player intent ----
    const inp = this.input;
    const p = this.player;
    let fwd = 0, strafe = 0;
    if (inp.isDown('KeyW')) fwd += 1;
    if (inp.isDown('KeyS')) fwd -= 1;
    if (inp.isDown('KeyD')) strafe += 1;
    if (inp.isDown('KeyA')) strafe -= 1;
    // gamepad
    if (inp.pollGamepad()) {
      const g = inp.gamepad;
      if (Math.abs(g.axes[1]) > 0.2) fwd -= g.axes[1];
      if (Math.abs(g.axes[0]) > 0.2) strafe += g.axes[0];
    }
    const sprintKey = inp.isDown('ShiftLeft') || inp.isDown('ShiftRight');
    p.sneaking = inp.isDown('ControlLeft') || inp.isDown('KeyC');
    p.sprinting = sprintKey && !p.sneaking && (fwd > 0);
    const wantJump = inp.isDown('Space');

    // wish direction rotated by yaw
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    let wx = (-sin * fwd + cos * strafe);
    let wz = (-cos * fwd - sin * strafe);
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }

    p.update(dt, { x: wx, z: wz }, wantJump);

    // footsteps
    const hs = Math.hypot(p.vel.x, p.vel.z);
    p.stepSoundTimer -= dt;
    if (p.onGround && hs > 1.5 && p.stepSoundTimer <= 0) {
      p.stepSoundTimer = p.sprinting ? 0.24 : 0.34;
      const under = this.cm.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y - 0.4), Math.floor(p.pos.z));
      const name = registry.get(under)?.name || 'dirt';
      const snd = name.includes('grass') ? 'step_grass' : name.includes('sand') ? 'step_sand' :
                  name.includes('stone') || name.includes('cobble') || name.includes('ore') ? 'step_stone' :
                  name.includes('log') || name.includes('plank') ? 'step_wood' : 'step_dirt';
      this.audio.play(snd, { vol: 0.25 });
    }
    if (p.justEnteredWater !== p.inWater) {
      p.justEnteredWater = p.inWater;
      if (p.inWater) this.audio.play('splash', { vol: 0.7 });
    }

    // fall damage event
    if (p.fallDamageEvent) {
      if (p.fallDamageEvent > 3.2 && p.gamemode === 'survival') this.hurtPlayer(Math.floor(p.fallDamageEvent - 3));
      p.fallDamageEvent = 0;
    }

    // entities
    this.entityMgr.update(dt, p.pos, (dmg) => this.hurtPlayer(dmg));

    // time
    this.timeOfDay = (this.timeOfDay + dt / this.dayLength) % 1;

    // weather
    const w = this.weather;
    w.timer -= dt;
    if (w.timer <= 0) {
      w.raining = !w.raining;
      w.timer = w.raining ? 60 + Math.random() * 120 : 180 + Math.random() * 300;
      if (w.raining) this.audio.startRain(); else this.audio.stopRain();
    }
    if (w.raining) {
      w.thunderTimer -= dt;
      if (w.thunderTimer <= 0) {
        w.thunderTimer = 20 + Math.random() * 40;
        this.audio.play('explode', { cat: 'weather', vol: 0.5, rate: 0.35 });
        if (this.onThunder) this.onThunder();
      }
    }
  }

  render(nowMs, alpha) {
    const inp = this.input, p = this.player;

    // Look
    if (inp.pointerLocked && !this.paused) {
      p.yaw -= inp.mouseDX * 0.0024;
      p.pitch -= inp.mouseDY * 0.0024;
      p.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, p.pitch));
    }

    // Camera at eye with head bob
    const cam = this.camera;
    const speed2d = Math.hypot(p.vel.x, p.vel.z);
    if (p.onGround && speed2d > 0.5) this.bobPhase += (0.018 * speed2d);
    const bobY = Math.sin(this.bobPhase * 6) * 0.05 * Math.min(1, speed2d / 4.3) * (p.sneaking ? 0.4 : 1);
    const bobX = Math.cos(this.bobPhase * 3) * 0.03 * Math.min(1, speed2d / 4.3);
    const sneakDrop = p.sneaking && !p.flying ? 0.18 : 0;
    cam.position.set(p.pos.x + bobX * Math.cos(p.yaw), p.pos.y + EYE - sneakDrop + bobY, p.pos.z - bobX * Math.sin(p.yaw));
    cam.rotation.order = 'YXZ';
    cam.rotation.y = p.yaw;
    cam.rotation.x = p.pitch;
    cam.rotation.z = 0;

    // FOV sprint tween
    const targetFov = p.sprinting ? 80 : (p.inWater ? 65 : this.baseFov);
    if (Math.abs(cam.fov - targetFov) > 0.05) {
      cam.fov += (targetFov - cam.fov) * 0.12;
      cam.updateProjectionMatrix();
    }

    // Day/night lighting uniforms
    const sun = this.getSunDirection(this._tmpVec);
    const daylight = Math.max(0.08, Math.min(1, sun.y * 1.6 + 0.25));
    const rainDim = this.weather.raining ? 0.55 : 1;
    const dl = daylight * rainDim;
    this.skyUniforms.u_sunDir.value.copy(sun);
    this.skyUniforms.u_daylight.value = dl;
    this.skyUniforms.u_rain.value = this.weather.raining ? 1 : 0;
    this.opaqueMat.uniforms.u_daylight.value = dl;
    this.opaqueMat.uniforms.u_waterWave.value = nowMs * 0.002;
    this.sunLight.intensity = dl;
    this.sunLight.position.copy(sun).multiplyScalar(50);
    // fog color follows sky horizon
    const fc = this.opaqueMat.uniforms.u_fogColor.value;
    fc.setRGB(
      (0.08 + 0.67 * dl) * (this.weather.raining ? 0.8 : 1),
      (0.09 + 0.76 * dl) * (this.weather.raining ? 0.8 : 1),
      (0.18 + 0.8 * dl) * (this.weather.raining ? 0.82 : 1)
    );
    const rd = this.cm.renderDistance;
    this.opaqueMat.uniforms.u_fogDensity.value = 1.0 / (rd * 16 * 0.75);
    this.renderer.setClearColor(fc);
    window.__isNight = dl < 0.3;

    // Sky follows camera
    this.sky.position.copy(cam.position);

    // Chunk streaming
    this.cm.update(p.pos.x, p.pos.z);

    // Raycast & highlight
    cam.getWorldDirection(this._forward);
    const hit = raycastVoxel(
      (x, y, z) => this.cm.getBlock(x, y, z),
      cam.position.x, cam.position.y, cam.position.z,
      this._forward.x, this._forward.y, this._forward.z, 5.5
    );
    if (hit) {
      this.highlight.visible = true;
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      const pulse = 0.45 + 0.25 * Math.sin(nowMs * 0.006);
      this.highlight.material.opacity = pulse;
    } else {
      this.highlight.visible = false;
    }
    this.currentHit = hit;

    // Breaking progress while LMB held
    if (this.breaking.active) {
      const b = registry.get(this.cm.getBlock(this.breaking.x, this.breaking.y, this.breaking.z));
      if (!b || b.id === 0 || this.breaking.targetChanged) {
        this.breaking.active = false; this.breaking.progress = 0;
        if (this.onBreakProgress) this.onBreakProgress(0);
      } else {
        const toolBonus = this.player.gamemode === 'creative' ? 20 : 1;
        this.breaking.progress += (TICK * toolBonus) / Math.max(0.05, b.hardness);
        if (this.breaking.progress >= 1) {
          const drop = this.breakBlock(this.breaking.x, this.breaking.y, this.breaking.z);
          this.breaking.active = false; this.breaking.progress = 0;
          if (this.onBlockBroken) this.onBlockBroken(drop);
        }
        if (this.onBreakProgress) this.onBreakProgress(this.breaking.progress);
        this.crackMesh.visible = true;
        this.crackMesh.position.set(this.breaking.x + 0.5, this.breaking.y + 0.5, this.breaking.z + 0.5);
        this.crackMesh.material.opacity = 0.15 + this.breaking.progress * 0.35;
        const s = 1 - this.breaking.progress * 0.35;
        this.crackMesh.scale.setScalar(s);
      }
    } else {
      this.crackMesh.visible = false;
    }

    // Entities instancing
    this.entityMgr.syncInstances(cam.position);

    // Rain follows player
    if (this.weather.raining) {
      this.rain.visible = true;
      this.rain.position.set(Math.floor(p.pos.x), Math.floor(p.pos.y) + 20, Math.floor(p.pos.z));
      this.rainMat.uniforms.u_time.value = nowMs * 0.001;
    } else this.rain.visible = false;

    // Underwater tint via fog override
    if (p.headInWater) {
      fc.setRGB(0.05, 0.2, 0.4);
      this.opaqueMat.uniforms.u_fogDensity.value = 0.09;
    }

    this.audio.updateListener(cam.position.x, cam.position.y, cam.position.z, this._forward, this._up);

    this.renderer.render(this.scene, this.camera);
  }

  startLoop(loopHooks) {
    const step = (now) => {
      if (!this.running) return;
      requestAnimationFrame(step);
      let dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (dt > 0.2) dt = 0.2; // tab-switch catch-up guard

      // FPS meter
      this._fpsAcc += dt; this._fpsN++;
      if (this._fpsAcc >= 0.5) { this.fps = this._fpsN / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }

      const paused = this.paused || this.autoPaused;
      if (!paused) {
        this.accumulator += dt;
        let n = 0;
        while (this.accumulator >= TICK && n < 6) {
          this.tick(TICK);
          this.accumulator -= TICK;
          n++;
        }
        if (n === 6) this.accumulator = 0;
      }
      const alpha = this.accumulator / TICK;
      this.render(now, alpha);
      if (loopHooks && loopHooks.afterRender) loopHooks.afterRender(alpha);
      this.input.endFrame();
    };
    requestAnimationFrame(step);
  }

  dispose() {
    this.running = false;
    for (const c of this.cm.chunks.values()) this.cm._dispose(c);
    this.entityMgr.dispose();
    this.renderer.dispose();
  }
}
