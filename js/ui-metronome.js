/* The metronome tab: tempo dial, signature, subdivisions, beat pattern,
   sound library, flash settings, practice tools. */

import {
  state, bus, save, SUBS, SOUNDS, MODES, MODE_LABEL,
  subById, tempoMark, clamp, fmtTime, fixPattern
} from './store.js';
import { engine, previewSound } from './audio.js';
import { $, $$, toast, repeat, segment, segmentSet } from './ui.js';
import { testFlash } from './flash.js';

let saveTimer = null;
function queueSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }

/* ---------------- tempo ---------------- */
export function setBpm(v, quiet){
  state.bpm = clamp(Math.round(v), 20, 400);
  $('bpmNum').textContent = state.bpm;
  $('bpmRange').value = state.bpm;
  $('tempoMark').textContent = tempoMark(state.bpm);
  $('dial').setAttribute('aria-valuenow', state.bpm);
  paintTicks();
  if(!quiet) queueSave();
}

function paintTicks(){
  const g = $('dialTicks');
  if(!g.childElementCount){
    const N = 44;
    for(let i = 0; i < N; i++){
      const a = (-210 + (i / (N - 1)) * 240) * Math.PI / 180;
      const r1 = 84, r2 = 93;
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', (100 + Math.cos(a) * r1).toFixed(2));
      ln.setAttribute('y1', (100 + Math.sin(a) * r1).toFixed(2));
      ln.setAttribute('x2', (100 + Math.cos(a) * r2).toFixed(2));
      ln.setAttribute('y2', (100 + Math.sin(a) * r2).toFixed(2));
      g.appendChild(ln);
    }
  }
  const kids = g.children;
  const lit = Math.round((state.bpm - 20) / 380 * kids.length);
  for(let i = 0; i < kids.length; i++) kids[i].classList.toggle('on', i < lit);
}

/* rotary drag on the dial */
function initDial(){
  const dial = $('dial');
  let dragging = false, lastAngle = 0, acc = 0;
  const angleAt = ev => {
    const r = dial.getBoundingClientRect();
    return Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  dial.addEventListener('pointerdown', ev => {
    dragging = true; acc = 0; lastAngle = angleAt(ev);
    dial.setPointerCapture(ev.pointerId);
  });
  dial.addEventListener('pointermove', ev => {
    if(!dragging) return;
    const a = angleAt(ev);
    let d = a - lastAngle;
    if(d > 180) d -= 360;
    if(d < -180) d += 360;
    lastAngle = a;
    acc += d;
    const steps = Math.trunc(acc / 3.5);
    if(steps){ acc -= steps * 3.5; setBpm(state.bpm + steps); }
  });
  const end = ev => {
    if(!dragging) return;
    dragging = false;
    try{ dial.releasePointerCapture(ev.pointerId); }catch(err){}
  };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('keydown', ev => {
    const big = ev.shiftKey ? 10 : 1;
    if(ev.key === 'ArrowUp' || ev.key === 'ArrowRight'){ ev.preventDefault(); setBpm(state.bpm + big); }
    else if(ev.key === 'ArrowDown' || ev.key === 'ArrowLeft'){ ev.preventDefault(); setBpm(state.bpm - big); }
  });
}

/* ---------------- signature & subdivisions ---------------- */
export function setNum(n){
  state.num = clamp(n, 1, 32);
  fixPattern();
  $('numVal').textContent = state.num;
  buildBeatGrid();
  updateReadout(null);
  queueSave();
}

function buildSubRow(){
  const row = $('subRow');
  row.textContent = '';
  SUBS.forEach(s => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.sub = s.id;
    b.textContent = s.label;
    b.title = s.name;
    b.setAttribute('aria-label', s.name);
    b.setAttribute('aria-pressed', String(s.id === state.sub));
    row.appendChild(b);
  });
  row.onclick = ev => {
    const b = ev.target.closest('button');
    if(!b) return;
    state.sub = b.dataset.sub;
    $$('button', row).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    queueSave();
  };
}

