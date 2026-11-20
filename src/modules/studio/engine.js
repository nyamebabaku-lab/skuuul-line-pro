// Record Studio sound engine: turns a raw voice take into a finished, broadcast-clean alert clip.
// Everything runs in the browser (Web Audio OfflineAudioContext for filters/compressor/reverb, plain JS for the
// rest), on mono Float32Array samples at SR.
//
// Chain: cuts (done in the editor) → rumble/hum filters → noise reduction → trim + shorten pauses → pitch/speed
//        → EQ → compressor → reverb → fades → loudness to target → mix chime + music bed → peak limiter.

export const SR = 44100;

// ---------------------------------------------------------------- basics
const db2lin = (db) => Math.pow(10, db / 20);
export const lin2db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Any audio file (wav, mp3, m4a, ogg, webm/opus, WhatsApp voice note) → mono samples at SR. */
export async function decodeToMono(arrayBuffer) {
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/** Runs samples through a Web Audio graph offline. build(ctx, sourceNode) returns the last node. */
async function graph(x, build, extra = 0) {
  const len = x.length + Math.round(extra * SR);
  const ctx = new OfflineAudioContext(1, Math.max(len, 1), SR);
  const b = ctx.createBuffer(1, Math.max(x.length, 1), SR);
  b.getChannelData(0).set(x);
  const src = ctx.createBufferSource();
  src.buffer = b;
  const last = build(ctx, src);
  last.connect(ctx.destination);
  src.start();
  const r = await ctx.startRendering();
  return new Float32Array(r.getChannelData(0));
}

function biquad(ctx, type, frequency, Q = 0.707, gain = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gain;
  return f;
}
const chain = (src, nodes) => nodes.reduce((a, n) => (a.connect(n), n), src);

// ---------------------------------------------------------------- FFT (radix-2, in place)
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n);
}

// ---------------------------------------------------------------- clean-up
/** Rumble below `hz` and 50 Hz mains hum (+ its harmonics) out. */
export function cleanFilters(x, { highpass = 80, hum = true } = {}) {
  return graph(x, (ctx, src) => {
    const nodes = [];
    if (highpass > 0) nodes.push(biquad(ctx, 'highpass', highpass, 0.707), biquad(ctx, 'highpass', highpass, 0.707));
    if (hum) [50, 100, 150, 200].forEach((f) => nodes.push(biquad(ctx, 'notch', f, 30)));
    return nodes.length ? chain(src, nodes) : src;
  });
}

/**
 * Spectral noise reduction: learns the background hiss from the quietest moments of the take, then turns each
 * frequency down where it is not louder than that noise. amount 0..1.
 */
export function denoise(x, amount = 0.5) {
  if (amount <= 0 || x.length < 4096) return x;
  const N = 2048;
  const H = N / 4;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const frames = Math.floor((x.length - N) / H) + 1;
  const bins = N / 2 + 1;
  const mags = [];
  const phases = [];
  const energy = new Float32Array(frames);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) (re[i] = x[f * H + i] * win[i]), (im[i] = 0);
    fft(re, im);
    const m = new Float32Array(bins);
    const p = new Float32Array(bins);
    let e = 0;
    for (let k = 0; k < bins; k++) {
      m[k] = Math.hypot(re[k], im[k]);
      p[k] = Math.atan2(im[k], re[k]);
      e += m[k] * m[k];
    }
    mags.push(m);
    phases.push(p);
    energy[f] = e;
  }
  // Noise profile = average spectrum of the quietest 15% of frames.
  const order = [...energy.keys()].sort((a, b) => energy[a] - energy[b]);
  const quiet = order.slice(0, Math.max(3, Math.floor(frames * 0.15)));
  const noise = new Float32Array(bins);
  quiet.forEach((f) => mags[f].forEach((v, k) => (noise[k] += v / quiet.length)));
  const over = 1.5 + 2.5 * amount; // how far above the noise a sound must be to stay
  const floor = Math.max(0.04, 0.35 - 0.3 * amount); // never fully silent: keeps it natural
  const out = new Float32Array(x.length);
  const norm = new Float32Array(x.length);
  let prev = new Float32Array(bins).fill(1);
  for (let f = 0; f < frames; f++) {
    const m = mags[f];
    const g = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const target = m[k] > 0 ? Math.max(floor, Math.min(1, (m[k] - over * noise[k]) / m[k] + 0.0)) : floor;
      // smooth over time (fast open, slower close) and across neighbouring bins
      g[k] = target > prev[k] ? 0.6 * target + 0.4 * prev[k] : 0.35 * target + 0.65 * prev[k];
    }
    for (let k = 1; k < bins - 1; k++) g[k] = 0.25 * g[k - 1] + 0.5 * g[k] + 0.25 * g[k + 1];
    prev = g;
    for (let k = 0; k < bins; k++) {
      const a = m[k] * g[k];
      re[k] = a * Math.cos(phases[f][k]);
      im[k] = a * Math.sin(phases[f][k]);
      if (k > 0 && k < N / 2) (re[N - k] = re[k]), (im[N - k] = -im[k]);
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) {
      out[f * H + i] += re[i] * win[i];
      norm[f * H + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return out;
}

/** Short-time loudness (RMS, dB) per 10 ms window. */
function envelope(x, win = Math.round(SR * 0.01)) {
  const n = Math.ceil(x.length / win);
  const env = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let s = 0;
    const end = Math.min(x.length, (w + 1) * win);
    for (let i = w * win; i < end; i++) s += x[i] * x[i];
    env[w] = lin2db(Math.sqrt(s / Math.max(1, end - w * win)) + 1e-9);
  }
  return { env, win };
}

