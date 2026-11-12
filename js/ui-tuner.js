/* Chromatic tuner: listens continuously and keeps reading the note being
   played, shown on a needle gauge and a strobe.

   The strobe is the honest kind — the bands drift at the beat frequency
   between what you are playing and the note you are aiming at, so they stand
   still exactly when you are in tune, and the drift tells you which way to go. */

import { state, save, TUNINGS, clamp } from './store.js';
import { detectPitch, noteFromHz, hzFromName } from './pitch.js';
import { acquire, release, micError } from './mic.js';
import { $, toast } from './ui.js';

const FFT = 4096;
const SPAN = 50;          // cents shown either side of centre
const SWEEP = 55;         // degrees either side of vertical
const HOLD_MS = 1600;     // how long a note stays on screen after it dies away

let analyser = null, buf = null, raf = null, timer = null, on = false;
let smoothHz = 0, lastPitchAt = 0, lastFrame = 0;
let shownCents = 0, phase = 0, lockedSince = 0;
let cv = null, cx = null;

/* ---------------- gauge furniture ---------------- */
const rad = d => d * Math.PI / 180;
const px = (r, deg) => [150 + r * Math.sin(rad(deg)), 146 - r * Math.cos(rad(deg))];
const centsToDeg = c => clamp(c, -SPAN, SPAN) / SPAN * SWEEP;

function arc(r, c1, c2, cls){
  const [x1, y1] = px(r, centsToDeg(c1));
  const [x2, y2] = px(r, centsToDeg(c2));
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M ' + x1.toFixed(2) + ' ' + y1.toFixed(2) +
                      ' A ' + r + ' ' + r + ' 0 0 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2));
  p.setAttribute('class', 'zone ' + cls);
  return p;
}

function buildGauge(){
  const zones = $('gaugeZones');
  if(zones.childElementCount) return;
  zones.appendChild(arc(114, -50, -20, 'far'));
  zones.appendChild(arc(114, -20, -5, 'near'));
  zones.appendChild(arc(114, -5, 5, 'ok'));
  zones.appendChild(arc(114, 5, 20, 'near'));
  zones.appendChild(arc(114, 20, 50, 'far'));

  const ticks = $('gaugeTicks');
  for(let c = -50; c <= 50; c += 2){
    const major = c % 10 === 0;
    const deg = centsToDeg(c);
    const [x1, y1] = px(major ? 97 : 103, deg);
    const [x2, y2] = px(108, deg);
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('x1', x1.toFixed(2)); ln.setAttribute('y1', y1.toFixed(2));
    ln.setAttribute('x2', x2.toFixed(2)); ln.setAttribute('y2', y2.toFixed(2));
    ln.setAttribute('class', 'tick' + (major ? ' major' : ''));
    ticks.appendChild(ln);
    if(major && c !== 0){
      const [lx, ly] = px(84, deg);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', lx.toFixed(2));
      t.setAttribute('y', (ly + 4).toFixed(2));
      t.setAttribute('class', 'tlabel');
      t.textContent = (c > 0 ? '+' : '') + c;
      ticks.appendChild(t);
    }
  }
}

