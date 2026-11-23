/* Check a chord, before practising: pluck it string by string, or strum it,
   and see what is wrong with the shape and how to fix it.

   The analysis lives in check.js (pure and tested); this file is the panel:
   the chord and string pickers, the microphone loop, and the read-out. */

import { state, save, bus } from './store.js';
import { extractChroma, rateChordAccuracy, buildCustomChord, STANDARD_STRINGS } from './chord.js';
import { detectPitch } from './pitch.js';
import { acquire, release, micError } from './mic.js';
import {
  chordStrings, noteName, stringLabel,
  diagnoseString, createPluckListener,
  diagnoseStrum, summariseStrum, createStrumListener
} from './check.js';
import { gateFromSens, activeFretsFor } from './ui-lte.js';
import { strictProfile } from './strictness.js';
import { $, toast, segment, segmentSet } from './ui.js';

const FFT = 4096;

let analyser = null, buf = null, timer = null, t0 = 0;
let checking = false;
let chord = null;               // chord being checked
let selIdx = 0;                 // string being checked, 0 = low E … 5 = high E
let stringResults = [];         // per string, from plucking it alone
let strumResults = [];          // per string, from the last strum
let stringRaw = [];             // what was heard, kept so a new strictness can re-grade it
let strumRaw = null;
let pluckL = null, strumL = null;
let signature = '';

/* What each verdict means at a glance: the mark on the string, the colour. */
const TONE = {
  ok: 'ok', quiet: 'ok',
  tune: 'warn', dull: 'warn',
  unsure: 'unsure', range: 'unsure',
  fret: 'bad', open: 'bad', silent: 'bad', rings: 'bad', muffled: 'bad',
  string: 'bad', octave: 'bad', wrong: 'bad'
};
const MARK = { ok: '✓', warn: '!', bad: '✕', unsure: '?' };
const tone = status => TONE[status] || 'unsure';
const prof = () => strictProfile(state.lteStrict);

function fretsFor(ch){ return activeFretsFor(ch); }
function chordsToCheck(){ return state.lteChords.length ? state.lteChords : []; }

/* ---------------- painting ---------------- */
function paintChords(){
  const box = $('lteCheckChords');
  box.textContent = '';
  chordsToCheck().forEach(ch => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lte-pill';
    b.textContent = ch;
    b.setAttribute('aria-pressed', String(ch === chord));
    b.addEventListener('click', () => {
      if(ch === chord) return;
      chord = ch;
      resetResults();
      selIdx = firstSounding();
      paintAll();
    });
    box.appendChild(b);
  });
}

function currentResults(){
  return state.lteCheckMode === 'strum' ? strumResults : stringResults;
}

function paintBoard(){
  const board = $('lteCheckBoard');
  board.textContent = '';
  if(!chord) return;
  const strs = chordStrings(fretsFor(chord));
  const res = currentResults();
  strs.forEach(s => {
    const r = res[s.idx];
    const t = r ? tone(r.status) : '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lte-check-str' + (s.muted ? ' muted' : '') +
                  (state.lteCheckMode === 'string' && s.idx === selIdx ? ' sel' : '');
    if(t) b.dataset.st = t;
    b.innerHTML = '<span class="st"></span><span class="lab"></span><span class="frt"></span><span class="nt"></span>';
    b.querySelector('.st').textContent = t ? MARK[t] : '';
    b.querySelector('.lab').textContent = STANDARD_STRINGS[s.idx].label;
    b.querySelector('.frt').textContent = s.muted ? 'x' : String(s.fret);
    b.querySelector('.nt').textContent = s.muted ? '—' : noteName(s.midi);
    b.setAttribute('aria-label',
      stringLabel(s.idx) + ', ' + (s.muted ? 'muted' : (s.fret === 0 ? 'open' : 'fret ' + s.fret) + ', ' + noteName(s.midi)) +
      (r ? ' — ' + r.title : '') + '. Tap to check this string.');
    b.addEventListener('click', () => {
      selIdx = s.idx;
      if(state.lteCheckMode !== 'string'){
        state.lteCheckMode = 'string';
        save();
      }
      makeListeners();
      paintAll();
      showStringResult(stringResults[selIdx] || null);
    });
    board.appendChild(b);
  });
}

