// Simplex + Perlin noise, FBM, ridged noise, and seeded PRNG.
// Pure JS implementation usable on main thread and inside Web Workers.

export class SimplexNoise {
  constructor(seed = 1337) {
    this.p = new Uint8Array(256);
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    const rand = mulberry32(seed >>> 0);
    for (let i = 0; i < 256; i++) this.p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = this.p[i]; this.p[i] = this.p[j]; this.p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = this.p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise2D(xin, yin) {
    const grad3 = SimplexNoise.GRAD3;
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    let n0, n1, n2;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 < 0) n0 = 0;
    else {
      t0 *= t0;
      const gi0 = this.permMod12[ii + this.perm[jj]];
      n0 = t0 * t0 * (grad3[gi0][0] * x0 + grad3[gi0][1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 < 0) n1 = 0;
    else {
      t1 *= t1;
      const gi1 = this.permMod12[ii + i1 + this.perm[jj + j1]];
      n1 = t1 * t1 * (grad3[gi1][0] * x1 + grad3[gi1][1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 < 0) n2 = 0;
    else {
      t2 *= t2;
      const gi2 = this.permMod12[ii + 1 + this.perm[jj + 1]];
      n2 = t2 * t2 * (grad3[gi2][0] * x2 + grad3[gi2][1] * y2);
    }
    return 70 * (n0 + n1 + n2); // [-1, 1]
  }

  noise3D(xin, yin, zin) {
    const grad3 = SimplexNoise.GRAD3;
    const F3 = 1 / 3, G3 = 1 / 6;
    let n0, n1, n2, n3;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=1;k2=0; }
      else if (x0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=0;k2=1; }
      else { i1=0;j1=0;k1=1;i2=1;j2=0;k2=1; }
    } else {
      if (y0 < z0) { i1=0;j1=0;k1=1;i2=0;j2=1;k2=1; }
      else if (x0 < z0) { i1=0;j1=1;k1=0;i2=0;j2=1;k2=1; }
      else { i1=0;j1=1;k1=0;i2=1;j2=1;k2=0; }
    }
    const x1=x0-i1+G3, y1=y0-j1+G3, z1=z0-k1+G3;
    const x2=x0-i2+2*G3, y2=y0-j2+2*G3, z2=z0-k2+2*G3;
    const x3=x0-1+3*G3, y3=y0-1+3*G3, z3=z0-1+3*G3;
    const ii=i&255, jj=j&255, kk=k&255;
    let tt;
    tt = 0.6 - x0*x0 - y0*y0 - z0*z0;
    if (tt < 0) n0 = 0; else { tt*=tt; const gi=this.permMod12[ii+this.perm[jj+this.perm[kk]]]; n0=tt*tt*(grad3[gi][0]*x0+grad3[gi][1]*y0+(grad3[gi][2]||0)*z0); }
    tt = 0.6 - x1*x1 - y1*y1 - z1*z1;
    if (tt < 0) n1 = 0; else { tt*=tt; const gi=this.permMod12[ii+i1+this.perm[jj+j1+this.perm[kk+k1]]]; n1=tt*tt*(grad3[gi][0]*x1+grad3[gi][1]*y1+(grad3[gi][2]||0)*z1); }
    tt = 0.6 - x2*x2 - y2*y2 - z2*z2;
    if (tt < 0) n2 = 0; else { tt*=tt; const gi=this.permMod12[ii+i2+this.perm[jj+j2+this.perm[kk+k2]]]; n2=tt*tt*(grad3[gi][0]*x2+grad3[gi][1]*y2+(grad3[gi][2]||0)*z2); }
    tt = 0.6 - x3*x3 - y3*y3 - z3*z3;
    if (tt < 0) n3 = 0; else { tt*=tt; const gi=this.permMod12[ii+1+this.perm[jj+1+this.perm[kk+1]]]; n3=tt*tt*(grad3[gi][0]*x3+grad3[gi][1]*y3+(grad3[gi][2]||0)*z3); }
    return 32 * (n0 + n1 + n2 + n3);
  }
}
SimplexNoise.GRAD3 = [
  [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
  [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
];

// Seeded PRNG (mulberry32) — deterministic across threads
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    let x = Math.floor(n * 73856093) | 0;
    h ^= x;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Fractal Brownian Motion over simplex noise
export function fbm(noise, x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise.noise2D(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(noise, x, y, z, octaves = 3, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise.noise3D(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function ridged(noise, x, y, octaves = 4) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise.noise2D(x * freq, y * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm; // [0,1]
}
