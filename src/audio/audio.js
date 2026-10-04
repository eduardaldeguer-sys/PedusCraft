// Web Audio synthesis: no external files. All sounds are procedurally generated
// and pooled as AudioBuffers. 3D panning via PannerNode for world events.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.master = null; this.categories = {};
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.enabled = true;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    for (const cat of ['music', 'weather', 'blocks', 'mobs', 'ui']) {
      const g = this.ctx.createGain();
      g.connect(this.master);
      this.categories[cat] = g;
    }
    this._genAll();
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // --- Buffer generation helpers ---
  _noise(len, fn) {
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = fn(i / len, i);
    return buf;
  }

  _genAll() {
    const sr = this.ctx.sampleRate;
    // Dig/step sounds: filtered noise bursts per material family
    const makeStep = (freq, decay, q = 1) => this._noise(Math.floor(sr * decay), (t) => {
      const env = Math.exp(-t * (1 / decay) * 6);
      const n = (Math.random() * 2 - 1);
      // crude low-pass by averaging
      const lp = n * Math.sin(t * freq * 6.283 + Math.sin(t * freq * 0.7) * 2);
      return lp * env * 0.6;
    });
    this.buffers.set('step_grass', makeStep(900, 0.09));
    this.buffers.set('step_stone', makeStep(500, 0.08));
    this.buffers.set('step_dirt', makeStep(400, 0.1));
    this.buffers.set('step_sand', makeStep(1400, 0.07));
    this.buffers.set('step_wood', makeStep(650, 0.09));
    this.buffers.set('break_block', this._noise(Math.floor(sr * 0.25), (t) => {
      const env = Math.exp(-t * 22);
      return (Math.random() * 2 - 1) * env * (0.5 + 0.5 * Math.sin(t * 180));
    }));
    this.buffers.set('place_block', this._noise(Math.floor(sr * 0.12), (t) => {
      const env = Math.exp(-t * 40);
      return (Math.random() * 2 - 1) * env * 0.8 * Math.sin(t * 900 * 6.283 * (1 - t));
    }));
    this.buffers.set('splash', this._noise(Math.floor(sr * 0.5), (t) => {
      const env = Math.exp(-t * 7) * (1 - t);
      return (Math.random() * 2 - 1) * env;
    }));
    this.buffers.set('hurt', this._noise(Math.floor(sr * 0.3), (t) => {
      const f = 220 * (1 - t * 0.5);
      return Math.sin(t * f * 6.283) * Math.exp(-t * 12) * 0.7 + (Math.random()*2-1) * Math.exp(-t*30) * 0.3;
    }));
    this.buffers.set('click', this._noise(Math.floor(sr * 0.05), (t) => Math.sin(t * 1200 * 6.283) * Math.exp(-t * 80)));
    this.buffers.set('craft', this._noise(Math.floor(sr * 0.35), (t) => {
      const beat = Math.max(0, Math.sin(t * 40)) ;
      return (Math.random() * 2 - 1) * Math.exp(-t * 8) * 0.4 + Math.sin(t * 700 * 6.283) * beat * 0.15;
    }));
    this.buffers.set('explode', this._noise(Math.floor(sr * 1.2), (t) => {
      const env = Math.exp(-t * 4);
      return ((Math.random() * 2 - 1) * env + Math.sin(t * 60 * 6.283 * (1-t)) * env * 0.8);
    }));
    this.buffers.set('zombie', this._noise(Math.floor(sr * 0.8), (t) => {
      const f = 90 + 40 * Math.sin(t * 8);
      return Math.sin(t * f * 6.283) * Math.exp(-t * 3) * 0.5 * (0.5 + 0.5*Math.sin(t*25));
    }));
    this.buffers.set('pig', this._noise(Math.floor(sr * 0.5), (t) => {
      const f = 180 + 120 * Math.sin(t * 14);
      return Math.sin(t * f * 6.283) * Math.exp(-t * 6) * 0.5;
    }));
    // Rain loop: brown noise, short tileable buffer
    this.buffers.set('rain', this._noise(Math.floor(sr * 2), () => {
      // simple colored noise
      let last = 0;
      last = last * 0.97 + (Math.random() * 2 - 1) * 0.1;
      return last * 3;
    }));
  }

  setCategoryVolume(cat, v) { if (this.categories[cat]) this.categories[cat].gain.value = v; }

  play(name, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    if (this.ctx.state === 'suspended') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate || (0.9 + Math.random() * 0.2);
    let node = src;
    if (opts.pos) {
      const pan = this.ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 4;
      pan.maxDistance = 64;
      pan.rolloffFactor = 1.2;
      pan.positionX.value = opts.pos.x;
      pan.positionY.value = opts.pos.y;
      pan.positionZ.value = opts.pos.z;
      node.connect(pan);
      node = pan;
    }
    const gain = this.ctx.createGain();
    gain.gain.value = opts.vol ?? 0.7;
    node.connect(gain);
    gain.connect(this.categories[opts.cat || 'blocks'] || this.master);
    src.start();
  }

  startRain() {
    if (!this.ctx || this.rainSrc) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get('rain');
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g); g.connect(this.categories.weather);
    src.start();
    this.rainSrc = src; this.rainGain = g;
    g.gain.linearRampToValueAtTime(0.35, this.ctx.currentTime + 2);
  }
  stopRain() {
    if (!this.rainSrc) return;
    const g = this.rainGain, s = this.rainSrc;
    g.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.5);
    setTimeout(() => { try { s.stop(); } catch(e){} }, 1800);
    this.rainSrc = null;
  }

  updateListener(x, y, z, forward, up) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = x; L.positionY.value = y; L.positionZ.value = z;
      L.forwardX.value = forward.x; L.forwardY.value = forward.y; L.forwardZ.value = forward.z;
      L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
    } else if (L.setPosition) {
      L.setPosition(x, y, z);
      L.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }
}