/** Level that counts as "silence": well above the background noise, well below the voice. */
function silenceLevel(env, below = 38) {
  const sorted = [...env].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return -60;
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const top = sorted[Math.floor(sorted.length * 0.98)];
  return Math.min(Math.max(floor + 10, top - below), top - 12);
}

/** Removes dead air before the first and after the last word (keeps a little breath). */
export function trimSilence(x, pad = 0.06) {
  const { env, win } = envelope(x);
  const th = silenceLevel(env, 38);
  let a = env.findIndex((v) => v > th);
  let b = env.length - 1 - [...env].reverse().findIndex((v) => v > th);
  if (a < 0) return x;
  a = Math.max(0, a * win - Math.round(pad * SR));
  b = Math.min(x.length, (b + 1) * win + Math.round(pad * 2 * SR));
  return x.slice(a, b);
}

/** Long pauses inside the take are shortened to `max` seconds (with soft crossfades). */
export function shortenPauses(x, max = 0.3) {
  const { env, win } = envelope(x);
  const th = silenceLevel(env, 35);
  const keep = [];
  let run = 0;
  for (let w = 0; w <= env.length; w++) {
    const silent = w < env.length && env[w] < th;
    if (silent) run++;
    else {
      if (run * win > max * SR) {
        const start = (w - run) * win;
        const stop = w * win;
        const allow = Math.round(max * SR);
        keep.push([start + allow / 2, stop - allow / 2]);
      }
      run = 0;
    }
  }
  if (!keep.length) return x;
  const parts = [];
  let pos = 0;
  keep.forEach(([a, b]) => {
    parts.push(x.slice(pos, Math.round(a)));
    pos = Math.round(b);
  });
  parts.push(x.slice(pos));
  return joinCrossfade(parts, Math.round(0.012 * SR));
}

/** Joins pieces with short crossfades so edits never click. */
export function joinCrossfade(parts, xf = Math.round(0.01 * SR)) {
  parts = parts.filter((p) => p.length);
  if (!parts.length) return new Float32Array(0);
  let total = parts[0].length;
  for (let i = 1; i < parts.length; i++) total += parts[i].length - Math.min(xf, parts[i].length, parts[i - 1].length);
  const out = new Float32Array(total);
  out.set(parts[0]);
  let end = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const f = Math.min(xf, p.length, parts[i - 1].length);
    const at = end - f;
    for (let j = 0; j < f; j++) {
      const t = (j + 0.5) / f;
      out[at + j] = out[at + j] * Math.cos((t * Math.PI) / 2) + p[j] * Math.sin((t * Math.PI) / 2);
    }
    out.set(p.subarray(f), end);
    end = at + p.length;
  }
  return out;
}