function paintPrompt(live){
  const el = $('lteCheckPrompt');
  el.classList.toggle('live', !!live);
  if(live){ el.textContent = live; return; }
  if(!chord){ el.textContent = 'Set some chords above to check them.'; return; }

  if(state.lteCheckMode === 'strum'){
    el.innerHTML = checking
      ? 'Strum the whole <b></b> once and let it ring.'
      : 'Tap Start, then strum the whole <b></b> once.';
    el.querySelector('b').textContent = chord;
    return;
  }

  const s = chordStrings(fretsFor(chord))[selIdx];
  const done = stringResults.filter(Boolean).length;
  const last = stringResults[selIdx];
  const what = s.muted ? 'it should stay silent' : (s.fret === 0 ? 'open, ' : 'fret ' + s.fret + ', ') + noteName(s.midi);
  let lead;
  if(last && tone(last.status) !== 'ok') lead = 'Fix it and pluck ';
  else lead = checking ? 'Pluck ' : 'Tap Start, then pluck ';
  el.innerHTML = lead + '<b></b> — ' + what + '.';
  el.querySelector('b').textContent = stringLabel(selIdx);
  if(done === 6 && !(last && tone(last.status) !== 'ok')){
    el.textContent = 'All six strings checked — tap any string to check it again.';
  }
}

function showStringResult(d){
  const box = $('lteCheckResult');
  if(!d){ box.hidden = true; return; }
  box.hidden = false;
  box.dataset.st = tone(d.status);
  $('lteCheckTitle').textContent = d.title;
  $('lteCheckDetail').textContent = d.detail;
  $('lteCheckTip').textContent = d.tip || '';
}

function showStrum(info, strings){
  $('lteCheckResult').hidden = true;
  const panel = $('lteCheckStrum');
  panel.hidden = false;

  const m = rateChordAccuracy(buildCustomChord(chord, fretsFor(chord)), info, prof());
  $('lteCheckPurity').textContent = m.purity + '%';
  $('lteCheckFull').textContent = m.completeness + '%';
  $('lteCheckTune').textContent = m.tuning + '%';

  const sum = summariseStrum(strings);
  const head = $('lteCheckHeadline');
  head.textContent = sum.headline;
  head.dataset.st = sum.issues.length ? 'bad' : 'ok';

  const ul = $('lteCheckIssues');
  ul.textContent = '';
  sum.issues.concat(sum.unsure).forEach(s => {
    const li = document.createElement('li');
    li.dataset.st = tone(s.status);
    const b = document.createElement('b');
    b.textContent = s.title;
    const span = document.createElement('span');
    span.textContent = s.detail;
    li.appendChild(b);
    li.appendChild(span);
    if(s.tip){
      const em = document.createElement('em');
      em.textContent = s.tip;
      li.appendChild(em);
    }
    ul.appendChild(li);
  });
  paintSummary(sum.issues.length ? sum.issues.length + ' ' + (sum.issues.length === 1 ? 'string needs' : 'strings need') + ' work' : 'rang clean');
}

function paintSummary(text){
  $('lteCheckSum').textContent = chord && text ? chord + ' — ' + text : 'before you practise';
}

function paintButton(){
  const b = $('lteCheckBtn');
  b.textContent = checking ? 'Stop checking' : 'Start checking';
  b.dataset.on = String(checking);
  b.disabled = !chord;
}

function paintLevel(){
  const el = $('lteCheckLevel');
  el.innerHTML = 'Graded as <b></b> — change Strictness in the settings below.';
  el.querySelector('b').textContent = prof().short;
}

/* Strictness moved: judge what was already heard again, at the new level. */
function regrade(){
  if(!chord) return;
  const frets = fretsFor(chord);
  stringResults = stringRaw.map((r, idx) => r ? diagnoseString(r, frets, idx, state.a4, prof()) : undefined);
  if(strumRaw){
    const strings = diagnoseStrum(strumRaw, frets, prof());
    strumResults = [];
    strings.forEach(s => { strumResults[s.idx] = s; });
    showStrum(strumRaw, strings);
  }
  paintAll();
}

function paintAll(){
  paintLevel();
  segmentSet($('lteCheckModeSeg'), 'checkmode', state.lteCheckMode);
  paintChords();
  paintBoard();
  paintPrompt();
  paintButton();
  if(state.lteCheckMode === 'string'){
    $('lteCheckStrum').hidden = true;
    showStringResult(stringResults[selIdx] || null);
  }else{
    $('lteCheckResult').hidden = true;
    $('lteCheckStrum').hidden = !strumResults.length;
  }
}

/* ---------------- listening ---------------- */
function gate(){
  const g = gateFromSens(state.lteSens);
  // a single plucked string is quieter than a full strum
  return state.lteCheckMode === 'string' ? g * 0.7 : g;
}

function makeListeners(){
  pluckL = createPluckListener({ gate: gate() });
  strumL = createStrumListener({ gate: gate() });
}