/* ---------------- strobe ---------------- */
function fitStrobe(){
  cv = $('strobe');
  cx = cv.getContext('2d');
  const r = cv.getBoundingClientRect();
  if(!r.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
}

function drawStrobe(cents, live){
  if(!cx) return;
  const W = cv.width, H = cv.height;
  const css = getComputedStyle(document.documentElement);
  cx.clearRect(0, 0, W, H);
  cx.fillStyle = css.getPropertyValue('--panel-2').trim() || '#1b212b';
  cx.fillRect(0, 0, W, H);

  const inTune = live && Math.abs(cents) <= 3;
  const colour = !live ? (css.getPropertyValue('--line').trim() || '#2a323e')
               : inTune ? (css.getPropertyValue('--mute').trim() || '#7ef0b0')
               : (css.getPropertyValue('--accent').trim() || '#ffc83d');

  const period = Math.max(26, Math.round(W / 14));
  const off = (((phase % 1) + 1) % 1) * period;
  cx.fillStyle = colour;
  cx.globalAlpha = live ? 0.92 : 0.3;
  for(let x = -period + off; x < W + period; x += period){
    cx.fillRect(Math.round(x), 0, Math.round(period * 0.5), H);
  }
  cx.globalAlpha = 1;

  // centre reference
  cx.fillStyle = css.getPropertyValue('--fg').trim() || '#e9eef6';
  cx.globalAlpha = 0.5;
  cx.fillRect(Math.round(W / 2) - 1, 0, 2, H);
  cx.globalAlpha = 1;
}

/* ---------------- readout ---------------- */
function showNote(n, hz){
  $('tNote').textContent = n.name;
  $('tOct').textContent = n.octave;
  $('tFreq').textContent = hz.toFixed(1);
  $('tTarget').textContent = n.target.toFixed(1) + ' Hz';
  const c = Math.round(shownCents);
  $('tCents').textContent = c === 0 ? 'bang on'
    : (c > 0 ? '+' : '') + c + ' cent' + (Math.abs(c) === 1 ? '' : 's') +
      (c > 0 ? ' sharp' : ' flat');
}

function clearNote(){
  $('tNote').textContent = '—';
  $('tOct').textContent = '';
  $('tFreq').textContent = '—';
  $('tTarget').textContent = '—';
  $('tCents').textContent = on ? 'listening…' : 'tap below to start listening';
  $('tLock').hidden = true;
  shownCents = 0;
  $('gaugeNeedle').style.transform = 'rotate(0deg)';
  drawStrobe(0, false);
  markStrings(0);
}

function markStrings(hz){
  const t = TUNINGS.find(x => x.id === state.tuning);
  const box = $('tStrings');
  if(!t || !t.notes.length){ box.textContent = ''; box.dataset.for = ''; return; }
  const key = t.id + '@' + state.a4;
  if(box.dataset.for !== key){
    box.dataset.for = key;
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
    if(bestCents > 140) nearest = -1;
  }
  Array.from(box.children).forEach((b, i) => b.classList.toggle('near', i === nearest));
}

/* ---------------- loop ----------------
   Listening runs on a timer and drawing on requestAnimationFrame. Keeping
   them apart matters: rAF is paused whenever the page is not being painted,
   and the reading should not depend on the animation being scheduled. */
let beatHz = 0;

function sample(){
  if(!on || !analyser) return;
  try{
    analyser.getFloatTimeDomainData(buf);
    const { hz } = detectPitch(buf, analyser.context.sampleRate);
    const now = performance.now();
    if(hz > 0){
      if(!smoothHz || Math.abs(1200 * Math.log2(hz / smoothHz)) > 220){
        smoothHz = hz;                                 // a different note: jump
      }else{
        smoothHz = Math.exp(Math.log(smoothHz) * 0.7 + Math.log(hz) * 0.3);
      }
      lastPitchAt = now;
    }

    const age = now - lastPitchAt;
    const live = smoothHz > 0 && age < HOLD_MS;
    const card = $('tunerCard');

    if(live){
      const n = noteFromHz(smoothHz, state.a4);
      shownCents = shownCents * 0.72 + n.cents * 0.28;
      showNote(n, smoothHz);
      markStrings(smoothHz);

      const locked = Math.abs(shownCents) <= 3;
      if(locked){ if(!lockedSince) lockedSince = now; }else{ lockedSince = 0; }
      $('tLock').hidden = !(lockedSince && now - lockedSince > 250);

      card.classList.toggle('locked', locked);
      card.classList.toggle('quiet', age > 400);
      $('gaugeNeedle').style.transform = 'rotate(' + centsToDeg(shownCents).toFixed(2) + 'deg)';

      // what a strobe actually shows: the beat against the note you are aiming at
      beatHz = clamp(n.target * (Math.pow(2, shownCents / 1200) - 1), -10, 10);
    }else if(smoothHz){
      smoothHz = 0; lockedSince = 0; beatHz = 0;
      card.classList.remove('locked', 'quiet');
      clearNote();
    }
  }catch(err){
    console.error('[tuner]', err);     // never let one bad read stop the tuner
  }
}

function draw(now){
  if(!on){ raf = null; return; }
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  try{
    const live = smoothHz > 0;
    if(live) phase += beatHz * dt;
    drawStrobe(shownCents, live);
  }catch(err){
    console.error('[tuner]', err);
  }
  raf = requestAnimationFrame(draw);
}

/* ---------------- start / stop ---------------- */
async function start(){
  if(on) return;
  try{
    analyser = await acquire(FFT);
    buf = new Float32Array(analyser.fftSize);
    on = true;
    smoothHz = 0; lastPitchAt = 0; lastFrame = 0; phase = 0; lockedSince = 0; beatHz = 0;
    paintButtons();
    fitStrobe();
    clearNote();
    timer = setInterval(sample, 33);
    raf = requestAnimationFrame(draw);
  }catch(err){
    on = false;
    paintButtons();
    toast(micError(err));
  }
}

function stop(){
  on = false;
  if(timer) clearInterval(timer);
  timer = null;
  if(raf) cancelAnimationFrame(raf);
  raf = null;
  release(analyser);
  analyser = null;
  smoothHz = 0;
  paintButtons();
  clearNote();
}

function paintButtons(){
  $('tunerBtn').textContent = on ? 'Stop mic' : 'Start mic';
  $('tunerBtn').dataset.on = String(on);
  $('tunerStart').hidden = on;
  $('strobeHint').textContent = on
    ? 'flat ◀ bands drift ▶ sharp'
    : 'the bands stand still when you are in tune';
}

export function stopTuner(){ if(on) stop(); }
export function tunerRunning(){ return on; }

/* the canvas has no size while the tab is hidden, so measure it on the way in */
export function tunerShown(){
  fitStrobe();
  drawStrobe(shownCents, on && smoothHz > 0);
}

/* ---------------- init ---------------- */
export function initTuner(){
  buildGauge();
  fitStrobe();
  window.addEventListener('resize', () => { fitStrobe(); drawStrobe(shownCents, on && smoothHz > 0); });

  const sel = $('tunePreset');
  TUNINGS.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  });
  sel.value = state.tuning;
  sel.addEventListener('change', e => {
    state.tuning = e.target.value;
    markStrings(smoothHz);
    save();
  });

  $('a4Range').value = state.a4;
  $('a4Val').textContent = state.a4;
  $('a4Range').addEventListener('input', e => {
    state.a4 = +e.target.value;
    $('a4Val').textContent = state.a4;
    markStrings(smoothHz);
    save();
  });
  $('a4Reset').addEventListener('click', () => {
    state.a4 = 440;
    $('a4Range').value = 440;
    $('a4Val').textContent = 440;
    markStrings(smoothHz);
    save();
  });

  $('tunerBtn').addEventListener('click', () => on ? stop() : start());
  $('tunerStart').addEventListener('click', start);

  paintButtons();
  clearNote();
}