/** Editor cuts: keeps everything except the [start, end) sample ranges in `cuts`. */
export function applyCuts(x, cuts = []) {
  if (!cuts.length) return x;
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const parts = [];
  let pos = 0;
  sorted.forEach(([a, b]) => {
    if (a > pos) parts.push(x.slice(pos, a));
    pos = Math.max(pos, b);
  });
  parts.push(x.slice(pos));
  return joinCrossfade(parts);
}

// ---------------------------------------------------------------- pitch & speed
function resample(x, ratio) {
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f;
  }
  return out;
}

/** WSOLA time stretch: factor > 1 makes it longer, pitch unchanged. */
export function timeStretch(x, factor) {
  if (Math.abs(factor - 1) < 0.005) return x;
  const W = Math.round(0.04 * SR); // 40 ms frames
  const Hs = W / 2; // output hop
  const Ha = Hs / factor; // input hop
  const tol = Math.round(0.012 * SR);
  const win = new Float32Array(W).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W));
  const outLen = Math.ceil(x.length * factor) + W;
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  let prevPos = 0;
  for (let k = 0; ; k++) {
    const nominal = Math.round(k * Ha);
    if (nominal + W + tol >= x.length) break;
    let best = nominal;
    if (k > 0) {
      // pick the input position whose start best continues the previous frame's natural continuation
      const nat = prevPos + Hs;
      let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const c0 = nominal + d;
        if (c0 < 0 || c0 + W >= x.length) continue;
        let c = 0;
        for (let i = 0; i < Hs; i += 4) c += x[c0 + i] * (x[nat + i] || 0);
        if (c > bestC) (bestC = c), (best = c0);
      }
    }
    const o = k * Hs;
    for (let i = 0; i < W; i++) {
      out[o + i] += x[best + i] * win[i];
      norm[o + i] += win[i];
    }
    prevPos = best;
  }
  const n = Math.min(outLen, Math.ceil(x.length * factor));
  const res = new Float32Array(n);
  for (let i = 0; i < n; i++) res[i] = norm[i] > 0.1 ? out[i] / norm[i] : out[i];
  return res;
}

/** pitch in semitones (−4…+4), speed 0.8…1.25 (1 = as recorded). */
export function pitchSpeed(x, pitch = 0, speed = 1) {
  if (!pitch && Math.abs(speed - 1) < 0.005) return x;
  const r = Math.pow(2, pitch / 12);
  const shifted = pitch ? resample(x, r) : x;
  return timeStretch(shifted, r / speed);
}

// ---------------------------------------------------------------- polish
/** Voice EQ (dB): bass shelf 120 Hz, mud cut 350 Hz, presence 3.5 kHz, air shelf 10 kHz. */
export function eq(x, { bass = 0, mid = 0, presence = 0, air = 0 } = {}) {
  if (!bass && !mid && !presence && !air) return x;
  return graph(x, (ctx, src) =>
    chain(src, [
      biquad(ctx, 'lowshelf', 120, 0.707, bass),
      biquad(ctx, 'peaking', 350, 1.0, mid),
      biquad(ctx, 'peaking', 3500, 0.9, presence),
      biquad(ctx, 'highshelf', 10000, 0.707, air),
    ]),
  );
}

/** Compressor: evens out loud and soft words. amount 0..1. */
export async function compress(x, amount = 0.5) {
  if (amount <= 0) return x;
  const p = peak(x) || 1;
  const pre = x.map((v) => (v / p) * 0.9); // into the compressor at a known level
  return graph(pre, (ctx, src) => {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -8 - 26 * amount;
    c.ratio.value = 2 + 6 * amount;
    c.knee.value = 8;
    c.attack.value = 0.004;
    c.release.value = 0.12;
    return chain(src, [c]);
  });
}

function impulse(type) {
  const spec = { room: [0.45, 0.6], studio: [0.25, 0.4], hall: [1.8, 0.35], plate: [1.1, 0.75] }[type];
  if (!spec) return null;
  const [secs, bright] = spec;
  const n = Math.round(secs * SR);
  const ir = new Float32Array(n);
  const a = 0.12 + 0.8 * bright; // one-pole low-pass: lower = darker tail
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    lp += a * (Math.random() * 2 - 1 - lp);
    ir[i] = t < 0.012 ? 0 : lp * Math.exp((-6.9 * t) / secs); // short pre-delay, then the decaying tail
  }
  return { ir, secs };
}

