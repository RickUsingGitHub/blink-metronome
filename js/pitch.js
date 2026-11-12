/* Pitch detection — McLeod (NSDF) on a decimated signal.

   Pure functions: no DOM and no audio API, so the same code runs in the page
   and under node in tests/pitch.test.js.

   Decimating to ~12 kHz first is what makes this cheap enough to run thirty
   times a second on a phone: a guitar's top string is 330 Hz, so everything
   above a few kHz is only harmonics the correlation does not need, and the
   lag search shrinks with the sample rate. */

const TARGET_SR = 12000;
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

let scratch = null, nsdf = null;

export function detectPitch(input, sampleRate, opts){
  const o = opts || {};
  const minHz = o.minHz || 38;
  const maxHz = o.maxHz || 1350;
  const gate  = o.gate === undefined ? 0.0035 : o.gate;
  const minClarity = o.minClarity === undefined ? 0.5 : o.minClarity;

  const len = input.length;
  let rms = 0;
  for(let i = 0; i < len; i++) rms += input[i] * input[i];
  rms = Math.sqrt(rms / len);
  if(rms < gate) return { hz: 0, clarity: 0, rms };

  /* ---- decimate: box-average `factor` samples, which also anti-aliases ---- */
  const factor = Math.max(1, Math.round(sampleRate / TARGET_SR));
  const sr = sampleRate / factor;
  const N = Math.floor(len / factor);
  if(N < 128) return { hz: 0, clarity: 0, rms };

  if(!scratch || scratch.length < N) scratch = new Float32Array(N);
  const x = scratch;
  for(let i = 0; i < N; i++){
    let s = 0;
    const base = i * factor;
    for(let k = 0; k < factor; k++) s += input[base + k];
    x[i] = s / factor;
  }
  let mean = 0;
  for(let i = 0; i < N; i++) mean += x[i];
  mean /= N;
  for(let i = 0; i < N; i++) x[i] -= mean;

  const minLag = Math.max(2, Math.floor(sr / maxHz));
  const maxLag = Math.min(N - 2, Math.ceil(sr / minHz));
  if(maxLag <= minLag + 2) return { hz: 0, clarity: 0, rms };

  /* ---- normalised square difference ---- */
  if(!nsdf || nsdf.length < maxLag + 2) nsdf = new Float32Array(maxLag + 2);
  const n = nsdf;
  for(let tau = 0; tau <= maxLag; tau++){
    let ac = 0, m = 0;
    const lim = N - tau;
    for(let i = 0; i < lim; i++){
      const a = x[i], b = x[i + tau];
      ac += a * b;
      m += a * a + b * b;
    }
    n[tau] = m > 0 ? (2 * ac) / m : 0;
  }

  /* ---- first peak that is nearly as strong as the strongest ----
     This is what keeps it off the octave below: that lag also correlates
     well, but it is never the first such peak. */
  let tau0 = 1;
  while(tau0 < maxLag && n[tau0] > 0) tau0++;      // past the lobe around zero
  const from = Math.max(tau0 + 1, minLag + 1);

  let best = 0;
  const peaks = [];
  for(let t = from; t < maxLag; t++){
    if(n[t] > 0.3 && n[t] > n[t - 1] && n[t] >= n[t + 1]){
      peaks.push(t);
      if(n[t] > best) best = n[t];
    }
  }
  if(!peaks.length) return { hz: 0, clarity: 0, rms };

  const k = o.k === undefined ? 0.9 : o.k;
  const floor = best * k;
  let chosen = peaks[0];
  for(let i = 0; i < peaks.length; i++){
    if(n[peaks[i]] >= floor){ chosen = peaks[i]; break; }
  }

  /* ---- parabolic refinement around the chosen lag ---- */
  const y1 = n[chosen - 1], y2 = n[chosen], y3 = n[chosen + 1];
  const d = y1 + y3 - 2 * y2;
  const lag = d !== 0 ? chosen - 0.5 * (y3 - y1) / d : chosen;

  const clarity = y2;
  let hz = sr / lag;
  if(!(hz > minHz) || hz > maxHz || clarity < minClarity) return { hz: 0, clarity, rms };

  /* Decimation costs resolution: near the top of the range one lag step is
     several cents, which a tuner cannot afford. Re-correlate at the full rate
     over a narrow band around the lag we already found. */
  hz = refine(input, sampleRate, hz, mean);
  return { hz, clarity, rms };
}

function refine(input, sampleRate, hz, dc){
  const len = input.length;
  const L = sampleRate / hz;
  const lo = Math.max(2, Math.floor(L * 0.97));
  const hi = Math.min(len - 2, Math.ceil(L * 1.03) + 1);
  if(hi <= lo + 2) return hz;

  let best = -Infinity, bestTau = -1;
  const vals = new Float32Array(hi - lo + 2);
  for(let tau = lo; tau <= hi; tau++){
    let ac = 0, m = 0;
    const lim = len - tau;
    for(let i = 0; i < lim; i++){
      const a = input[i] - dc, b = input[i + tau] - dc;
      ac += a * b;
      m += a * a + b * b;
    }
    const v = m > 0 ? (2 * ac) / m : 0;
    vals[tau - lo] = v;
    if(v > best){ best = v; bestTau = tau; }
  }
  if(bestTau < 0) return hz;

  const i = bestTau - lo;
  const y1 = i > 0 ? vals[i - 1] : vals[i];
  const y2 = vals[i];
  const y3 = vals[i + 1] !== undefined ? vals[i + 1] : vals[i];
  const d = y1 + y3 - 2 * y2;
  const lag = d !== 0 ? bestTau - 0.5 * (y3 - y1) / d : bestTau;
  const out = sampleRate / lag;
  // only trust the refinement if it stayed near the coarse estimate
  return Math.abs(1200 * Math.log2(out / hz)) < 60 ? out : hz;
}

/* ---------- note maths ---------- */
export function noteFromHz(hz, a4){
  const v = 12 * Math.log2(hz / a4) + 69;
  const midi = Math.round(v);
  return {
    midi,
    name: NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents: (v - midi) * 100,
    target: a4 * Math.pow(2, (midi - 69) / 12)
  };
}

export function hzFromName(name, a4){
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  if(!m) return 0;
  const idx = NAMES.indexOf(m[1]);
  if(idx < 0) return 0;
  const midi = idx + (parseInt(m[2], 10) + 1) * 12;
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export const NOTE_NAMES = NAMES;