/* ---------------- beat pattern ---------------- */
function buildBeatGrid(){
  const grid = $('beatGrid');
  grid.textContent = '';
  for(let i = 0; i < state.num; i++){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'beatbtn';
    b.dataset.i = i;
    b.dataset.mode = state.pattern[i];
    b.innerHTML = '<span class="n">' + (i + 1) + '</span>' +
                  '<span class="m">' + MODE_LABEL[state.pattern[i]] + '</span>' +
                  '<span class="dot"></span>';
    b.setAttribute('aria-label', 'Beat ' + (i + 1) + ': ' + MODE_LABEL[state.pattern[i]]);
    grid.appendChild(b);
  }
}
function paintBeat(i){
  const b = $('beatGrid').children[i];
  if(!b) return;
  b.dataset.mode = state.pattern[i];
  b.querySelector('.m').textContent = MODE_LABEL[state.pattern[i]];
  b.setAttribute('aria-label', 'Beat ' + (i + 1) + ': ' + MODE_LABEL[state.pattern[i]]);
}

let markedBeat = -1;
function markBeat(i){
  const kids = $('beatGrid').children;
  if(markedBeat >= 0 && kids[markedBeat]) kids[markedBeat].classList.remove('now');
  if(i >= 0 && kids[i]) kids[i].classList.add('now');
  markedBeat = i;
}

/* ---------------- readouts ---------------- */
function updateReadout(e){
  if(!e){
    $('roBeat').textContent = '1 / ' + state.num;
    $('roBar').textContent = 'bar 1';
    $('roGap').hidden = true;
    return;
  }
  $('roBeat').textContent = (e.beat + 1) + ' / ' + state.num;
  $('roBar').textContent = e.bar < 0 ? 'count-in' : 'bar ' + (e.bar + 1);
  $('roGap').hidden = !e.muted;
}

function updateStats(){
  $('statToday').textContent = fmtTime(state.stats.today);
  $('statTotal').textContent = fmtTime(state.stats.total);
}

/* ---------------- sound ---------------- */
function buildSoundRow(){
  const row = $('soundRow');
  row.textContent = '';
  SOUNDS.forEach(s => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.sound = s.id;
    b.textContent = s.name;
    b.setAttribute('aria-pressed', String(s.id === state.soundId));
    row.appendChild(b);
  });
  row.onclick = ev => {
    const b = ev.target.closest('button');
    if(!b) return;
    state.soundId = b.dataset.sound;
    $$('button', row).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    previewSound(state.soundId);
    sumSound();
    queueSave();
  };
}
function sumSound(){
  const s = SOUNDS.find(x => x.id === state.soundId);
  $('sumSound').textContent = (s ? s.name : '—') + ' · ' + state.vol + '%';
}
function sumFlash(){
  const where = state.flashTarget === 'screen' ? 'Whole screen'
              : state.flashTarget === 'dial' ? 'Dial only' : 'Off';
  $('sumFlash').textContent = where + (state.flashTarget === 'off' ? '' : ' · ' + state.bright + '%');
}
function sumPractice(){
  const bits = [];
  if(state.countIn) bits.push(state.countIn + '-bar count-in');
  if(state.gapOn) bits.push('gap ' + state.gapPlay + '/' + state.gapMute);
  if(state.rampOn) bits.push('ramp to ' + state.rampTo);
  $('sumPractice').textContent = bits.length ? bits.join(' · ') : 'Off';
}

/* ---------------- silent switch ---------------- */
function paintSound(){
  const sw = $('soundSw');
  sw.setAttribute('aria-checked', String(state.soundOn));
  sw.setAttribute('aria-label', state.soundOn ? 'Clicks on' : 'Clicks off');
  $('soundTitle').textContent = state.soundOn ? 'Clicks on' : 'Silent — flash only';
  $('soundSub').textContent = state.soundOn
    ? 'Beats flash as well. Switch off for a silent count.'
    : 'The bar keeps running. Watch the flashes.';
}