/** Reverb: none | studio | room | plate | hall, mix 0..1 (wet level). */
export function reverb(x, type = 'none', mix = 0.15) {
  const imp = impulse(type);
  if (!imp || mix <= 0) return x;
  return graph(
    x,
    (ctx, src) => {
      const conv = ctx.createConvolver();
      const ib = ctx.createBuffer(1, imp.ir.length, SR);
      ib.getChannelData(0).set(imp.ir);
      conv.normalize = true;
      conv.buffer = ib;
      const wet = ctx.createGain();
      wet.gain.value = mix;
      const dry = ctx.createGain();
      dry.gain.value = 1 - mix * 0.35;
      const sum = ctx.createGain();
      src.connect(dry).connect(sum);
      src.connect(conv).connect(wet).connect(sum);
      return sum;
    },
    imp.secs * 0.8,
  );
}

export function fades(x, inMs = 10, outMs = 60) {
  const y = new Float32Array(x);
  const a = Math.min(y.length, Math.round((inMs / 1000) * SR));
  const b = Math.min(y.length, Math.round((outMs / 1000) * SR));
  for (let i = 0; i < a; i++) y[i] *= Math.sin(((i / a) * Math.PI) / 2);
  for (let i = 0; i < b; i++) y[y.length - 1 - i] *= Math.sin(((i / b) * Math.PI) / 2);
  return y;
}

// ---------------------------------------------------------------- loudness (ITU-R BS.1770, integrated LUFS)
export async function lufs(x) {
  if (x.length < SR * 0.4) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    return -0.691 + 10 * Math.log10(s / Math.max(1, x.length) + 1e-12);
  }
  const k = await graph(x, (ctx, src) => chain(src, [biquad(ctx, 'highshelf', 1681, 0.707, 4), biquad(ctx, 'highpass', 38, 0.5)]));
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const z = [];
  for (let s = 0; s + block <= k.length; s += hop) {
    let e = 0;
    for (let i = s; i < s + block; i++) e += k[i] * k[i];
    z.push(e / block);
  }
  const L = (m) => -0.691 + 10 * Math.log10(m + 1e-12);
  const abs = z.filter((m) => L(m) > -70);
  if (!abs.length) return -70;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((m) => L(m) > rel);
  return L(gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length));
}

/** Lookahead peak limiter: nothing goes above `ceilingDb`, no audible clicks. */
export function limit(x, ceilingDb = -1) {
  const c = db2lin(ceilingDb);
  const L = Math.round(0.004 * SR);
  const n = x.length;
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) req[i] = Math.abs(x[i]) > c ? c / Math.abs(x[i]) : 1;
  // sliding minimum over ±L (deque), then moving average over ±L → gain never above what each sample needs
  const m = new Float32Array(n);
  const dq = [];
  for (let i = 0, j = 0; i < n; i++) {
    for (; j < Math.min(n, i + L + 1); j++) {
      while (dq.length && req[dq[dq.length - 1]] >= req[j]) dq.pop();
      dq.push(j);
    }
    while (dq[0] < i - L) dq.shift();
    m[i] = req[dq[0]];
  }
  const g = new Float32Array(n);
  let s = 0;
  const w = 2 * L + 1;
  for (let i = 0; i < Math.min(n, L); i++) s += m[i];
  for (let i = 0; i < n; i++) {
    if (i + L < n) s += m[i + L];
    if (i - L - 1 >= 0) s -= m[i - L - 1];
    const cnt = Math.min(n - 1, i + L) - Math.max(0, i - L) + 1;
    g[i] = s / (cnt || w);
  }
  // slow release so the level doesn't pump
  const rel = 1 - Math.exp(-1 / (0.06 * SR));
  const y = new Float32Array(n);
  let env = 1;
  for (let i = 0; i < n; i++) {
    env = g[i] < env ? g[i] : env + (g[i] - env) * rel;
    const v = x[i] * Math.min(env, g[i]);
    y[i] = Math.max(-c, Math.min(c, v));
  }
  return y;
}

// ---------------------------------------------------------------- mix: chime + music bed
export const CHIMES = {
  none: 'No chime',
  two: 'Two-note chime',
  bell: 'School bell (3 notes)',
  ding: 'Soft ding',
  rise: 'Rising alert',
};

