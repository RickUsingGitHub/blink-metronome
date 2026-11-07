/* Sound level meter: RMS in dB with peak hold, running stats and a scrolling
   graph. Phone mics are not calibrated instruments, so an offset slider lets
   you line it up against a real meter. */

import { state, save } from './store.js';
import { acquire, release, micError } from './mic.js';
import { $, toast } from './ui.js';

const FLOOR = 25, CEIL = 120;      // display range in dB

let analyser = null, buf = null, raf = null, on = false;
let min = Infinity, max = -Infinity, sum = 0, count = 0;
let peak = -Infinity, peakAt = 0;
let history = [];
let cv = null, cx = null;

function dbFromRms(rms){
  if(rms <= 0) return FLOOR;
  // 94 dB SPL is the usual reference for full-scale on a phone capsule
  return 20 * Math.log10(rms) + 94 + state.lvCal;
}

function paint(db){
  const shown = Math.max(FLOOR, Math.min(CEIL, db));
  $('lvNow').textContent = Math.round(shown);
  const pct = (shown - FLOOR) / (CEIL - FLOOR);
  $('lvFill').style.right = ((1 - pct) * 100).toFixed(1) + '%';

  if(db > peak || performance.now() - peakAt > 1500){
    if(db > peak || db > FLOOR){ peak = Math.max(db, FLOOR); peakAt = performance.now(); }
  }
  const ppct = (Math.max(FLOOR, Math.min(CEIL, peak)) - FLOOR) / (CEIL - FLOOR);
  $('lvPeak').style.left = (ppct * 100).toFixed(1) + '%';

  $('lvMin').textContent = min === Infinity ? '—' : Math.round(min);
  $('lvMax').textContent = max === -Infinity ? '—' : Math.round(max);
  $('lvAvg').textContent = count ? Math.round(sum / count) : '—';
}

function drawGraph(){
  if(!cx) return;
  const w = cv.width, h = cv.height;
  const css = getComputedStyle(document.documentElement);
  cx.clearRect(0, 0, w, h);

  cx.strokeStyle = css.getPropertyValue('--line').trim() || '#2a323e';
  cx.lineWidth = 1;
  for(let db = 40; db <= 110; db += 20){
    const y = h - ((db - FLOOR) / (CEIL - FLOOR)) * h;
    cx.beginPath(); cx.moveTo(0, y); cx.lineTo(w, y); cx.stroke();
    cx.fillStyle = css.getPropertyValue('--faint').trim() || '#5b6878';
    cx.font = '11px system-ui, sans-serif';
    cx.fillText(db + '', 4, y - 3);
  }

  if(history.length > 1){
    cx.strokeStyle = css.getPropertyValue('--beat').trim() || '#5fd0ff';
    cx.lineWidth = 2;
    cx.beginPath();
    const n = history.length;
    history.forEach((db, i) => {
      const x = (i / (n - 1)) * w;
      const y = h - ((Math.max(FLOOR, Math.min(CEIL, db)) - FLOOR) / (CEIL - FLOOR)) * h;
      i ? cx.lineTo(x, y) : cx.moveTo(x, y);
    });
    cx.stroke();
  }
}

let frames = 0;
function loop(){
  if(!on){ raf = null; return; }
  analyser.getFloatTimeDomainData(buf);
  let rms = 0;
  for(let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  const db = dbFromRms(rms);

  if(db > FLOOR + 0.5){
    min = Math.min(min, db);
    max = Math.max(max, db);
    sum += db; count++;
  }
  paint(db);

  if(++frames % 6 === 0){
    history.push(db);
    if(history.length > 240) history.shift();
    drawGraph();
  }
  raf = requestAnimationFrame(loop);
}

async function start(){
  try{
    analyser = await acquire(2048);
    buf = new Float32Array(analyser.fftSize);
    on = true;
    $('levelsBtn').textContent = 'Stop mic';
    $('levelsBtn').dataset.on = 'true';
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
  $('levelsBtn').textContent = 'Start mic';
  $('levelsBtn').dataset.on = 'false';
}
export function stopLevels(){ if(on) stop(); }

function reset(){
  min = Infinity; max = -Infinity; sum = 0; count = 0;
  peak = -Infinity; history = [];
  $('lvNow').textContent = '—';
  $('lvFill').style.right = '100%';
  $('lvPeak').style.left = '0%';
  paint(FLOOR);
  drawGraph();
}

export function initLevels(){
  cv = $('lvGraph');
  cx = cv.getContext('2d');
  const fit = () => {
    const r = cv.getBoundingClientRect();
    if(r.width){
      cv.width = Math.round(r.width * (window.devicePixelRatio || 1));
      cv.height = Math.round(r.height * (window.devicePixelRatio || 1));
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.scale(cv.width / r.width, cv.height / r.height);
      cv.width = Math.round(r.width); cv.height = Math.round(r.height);
    }
    drawGraph();
  };
  window.addEventListener('resize', fit);
  setTimeout(fit, 60);

  $('levelsBtn').addEventListener('click', () => on ? stop() : start());
  $('lvReset').addEventListener('click', reset);
  $('lvCal').value = state.lvCal;
  $('lvCalVal').textContent = state.lvCal;
  $('lvCal').addEventListener('input', e => {
    state.lvCal = +e.target.value;
    $('lvCalVal').textContent = state.lvCal;
    save();
  });
  reset();
}
