/* Chromatic tuner: autocorrelation pitch detection with an adjustable A4
   and instrument presets. */

import { state, save, TUNINGS, clamp } from './store.js';
import { acquire, release, micError } from './mic.js';
import { $, toast } from './ui.js';

const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FFT = 4096;
const WIN = 2048;        // samples used for the correlation
const MIN_HZ = 38, MAX_HZ = 1300;

let analyser = null, buf = null, raf = null, on = false;
let smooth = 0, lastSeen = 0, frameCount = 0;

/* ---------- pitch ---------- */
function detect(data, sr){
  // RMS gate
  let rms = 0;
  for(let i = 0; i < WIN; i++) rms += data[i] * data[i];
  rms = Math.sqrt(rms / WIN);
  if(rms < 0.006) return { hz: -1, rms };

  const minLag = Math.max(2, Math.floor(sr / MAX_HZ));
  const maxLag = Math.min(WIN - 2, Math.ceil(sr / MIN_HZ));

  // energy prefix sums for a normalised correlation
  let best = -1, bestLag = -1;
  const r = new Float32Array(maxLag + 2);
  for(let lag = minLag; lag <= maxLag; lag++){
    let sum = 0, e1 = 0, e2 = 0;
    const n = WIN - lag;
    for(let j = 0; j < n; j++){
      const a = data[j], b = data[j + lag];
      sum += a * b; e1 += a * a; e2 += b * b;
    }
    const denom = Math.sqrt(e1 * e2) || 1e-9;
    const v = sum / denom;
    r[lag] = v;
    if(v > best){ best = v; bestLag = lag; }
  }
  if(bestLag < 0 || best < 0.55) return { hz: -1, rms };

  // octave check: prefer a shorter lag that correlates nearly as well
  for(const k of [2, 3, 4]){
    const cand = Math.round(bestLag / k);
    if(cand >= minLag && r[cand] > best * 0.86){ bestLag = cand; best = r[cand]; }
  }

  // parabolic refinement
  let lag = bestLag;
  const y1 = r[lag - 1] || 0, y2 = r[lag], y3 = r[lag + 1] || 0;
  const denom2 = (y1 + y3 - 2 * y2);
  if(denom2 !== 0) lag = lag - 0.5 * (y3 - y1) / denom2;

  return { hz: sr / lag, rms };
}

/* ---------- note maths ---------- */
export function noteFromHz(hz, a4){
  const n = 12 * Math.log2(hz / a4) + 69;
  const midi = Math.round(n);
  return {
    midi,
    name: NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents: Math.round((n - midi) * 100)
  };
}
function hzFromName(nm, a4){
  const m = /^([A-G]#?)(-?\d)$/.exec(nm);
  if(!m) return 0;
  const idx = NAMES.indexOf(m[1]);
  const midi = idx + (parseInt(m[2], 10) + 1) * 12;
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/* ---------- display ---------- */
function paint(hz){
  const wrap = document.querySelector('.tuner');
  if(hz <= 0){
    if(performance.now() - lastSeen > 700){
      $('tNote').textContent = '—';
      $('tOct').textContent = '';
      $('tCents').textContent = on ? 'play a note' : 'listening for a note';
      $('tFreq').textContent = '—';
      $('needlePin').style.transform = 'translateX(0)';
      wrap.classList.remove('in-tune','sharp','flat');
      markStrings(-1);
    }
    return;
  }
  lastSeen = performance.now();
  const n = noteFromHz(hz, state.a4);
  $('tNote').textContent = n.name;
  $('tOct').textContent = n.octave;
  $('tFreq').textContent = hz.toFixed(1);
  const c = n.cents;
  $('tCents').textContent = (c === 0 ? 'in tune' : (c > 0 ? '+' : '') + c + ' cents');
  const half = $('needle').clientWidth / 2 - 6;
  $('needlePin').style.transform = 'translateX(' + (clamp(c, -50, 50) / 50 * half).toFixed(1) + 'px)';
  wrap.classList.toggle('in-tune', Math.abs(c) <= 5);
  wrap.classList.toggle('sharp', c > 5);
  wrap.classList.toggle('flat', c < -5);
  markStrings(hz);
}

function markStrings(hz){
  const t = TUNINGS.find(x => x.id === state.tuning);
  const box = $('tStrings');
  if(!t || !t.notes.length){ box.textContent = ''; return; }
  if(box.dataset.for !== t.id){
    box.dataset.for = t.id;
    box.textContent = '';
    t.notes.forEach(nm => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.note = nm;
      b.textContent = nm;
      b.title = 'Target ' + hzFromName(nm, state.a4).toFixed(1) + ' Hz';
      box.appendChild(b);
    });
  }
  let nearest = -1, bestCents = 1e9;
  if(hz > 0){
    Array.from(box.children).forEach((b, i) => {
      const target = hzFromName(b.dataset.note, state.a4);
      const cents = Math.abs(1200 * Math.log2(hz / target));
      if(cents < bestCents){ bestCents = cents; nearest = i; }
    });
    if(bestCents > 120) nearest = -1;
  }
  Array.from(box.children).forEach((b, i) => b.classList.toggle('near', i === nearest));
}

/* ---------- loop ---------- */
function loop(){
  if(!on){ raf = null; return; }
  frameCount++;
  if(frameCount % 4 === 0){     // ~15 detections a second is plenty
    analyser.getFloatTimeDomainData(buf);
    const { hz } = detect(buf, analyser.context.sampleRate);
    if(hz > 0){
      smooth = smooth > 0 ? smooth * 0.72 + hz * 0.28 : hz;
      paint(smooth);
    }else{
      paint(-1);
    }
  }
  raf = requestAnimationFrame(loop);
}

async function start(){
  try{
    analyser = await acquire(FFT);
    buf = new Float32Array(analyser.fftSize);
    on = true; smooth = 0;
    $('tunerBtn').textContent = 'Stop mic';
    $('tunerBtn').dataset.on = 'true';
    raf = requestAnimationFrame(loop);
  }catch(err){
    toast(micError(err));
  }
}
function stop(){
  on = false;
  if(raf) cancelAnimationFrame(raf);
  raf = null;
  release(analyser);
  analyser = null;
  $('tunerBtn').textContent = 'Start mic';
  $('tunerBtn').dataset.on = 'false';
  paint(-1);
}
export function stopTuner(){ if(on) stop(); }

/* ---------- init ---------- */
export function initTuner(){
  const sel = $('tunePreset');
  TUNINGS.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  });
  sel.value = state.tuning;
  sel.addEventListener('change', e => {
    state.tuning = e.target.value;
    $('tStrings').dataset.for = '';
    markStrings(-1);
    save();
  });

  $('a4Range').value = state.a4;
  $('a4Val').textContent = state.a4;
  $('a4Range').addEventListener('input', e => {
    state.a4 = +e.target.value;
    $('a4Val').textContent = state.a4;
    $('tStrings').dataset.for = '';
    markStrings(-1);
    save();
  });
  $('a4Reset').addEventListener('click', () => {
    state.a4 = 440;
    $('a4Range').value = 440;
    $('a4Val').textContent = 440;
    $('tStrings').dataset.for = '';
    markStrings(-1);
    save();
  });

  $('tunerBtn').addEventListener('click', () => on ? stop() : start());
  markStrings(-1);
}