function tone(out, at, freq, dur, vol, harmonics = [1, 0.25, 0.08], decay = 5) {
  const s = Math.round(at * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && s + i < out.length; i++) {
    const t = i / SR;
    const envA = Math.min(1, t / 0.006);
    const env = envA * Math.exp(-decay * t);
    let v = 0;
    harmonics.forEach((h, k) => (v += h * Math.sin(2 * Math.PI * freq * (k + 1) * t)));
    out[s + i] += v * env * vol;
  }
}

export function chime(style = 'two') {
  const len = { two: 0.95, bell: 1.25, ding: 0.9, rise: 0.8 }[style];
  if (!len) return new Float32Array(0);
  const out = new Float32Array(Math.round(len * SR));
  if (style === 'two') {
    tone(out, 0, 880, 0.7, 0.45);
    tone(out, 0.24, 1318.5, 0.7, 0.45);
  } else if (style === 'bell') {
    tone(out, 0, 1046.5, 0.8, 0.4, [1, 0.4, 0.15, 0.06], 4);
    tone(out, 0.2, 1318.5, 0.8, 0.4, [1, 0.4, 0.15, 0.06], 4);
    tone(out, 0.4, 1568, 0.85, 0.4, [1, 0.4, 0.15, 0.06], 4);
  } else if (style === 'ding') {
    tone(out, 0, 659.25, 0.9, 0.55, [1, 0.5, 0.12], 3.5);
  } else if (style === 'rise') {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(out, i * 0.1, f, 0.45, 0.32, [1, 0.2], 7));
  }
  const p = peak(out) || 1;
  return out.map((v) => (v / p) * 0.9);
}

export const BEDS = { none: 'No music', pad: 'Soft pad', bright: 'Bright pad', upload: 'My music file' };

/** A gentle synthesized chord bed (Cmaj7 → Am7 → Fmaj7 → G6) under the voice. */
export function pad(seconds, bright = false) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const chords = [
    [261.63, 329.63, 392.0, 493.88],
    [220.0, 261.63, 329.63, 392.0],
    [174.61, 220.0, 261.63, 329.63],
    [196.0, 246.94, 293.66, 329.63],
  ];
  const each = Math.max(1.2, seconds / chords.length);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const c = chords[Math.min(chords.length - 1, Math.floor(t / each))];
    const local = t % each;
    const env = Math.min(1, local / 0.35) * Math.min(1, (each - local) / 0.35);
    let v = 0;
    c.forEach((f, k) => {
      v += Math.sin(2 * Math.PI * f * t + k) * 0.6;
      v += Math.sin(2 * Math.PI * f * 2 * t + k * 2) * (bright ? 0.22 : 0.08);
      v += Math.sin(2 * Math.PI * (f * 1.003) * t) * 0.3; // gentle chorus
    });
    out[i] = v * env;
  }
  const p = peak(out) || 1;
  return out.map((v) => (v / p) * 0.8);
}

// ---------------------------------------------------------------- presets & the whole chain
export const DEFAULTS = {
  clean: { noise: 0.5, hum: true, highpass: 80, trim: true, pauses: true },
  polish: { preset: 'clear', bass: 0, mid: -2, presence: 3, air: 2, comp: 0.5, loud: true, target: -16 },
  fx: { reverb: 'none', reverbMix: 0.12, pitch: 0, speed: 1, fadeIn: 10, fadeOut: 80 },
  mix: { chime: 'two', chimeVol: 0.55, gap: 0.12, bed: 'none', bedVol: 0.1 },
};

export const PRESETS = {
  clear: { label: 'Clear announcer', polish: { bass: 0, mid: -2, presence: 3, air: 2, comp: 0.5 }, fx: { reverb: 'none' } },
  warm: { label: 'Warm & friendly', polish: { bass: 2, mid: -1, presence: 1.5, air: 1, comp: 0.4 }, fx: { reverb: 'studio', reverbMix: 0.1 } },
  radio: { label: 'Radio voice', polish: { bass: 3, mid: -3, presence: 4, air: 3, comp: 0.8 }, fx: { reverb: 'none' } },
  natural: { label: 'Natural (light touch)', polish: { bass: 0, mid: 0, presence: 1, air: 0.5, comp: 0.25 }, fx: { reverb: 'none' } },
  hall: { label: 'Big hall', polish: { bass: 1, mid: -2, presence: 2.5, air: 2, comp: 0.5 }, fx: { reverb: 'hall', reverbMix: 0.18 } },
};