function onPluck(r){
  stringRaw[selIdx] = r;
  const d = diagnoseString(r, fretsFor(chord), selIdx, state.a4, prof());
  stringResults[selIdx] = d;
  showStringResult(d);
  const good = tone(d.status) === 'ok';
  // on a problem, stay on this string so it can be fixed and plucked again
  if(good && stringResults.filter(Boolean).length < 6) selIdx = nextUnchecked(selIdx);
  paintBoard();
  paintPrompt();
  const bad = stringResults.filter(x => x && tone(x.status) === 'bad').length;
  paintSummary(bad ? bad + ' ' + (bad === 1 ? 'string needs' : 'strings need') + ' work' : '');
}

function onStrum(info){
  strumRaw = info;
  const strings = diagnoseStrum(info, fretsFor(chord), prof());
  strumResults = [];
  strings.forEach(s => { strumResults[s.idx] = s; });
  showStrum(info, strings);
  paintBoard();
  paintPrompt();
}

function sample(){
  if(!checking || !analyser) return;
  try{
    analyser.getFloatTimeDomainData(buf);
    const sr = analyser.context.sampleRate;
    const t = (performance.now() - t0) / 1000;

    if(state.lteCheckMode === 'string'){
      let rms = 0;
      for(let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / buf.length);
      const p = detectPitch(buf, sr);
      const r = pluckL.step({ t, rms, hz: p.hz, clarity: p.clarity });
      if(r) onPluck(r);
      else if(pluckL.listening){
        paintPrompt(p.hz > 0 ? 'Hearing ' + noteName(Math.round(69 + 12 * Math.log2(p.hz / state.a4))) + ' — let it ring…' : 'Listening…');
      }
    }else{
      const info = extractChroma(buf, sr, { a4: state.a4, gate: gate() });
      const r = strumL.step({ t, info });
      if(r) onStrum(r);
      else if(strumL.listening) paintPrompt('Listening to the strum…');
    }
  }catch(err){
    console.error('[check]', err);     // one bad frame must not stop the check
  }
}

async function start(){
  if(checking || !chord) return;
  bus.emit('mic:claim', 'check');      // stops LTE listening or a session
  try{
    analyser = await acquire(FFT);
  }catch(err){
    toast(micError(err));
    return;
  }
  buf = new Float32Array(analyser.fftSize);
  checking = true;
  t0 = performance.now();
  makeListeners();
  timer = setInterval(sample, 33);
  paintButton();
  paintPrompt();
}

export function stopCheck(){
  if(!checking) return;
  checking = false;
  if(timer) clearInterval(timer);
  timer = null;
  release(analyser);
  analyser = null;
  paintButton();
  paintPrompt();
}

/* ---------------- choosing ---------------- */
function firstSounding(){
  if(!chord) return 0;
  const strs = chordStrings(fretsFor(chord));
  const s = strs.find(x => !x.muted);
  return s ? s.idx : 0;
}

function nextUnchecked(from){
  for(let k = 1; k <= 6; k++){
    const i = (from + k) % 6;
    if(!stringResults[i]) return i;
  }
  return from;
}

function resetResults(){
  stringResults = [];
  strumResults = [];
  stringRaw = [];
  strumRaw = null;
  $('lteCheckResult').hidden = true;
  $('lteCheckStrum').hidden = true;
  paintSummary('');
}

/* The chord list or a shape changed in the LTE panel above: follow it. */
function onChordsChanged(){
  const list = chordsToCheck();
  const sig = list.map(ch => ch + ':' + fretsFor(ch).join(',')).join('|');
  if(sig === signature) return;
  signature = sig;
  if(!list.includes(chord)) chord = list[0] || null;
  resetResults();
  selIdx = firstSounding();
  if(pluckL) makeListeners();
  paintAll();
}

export function initCheck(){
  const panel = $('lteCheckPanel');
  panel.open = state.lteCheckOpen;
  panel.addEventListener('toggle', () => {
    state.lteCheckOpen = panel.open;
    if(!panel.open) stopCheck();
    save();
  });

  segment($('lteCheckModeSeg'), 'checkmode', v => {
    state.lteCheckMode = v === 'strum' ? 'strum' : 'string';
    save();
    makeListeners();
    paintAll();
  });

  $('lteCheckBtn').addEventListener('click', () => checking ? stopCheck() : start());

  bus.on('mic:claim', who => { if(who !== 'check') stopCheck(); });
  bus.on('lte:chords', onChordsChanged);
  bus.on('lte:strict', regrade);

  chord = chordsToCheck()[0] || null;
  onChordsChanged();
  paintAll();
}