/* ---------------- full refresh (used after loading a song) ---------------- */
export function refreshMetronome(){
  setBpm(state.bpm, true);
  $('numVal').textContent = state.num;
  segmentSet($('denSeg'), 'den', state.den);
  fixPattern();
  buildBeatGrid();
  buildSubRow();
  $$('#soundRow button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sound === state.soundId)));
  paintSound();
  sumSound(); sumFlash(); sumPractice();
  $('volRange').value = state.vol; $('volVal').textContent = state.vol;
  $('brightRange').value = state.bright; $('brightVal').textContent = state.bright;
  $('holdRange').value = state.hold; $('holdVal').textContent = state.hold + '%';
  $('colAccent').value = state.colAccent;
  $('colBeat').value = state.colBeat;
  $('subFlashChk').checked = state.subFlash;
  $('vibChk').checked = state.vibrate;
  segmentSet($('targetSeg'), 'target', state.flashTarget);
  segmentSet($('countInSeg'), 'ci', state.countIn);
  $('gapChk').checked = state.gapOn;
  $('gapPlayVal').textContent = state.gapPlay;
  $('gapMuteVal').textContent = state.gapMute;
  $('gapFlashChk').checked = state.gapFlash;
  $('rampChk').checked = state.rampOn;
  $('rampByVal').textContent = state.rampBy;
  $('rampEveryVal').textContent = state.rampEvery;
  $('rampToVal').textContent = state.rampTo;
  $('rampToRange').value = state.rampTo;
  updateReadout(null);
  updateStats();
}

/* ---------------- tap tempo ---------------- */
let taps = [];
function tap(){
  const now = performance.now();
  if(taps.length && now - taps[taps.length - 1] > 2400) taps = [];
  taps.push(now);
  if(taps.length > 8) taps.shift();
  if(taps.length >= 2){
    let sum = 0;
    for(let i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1];
    setBpm(60000 / (sum / (taps.length - 1)));
  }
  $('tapBtn').textContent = taps.length < 2 ? 'Tap…' : 'Tap';
  clearTimeout(tap._t);
  tap._t = setTimeout(() => { $('tapBtn').textContent = 'Tap'; }, 2500);
}

/* ---------------- init ---------------- */
export function initMetronome(){
  initDial();
  buildSubRow();
  buildSoundRow();
  buildBeatGrid();

  /* tempo */
  $('bpmRange').addEventListener('input', e => setBpm(+e.target.value));
  repeat($('bpmMinus'), () => setBpm(state.bpm - 1));
  repeat($('bpmPlus'),  () => setBpm(state.bpm + 1));
  $('tapBtn').addEventListener('click', tap);

  /* signature */
  $('numMinus').addEventListener('click', () => setNum(state.num - 1));
  $('numPlus').addEventListener('click',  () => setNum(state.num + 1));
  segment($('denSeg'), 'den', v => {
    state.den = +v;
    segmentSet($('denSeg'), 'den', state.den);
    queueSave();
  });

  /* beat pattern */
  $('beatGrid').addEventListener('click', ev => {
    const b = ev.target.closest('.beatbtn');
    if(!b) return;
    const i = +b.dataset.i;
    state.pattern[i] = MODES[(MODES.indexOf(state.pattern[i]) + 1) % MODES.length];
    paintBeat(i);
    queueSave();
  });
  $('patAllFlash').addEventListener('click', () => {
    state.pattern = state.pattern.map(() => 'flash');
    buildBeatGrid();
    toast('Every beat flashes, nothing clicks');
    queueSave();
  });
  $('patReset').addEventListener('click', () => {
    state.pattern = state.pattern.map((m, i) => i === 0 ? 'accent' : 'on');
    buildBeatGrid();
    queueSave();
  });

  /* silent switch */
  $('soundSw').addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    paintSound();
    save();
  });

  /* sound */
  $('volRange').addEventListener('input', e => {
    state.vol = +e.target.value;
    $('volVal').textContent = state.vol;
    sumSound();
    queueSave();
  });
  $('vibChk').addEventListener('change', e => {
    state.vibrate = e.target.checked;
    if(state.vibrate && !navigator.vibrate) toast('This browser has no vibration — iPhones never do');
    else if(state.vibrate && navigator.vibrate){ try{ navigator.vibrate(30); }catch(err){} }
    save();
  });
  $('vibNote').textContent = navigator.vibrate ? '' : 'not supported here';

  /* flash */
  segment($('targetSeg'), 'target', v => {
    state.flashTarget = v;
    segmentSet($('targetSeg'), 'target', v);
    sumFlash();
    if(v !== 'off') testFlash('accent');
    save();
  });
  $('brightRange').addEventListener('input', e => {
    state.bright = +e.target.value;
    $('brightVal').textContent = state.bright;
    sumFlash();
    if(!engine.running) testFlash('on');
    queueSave();
  });
  $('holdRange').addEventListener('input', e => {
    state.hold = +e.target.value;
    $('holdVal').textContent = state.hold + '%';
    if(!engine.running) testFlash('on');
    queueSave();
  });
  $('colAccent').addEventListener('input', e => {
    state.colAccent = e.target.value;
    if(!engine.running) testFlash('accent');
    queueSave();
  });
  $('colBeat').addEventListener('input', e => {
    state.colBeat = e.target.value;
    if(!engine.running) testFlash('on');
    queueSave();
  });
  $('subFlashChk').addEventListener('change', e => { state.subFlash = e.target.checked; save(); });

  /* practice */
  segment($('countInSeg'), 'ci', v => {
    state.countIn = +v;
    segmentSet($('countInSeg'), 'ci', v);
    sumPractice();
    save();
  });
  $('gapChk').addEventListener('change', e => { state.gapOn = e.target.checked; sumPractice(); save(); });
  $('gapFlashChk').addEventListener('change', e => { state.gapFlash = e.target.checked; save(); });
  const bump = (key, el, lo, hi) => d => {
    state[key] = clamp(state[key] + d, lo, hi);
    $(el).textContent = state[key];
    sumPractice();
    queueSave();
  };
  const gp = bump('gapPlay', 'gapPlayVal', 1, 16);
  const gm = bump('gapMute', 'gapMuteVal', 1, 16);
  $('gapPlayMinus').addEventListener('click', () => gp(-1));
  $('gapPlayPlus').addEventListener('click',  () => gp(1));
  $('gapMuteMinus').addEventListener('click', () => gm(-1));
  $('gapMutePlus').addEventListener('click',  () => gm(1));

  $('rampChk').addEventListener('change', e => { state.rampOn = e.target.checked; sumPractice(); save(); });
  const rb = bump('rampBy', 'rampByVal', 1, 20);
  const re = bump('rampEvery', 'rampEveryVal', 1, 32);
  $('rampByMinus').addEventListener('click', () => rb(-1));
  $('rampByPlus').addEventListener('click',  () => rb(1));
  $('rampEveryMinus').addEventListener('click', () => re(-1));
  $('rampEveryPlus').addEventListener('click',  () => re(1));
  $('rampToRange').addEventListener('input', e => {
    state.rampTo = +e.target.value;
    $('rampToVal').textContent = state.rampTo;
    sumPractice();
    queueSave();
  });

  /* engine feedback */
  bus.on('beat', e => { if(e.down){ markBeat(e.beat); updateReadout(e); } });
  bus.on('bpm', v => setBpm(v, true));
  bus.on('stats', updateStats);
  bus.on('tick', e => { $('roTime').textContent = fmtTime(e.elapsed); });
  bus.on('stop', () => { markBeat(-1); updateStats(); });
  bus.on('start', () => { $('roTime').textContent = '0:00'; });

  refreshMetronome();
}