export function withPreset(settings, key) {
  const p = PRESETS[key];
  if (!p) return settings;
  return { ...settings, polish: { ...settings.polish, ...p.polish, preset: key }, fx: { ...settings.fx, ...p.fx } };
}

export const merge = (s = {}) => ({
  clean: { ...DEFAULTS.clean, ...s.clean },
  polish: { ...DEFAULTS.polish, ...s.polish },
  fx: { ...DEFAULTS.fx, ...s.fx },
  mix: { ...DEFAULTS.mix, ...s.mix },
});

/**
 * The full chain. `voice` = the edited take (cuts already applied). `music` = samples of an uploaded music bed.
 * Returns { out, voiceStart, loudness, peakDb, seconds }.
 */
export async function processTake(voice, settings, { music = null, onStep } = {}) {
  const s = merge(settings);
  const step = (name) => onStep?.(name);
  let x = voice;
  if (!x.length) return { out: new Float32Array(0), voiceStart: 0, loudness: -70, peakDb: -Infinity, seconds: 0 };
  step('Cleaning');
  x = await cleanFilters(x, s.clean);
  x = denoise(x, s.clean.noise);
  if (s.clean.trim) x = trimSilence(x);
  if (s.clean.pauses) x = shortenPauses(x);
  step('Pitch & speed');
  x = pitchSpeed(x, s.fx.pitch, s.fx.speed);
  step('EQ & compression');
  x = await eq(x, s.polish);
  x = await compress(x, s.polish.comp);
  step('Effects');
  x = await reverb(x, s.fx.reverb, s.fx.reverbMix);
  x = fades(x, s.fx.fadeIn, s.fx.fadeOut);
  step('Loudness');
  if (s.polish.loud) {
    const now = await lufs(x);
    const gain = db2lin(Math.max(-20, Math.min(30, s.polish.target - now)));
    x = x.map((v) => v * gain);
  }
  step('Mixing');
  const ch = chime(s.mix.chime);
  const lead = ch.length ? Math.max(0, ch.length - Math.round((0.5 - s.mix.gap) * SR)) : 0; // voice starts as the chime rings out
  const tail = Math.round(0.15 * SR);
  const out = new Float32Array(Math.max(lead + x.length, ch.length) + tail);
  const cv = s.mix.chimeVol * Math.max(0.3, peak(x) || 0.5);
  for (let i = 0; i < ch.length; i++) out[i] += ch[i] * cv;
  for (let i = 0; i < x.length; i++) out[lead + i] += x[i];
  if (s.mix.bed !== 'none' && s.mix.bedVol > 0) {
    let bed = s.mix.bed === 'upload' ? music : pad(out.length / SR, s.mix.bed === 'bright');
    if (bed?.length) {
      const fadeN = Math.round(0.3 * SR);
      const vol = s.mix.bedVol * Math.max(0.3, peak(x) || 0.5);
      for (let i = 0; i < out.length; i++) {
        const b = bed[i % bed.length];
        const env = Math.min(1, i / fadeN, (out.length - i) / fadeN);
        out[i] += b * vol * env;
      }
    }
  }
  step('Limiter');
  const y = limit(out, -1);
  return { out: y, voiceStart: lead / SR, loudness: await lufs(y), peakDb: lin2db(peak(y)), seconds: y.length / SR };
}

// ---------------------------------------------------------------- WAV
export function encodeWav(x, rate = SR) {
  const n = x.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Min/max per pixel column, for drawing the waveform. */
export function peaksFor(x, columns) {
  const out = new Float32Array(columns * 2);
  const per = x.length / columns;
  for (let c = 0; c < columns; c++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(c * per);
    const b = Math.min(x.length, Math.floor((c + 1) * per));
    for (let i = a; i < b; i++) {
      if (x[i] < lo) lo = x[i];
      if (x[i] > hi) hi = x[i];
    }
    out[c * 2] = lo;
    out[c * 2 + 1] = hi;
  }
  return out;
}
