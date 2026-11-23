/* Licking Them Envelopes (LTE): timed chord counter & accuracy rater.
   Uses polyphonic chroma + attack-envelope tracking from chord.js over the
   shared reference-counted microphone in mic.js. */

import {
  state, save, clamp, fmtTime, bus,
  sameChords, chordSetLabel, rememberChordSet, forgetChordSet
} from './store.js';
import {
  CHORD_PRESETS, STANDARD_STRINGS, parseChordList, chordVoicing,
  getChordTabs, accuracyVerdict, createEnvelopeTracker
} from './chord.js';
import { NOTE_NAMES } from './pitch.js';
import { acquire, release, micError } from './mic.js';
import { playChime, playChordPreview } from './audio.js';
import { $, $$, toast, segment, segmentSet } from './ui.js';

const FFT = 4096;
const HOLD_MS = 1600;
const COUNT_HOLD_MS = 1100;

let analyser = null, buf = null, timer = null, raf = null;
let micOn = false;
let sessionActive = false;
let sessionStartMs = 0;
let lastReadAt = 0;
let lastCountDisplayAt = 0;
let lastCountedChord = null;
let liveEnv = 0;
let liveChroma = new Float32Array(12);
let liveExpected = null;
let targetIdx = 0;
let sessionLog = [];
let tracker = null;
let flashTimer = null;

export function gateFromSens(sens){
  return 0.018 * Math.pow(0.76, clamp(sens, 1, 10) - 1);
}

function makeTracker(){
  tracker = createEnvelopeTracker({
    cooldownMs: 280,
    settleFrames: 3,
    gate: gateFromSens(state.lteSens)
  });
}

function activeTargets(){
  return state.lteMode === 'target' ? state.lteChords : [];
}

function currentExpected(){
  if(state.lteMode !== 'target' || !state.lteChords.length) return null;
  if(state.lteChords.length === 1) return state.lteChords[0];
  if(!state.lteFollowOrder) return null;
  return state.lteChords[targetIdx % state.lteChords.length];
}

export function activeFretsFor(chordId){
  const saved = state.lteTabShapes && state.lteTabShapes[chordId];
  if(Array.isArray(saved) && saved.length === 6) return saved.slice();
  const tabs = getChordTabs(chordId);
  return tabs[0].frets.slice();
}

function sameFrets(a, b){
  if(!Array.isArray(a) || !Array.isArray(b) || a.length !== 6 || b.length !== 6) return false;
  for(let i = 0; i < 6; i++) if(a[i] !== b[i]) return false;
  return true;
}

function renderTabDeck(){
  bus.emit('lte:chords');          // the chord check follows the same chords and shapes
  const deck = $('lteTabDeck');
  if(!deck) return;
  deck.textContent = '';

  if(state.lteMode !== 'target' || !state.lteChords.length){
    deck.hidden = true;
    return;
  }

  const exp = currentExpected();
  state.lteChords.forEach((ch, idx) => {
    const presets = getChordTabs(ch);
    const frets = activeFretsFor(ch);
    const matchIdx = presets.findIndex(p => sameFrets(p.frets, frets));
    const shapeLabel = matchIdx >= 0 ? presets[matchIdx].name : 'Custom';

    let maxFret = 0, minPos = 99;
    for(const f of frets){
      if(f > maxFret) maxFret = f;
      if(f > 0 && f < minPos) minPos = f;
    }
    const baseFret = maxFret <= 4 ? 1 : Math.max(1, minPos);

    const card = document.createElement('div');
    card.className = 'lte-tab-card';
    card.dataset.chord = ch;
    const isNext = exp ? idx === (targetIdx % state.lteChords.length) : false;
    card.classList.toggle('is-next', isNext);

    const head = document.createElement('div');
    head.className = 'lte-tab-head';

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'lte-tab-name';
    nameBtn.dataset.tip = 'Tap to hear ' + ch + ' (' + frets.map(f => f < 0 ? 'x' : f).join('') + ')';
    nameBtn.innerHTML = ch + ' <small>🔊</small>';
    nameBtn.addEventListener('click', () => {
      targetIdx = idx;
      renderTargets();
      playChordPreview(chordVoicing(ch, state.a4, activeFretsFor(ch)));
    });

    const shapeBtn = document.createElement('button');
    shapeBtn.type = 'button';
    shapeBtn.className = 'lte-tab-shape';
    shapeBtn.textContent = shapeLabel + ' ↻';
    shapeBtn.dataset.tip = 'Cycle guitar shapes for ' + ch + ' (or tap any string/fret below to customize).';
    shapeBtn.addEventListener('click', () => {
      const nextIdx = (matchIdx + 1) % presets.length;
      const nextFrets = presets[nextIdx].frets.slice();
      state.lteTabShapes[ch] = nextFrets;
      save();
      renderTabDeck();
      playChordPreview(chordVoicing(ch, state.a4, nextFrets));
    });

    head.appendChild(nameBtn);
    head.appendChild(shapeBtn);
    card.appendChild(head);

    const board = document.createElement('div');
    board.className = 'lte-tab-board';

    for(let s = 0; s < 6; s++){
      const f = frets[s];
      const strInfo = STANDARD_STRINGS[s];
      const col = document.createElement('div');
      col.className = 'lte-tab-col';

      const topBtn = document.createElement('button');
      topBtn.type = 'button';
      topBtn.className = 'lte-tab-topcell ' + (f < 0 ? 'is-mute' : f === 0 ? 'is-open' : 'is-fret');
      topBtn.textContent = f < 0 ? 'x' : String(f);
      topBtn.dataset.tip = 'String ' + strInfo.string + ' (' + strInfo.label + '): tap to toggle open (0) or muted (x).';
      topBtn.addEventListener('click', () => {
        const next = frets.slice();
        next[s] = f < 0 ? 0 : -1;
        state.lteTabShapes[ch] = next;
        save();
        renderTabDeck();
        playChordPreview(chordVoicing(ch, state.a4, next));
      });
      col.appendChild(topBtn);

      const nut = document.createElement('div');
      nut.className = 'lte-tab-nut';
      col.appendChild(nut);

      for(let r = 0; r < 4; r++){
        const fretNum = baseFret + r;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'lte-tab-fretcell';
        cell.dataset.fret = String(fretNum);
        cell.dataset.string = String(strInfo.string);
        if(f === fretNum){
          const dot = document.createElement('span');
          dot.className = 'lte-tab-dot';
          dot.textContent = String(fretNum);
          cell.appendChild(dot);
        }
        cell.addEventListener('click', () => {
          const next = frets.slice();
          next[s] = f === fretNum ? 0 : fretNum;
          state.lteTabShapes[ch] = next;
          save();
          renderTabDeck();
          playChordPreview(chordVoicing(ch, state.a4, next));
        });
        col.appendChild(cell);
      }

      const foot = document.createElement('div');
      foot.className = 'lte-tab-foot';
      const noteName = f < 0 ? '—' : NOTE_NAMES[(strInfo.midi + f) % 12];
      foot.innerHTML = '<b>' + noteName + '</b>' + strInfo.label;
      col.appendChild(foot);

      board.appendChild(col);
    }

    card.appendChild(board);
    deck.appendChild(card);
  });
}

/* ---------- chroma strip ---------- */
function buildChromaStrip(){
  const box = $('lteChroma');
  if(!box || box.childElementCount) return;
  NOTE_NAMES.forEach((n, pc) => {
    const el = document.createElement('span');
    el.className = 'lte-pc';
    el.dataset.pc = String(pc);
    el.textContent = n;
    box.appendChild(el);
  });
}

function paintChromaStrip(chroma, chordNotes, allowStray){
  const box = $('lteChroma');
  if(!box) return;
  const noteSet = new Set(Array.isArray(chordNotes) ? chordNotes : []);
  const showStray = allowStray !== false;
  Array.from(box.children).forEach((el, pc) => {
    const v = chroma ? chroma[pc] : 0;
    const active = v >= 0.22;
    const expected = noteSet.has(NOTE_NAMES[pc]);
    el.classList.toggle('on', active);
    el.classList.toggle('want', expected);
    el.classList.toggle('stray', showStray && active && noteSet.size > 0 && !expected);
    el.style.setProperty('--v', v.toFixed(2));
  });
}

/* ---------- target pills & presets ----------
   The Drill list holds your own chord sets first — every set of custom chords
   you Set is kept there for the next practice — then the built-in drills,
   then "Custom chords…" for typing a new one. */
function makeOption(value, label){
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function findSet(id){
  return state.lteSaved.find(s => s.id === id) || CHORD_PRESETS.find(p => p.id === id) || null;
}

function buildPresets(){
  const sel = $('ltePreset');
  if(!sel) return;
  sel.textContent = '';
  if(state.lteSaved.length){
    const mine = document.createElement('optgroup');
    mine.label = 'My chord sets';
    state.lteSaved.forEach(s => mine.appendChild(makeOption(s.id, chordSetLabel(s.chords))));
    sel.appendChild(mine);
  }
  const drills = document.createElement('optgroup');
  drills.label = 'Drills';
  CHORD_PRESETS.forEach(p => drills.appendChild(makeOption(p.id, p.name)));
  sel.appendChild(drills);
  sel.appendChild(makeOption('custom', 'Custom chords…'));
  sel.value = findSet(state.ltePreset) ? state.ltePreset : 'custom';
  paintRemove();
}

/* Remove only appears while one of your own sets is selected — the built-in
   drills cannot be removed. */
function paintRemove(){
  const b = $('ltePresetRemove');
  if(!b) return;
  const s = state.lteSaved.find(x => x.id === state.ltePreset);
  b.hidden = !s;
  if(s){
    const label = chordSetLabel(s.chords);
    b.dataset.tip = 'Remove ' + label + ' from your chord sets. The chords stay loaded for this practice.';
    b.setAttribute('aria-label', 'Remove chord set ' + label);
  }
}

function renderTargets(){
  bus.emit('lte:chords');
  const bar = $('lteTargetBar');
  if(!bar) return;
  bar.textContent = '';

  if(state.lteMode === 'guess'){
    const tag = document.createElement('span');
    tag.className = 'lte-guess-pill';
    tag.textContent = 'Auto-detect mode — play any chord';
    bar.appendChild(tag);
    return;
  }

  const exp = currentExpected();
  state.lteChords.forEach((ch, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lte-pill';
    const isNext = exp ? idx === (targetIdx % state.lteChords.length) : false;
    b.classList.toggle('next', isNext);
    b.textContent = isNext && state.lteChords.length > 1 ? 'Next: ' + ch : ch;
    b.title = 'Tap to select & hear ' + ch;
    b.addEventListener('click', () => {
      targetIdx = idx;
      renderTargets();
      if(!sessionActive) playChordPreview(chordVoicing(ch, state.a4, activeFretsFor(ch)));
    });
    bar.appendChild(b);
  });
  renderTabDeck();
}

function syncPresetFromChords(){
  const hit = CHORD_PRESETS.find(p => sameChords(p.chords, state.lteChords))
           || state.lteSaved.find(s => sameChords(s.chords, state.lteChords));
  state.ltePreset = hit ? hit.id : 'custom';
  const sel = $('ltePreset');
  if(sel) sel.value = state.ltePreset;
  paintRemove();
}

/* ---------- timer & buttons ---------- */
function fmtDurLabel(sec){
  return sec === 0 ? '∞ free' : fmtTime(sec);
}

function paintTimer(){
  const dur = state.lteDuration;
  const elapsed = sessionActive ? (performance.now() - sessionStartMs) / 1000 : 0;
  const shown = dur === 0 ? elapsed : Math.max(0, Math.ceil(dur - elapsed));
  $('lteTimer').textContent = fmtTime(shown);

  const pct = dur === 0 ? (sessionActive ? 100 : 0)
            : sessionActive ? clamp(100 * (1 - elapsed / dur), 0, 100) : 100;
  $('lteTimeFill').style.width = pct.toFixed(1) + '%';
}

function paintControls(){
  $('lteMicBtn').textContent = micOn ? 'Stop mic' : 'Listen';
  $('lteMicBtn').dataset.on = String(micOn);

  const go = $('lteStartBtn');
  go.dataset.on = String(sessionActive);
  go.textContent = sessionActive
    ? 'Stop session'
    : 'Start ' + fmtDurLabel(state.lteDuration) + ' session';

  segmentSet($('lteModeSeg'), 'ltemode', state.lteMode);
  $('lteTargetPanel').hidden = state.lteMode !== 'target';

  const durPreset = [30, 60, 120, 180, 0].includes(state.lteDuration) ? state.lteDuration : '';
  segmentSet($('lteDurSeg'), 'dur', durPreset);
  $('lteOrderChk').checked = state.lteFollowOrder;
  $('lteChangesChk').checked = state.lteChangesOnly;
  $('lteSensRange').value = state.lteSens;
  $('lteSensVal').textContent = state.lteSens;
  $('lteChordInput').value = state.lteChords.join(', ');

  const gatePct = clamp(((gateFromSens(state.lteSens) * 1.8) / 0.06) * 100, 3, 92);
  $('lteEnvGate').style.left = gatePct.toFixed(1) + '%';

  const showDet = !!state.lteShowDetails;
  $('lteDetails').hidden = !showDet;
  const moreBtn = $('lteDetailsBtn');
  if(moreBtn){
    moreBtn.setAttribute('aria-expanded', String(showDet));
    moreBtn.textContent = showDet ? '▴' : '▾';
  }
}

/* ---------- readouts & log ---------- */
function clearReadout(){
  $('lteChord').textContent = '—';
  $('lteVerdict').hidden = true;
  const showDeck = !sessionActive && state.lteMode === 'target' && state.lteChords.length > 0;
  $('lteTabDeck').hidden = !showDeck;
  $('lteLiveRow').hidden = showDeck;
  if(showDeck) renderTabDeck();
  $('lteChordSub').textContent = sessionActive
    ? (currentExpected() ? 'Play ' + currentExpected() + '…' : 'Strum a chord…')
    : micOn
      ? 'listening… strum a chord'
      : (showDeck ? 'Tap a string/fret to adjust voicings · Tap Start below to count & rate' : 'Tap Start below to count & rate your chords');
  $('lteAccText').textContent = '—';
  $('ltePurity').textContent = '—';
  $('lteFull').textContent = '—';
  $('lteTune').textContent = '—';
  $('lteCard').classList.remove('tier-ok', 'tier-near', 'tier-far', 'tier-preview');
  paintChromaStrip(null, null, true);
}

function showDetection(res, isCounted){
  const card = $('lteCard');
  const verdict = accuracyVerdict(res.accuracy);
  $('lteTabDeck').hidden = true;
  $('lteLiveRow').hidden = false;
  $('lteChord').textContent = res.chord || '—';

  const wrongTarget = !!(res.expected && !res.matchedTarget);
  const rawTier = wrongTarget ? 'far' : verdict.tier;
  /* Never flash alarming red on uncounted interim decay/transition frames during
     a timed session; reserve red tier-far for actual counted hits in the log. */
  const softPreview = sessionActive && !isCounted && rawTier === 'far';
  const displayTier = softPreview ? 'preview' : rawTier;

  const badge = $('lteVerdict');
  badge.hidden = !res.chord;
  badge.textContent = softPreview
    ? (res.expected ? 'Next ' + res.expected : 'Listening')
    : (wrongTarget ? 'Target ' + res.expected : verdict.short);
  badge.dataset.tier = displayTier;

  card.classList.remove('tier-ok', 'tier-near', 'tier-far', 'tier-preview');
  card.classList.add('tier-' + displayTier);

  if(softPreview){
    $('lteChordSub').textContent = res.expected
      ? 'Next: ' + res.expected + ' · hearing ' + res.label
      : res.label + ' · listening…';
  }else if(wrongTarget){
    $('lteChordSub').textContent =
      'Expected ' + res.expected + ' — heard ' + res.label + ' (' + res.accuracy + '% match)';
  }else{
    $('lteChordSub').textContent = res.label + ' · ' + verdict.label;
  }

  $('lteAccText').textContent = res.accuracy + '%';
  $('ltePurity').textContent = res.purity + '%';
  $('lteFull').textContent = res.completeness + '%';
  $('lteTune').textContent = res.tuning + '%';

  const displayNotes = wrongTarget
    ? (chordVoicing(res.expected, state.a4, activeFretsFor(res.expected)).map(x => x.note.replace(/\d+$/, '')))
    : res.notes;
  liveExpected = displayNotes;
  liveChroma = res.chroma || liveChroma;
  paintChromaStrip(res.chroma, displayNotes, !softPreview);

  if(isCounted){
    card.classList.add('flash-hit');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => card.classList.remove('flash-hit'), 180);
  }
}

function updateSessionCounters(){
  const n = sessionLog.length;
  $('lteCount').textContent = String(n);
  if(!n){
    $('lteAvg').textContent = '—';
    return;
  }
  const avg = Math.round(sessionLog.reduce((a, x) => a + x.accuracy, 0) / n);
  $('lteAvg').textContent = avg + '%';
}

function renderLog(){
  const ul = $('lteLog');
  ul.textContent = '';
  $('lteEmpty').hidden = sessionLog.length > 0;

  /* Show newest first so the player sees each strum immediately. */
  for(let i = sessionLog.length - 1; i >= 0; i--){
    const item = sessionLog[i];
    const v = accuracyVerdict(item.accuracy);
    const tier = (item.expected && !item.matched) ? 'far' : v.tier;

    const li = document.createElement('li');
    li.className = 'lte-row';
    li.dataset.tier = tier;

    const num = document.createElement('span');
    num.className = 'lte-row-idx';
    num.textContent = '#' + (i + 1);

    const main = document.createElement('div');
    main.className = 'lte-row-main';
    const title = document.createElement('div');
    title.className = 'lte-row-name';
    title.textContent = item.expected && !item.matched
      ? item.chord + ' (wanted ' + item.expected + ')'
      : item.chord;
    const meta = document.createElement('div');
    meta.className = 'lte-row-meta';
    meta.textContent = fmtTime(item.elapsed) + ' · purity ' + item.purity +
      '% · fullness ' + item.completeness + '% · tune ' + item.tuning + '%';
    main.appendChild(title);
    main.appendChild(meta);

    const score = document.createElement('span');
    score.className = 'lte-row-acc';
    score.textContent = item.accuracy + '%';

    li.appendChild(num);
    li.appendChild(main);
    li.appendChild(score);
    ul.appendChild(li);
  }
}

function renderBest(){
  const el = $('lteBest');
  if(!el) return;
  if(!state.lteHistory.length){ el.textContent = ''; return; }
  let best = state.lteHistory[0];
  for(const h of state.lteHistory){
    if(h.count > best.count || (h.count === best.count && h.avgAcc > best.avgAcc)) best = h;
  }
  el.textContent = 'Best: ' + best.count + ' @ ' + best.avgAcc + '%';
}

function showSummary(elapsedSec){
  const panel = $('lteSummaryPanel');
  const box = $('lteSummary');
  const paceEl = $('ltePace');
  if(!sessionLog.length){
    panel.hidden = true;
    return;
  }

  const count = sessionLog.length;
  const avgAcc = Math.round(sessionLog.reduce((a, x) => a + x.accuracy, 0) / count);
  const avgPurity = Math.round(sessionLog.reduce((a, x) => a + x.purity, 0) / count);
  const avgFull = Math.round(sessionLog.reduce((a, x) => a + x.completeness, 0) / count);
  const avgTune = Math.round(sessionLog.reduce((a, x) => a + x.tuning, 0) / count);
  const cleanCount = sessionLog.filter(x => x.accuracy >= 78 && (x.matched !== false)).length;
  const mins = Math.max(1 / 60, elapsedSec / 60);
  const cpm = (count / mins).toFixed(1);
  const v = accuracyVerdict(avgAcc);

  paceEl.textContent = cpm + ' chords/min';
  box.innerHTML =
    '<div class="lte-sum-grid">' +
      '<div><span>Counted</span><b>' + count + '</b></div>' +
      '<div><span>Accuracy</span><b>' + avgAcc + '%</b></div>' +
      '<div><span>Clean hits</span><b>' + cleanCount + '/' + count + '</b></div>' +
      '<div><span>Verdict</span><b data-tier="' + v.tier + '">' + v.short + '</b></div>' +
    '</div>' +
    '<div class="lte-sum-sub">Avg purity ' + avgPurity + '% · fullness ' + avgFull + '% · tuning ' + avgTune + '%</div>';

  panel.hidden = false;
}

/* ---------- audio sampling & render loop ---------- */
function sample(){
  if(!micOn || !analyser) return;
  try{
    analyser.getFloatTimeDomainData(buf);
    const now = performance.now();
    const expected = currentExpected();
    const targets = activeTargets();

    const stepOut = tracker.step(buf, analyser.context.sampleRate, now, {
      a4: state.a4,
      targets,
      expected,
      changesOnly: state.lteChangesOnly,
      customTabs: state.lteTabShapes
    });

    liveEnv = stepOut.envelope;

    if(sessionActive && stepOut.counted){
      const ev = stepOut.counted;
      const elapsedSec = (now - sessionStartMs) / 1000;
      sessionLog.push({
        chord: ev.chord,
        expected: ev.expected,
        matched: ev.matchedTarget,
        accuracy: ev.accuracy,
        purity: ev.purity,
        completeness: ev.completeness,
        tuning: ev.tuning,
        elapsed: elapsedSec
      });
      lastReadAt = now;
      lastCountDisplayAt = now;
      lastCountedChord = ev.chord;
      showDetection(ev, true);
      updateSessionCounters();
      renderLog();

      if(state.lteMode === 'target' && state.lteFollowOrder && state.lteChords.length > 1){
        if(ev.matchedTarget){
          targetIdx = (targetIdx + 1) % state.lteChords.length;
          renderTargets();
        }
      }
    }else if(stepOut.live && stepOut.live.chord){
      const liveGate = gateFromSens(state.lteSens) * 1.25;
      const liveStrong = stepOut.live.rms >= liveGate && stepOut.live.confidence >= 0.62;
      if(liveStrong){
        lastReadAt = now;
        const heldCounted = sessionActive && lastCountDisplayAt && (now - lastCountDisplayAt <= COUNT_HOLD_MS);
        const stalePrevious = sessionActive && lastCountedChord &&
          stepOut.live.chord === lastCountedChord &&
          stepOut.live.expected && !stepOut.live.matchedTarget;
        if(!heldCounted && !stalePrevious){
          showDetection(stepOut.live, false);
        }
      }else if(lastReadAt && now - lastReadAt > HOLD_MS){
        lastReadAt = 0;
        clearReadout();
      }
    }else if(lastReadAt && now - lastReadAt > HOLD_MS){
      lastReadAt = 0;
      clearReadout();
    }

    if(sessionActive && state.lteDuration > 0){
      const elapsedSec = (now - sessionStartMs) / 1000;
      if(elapsedSec >= state.lteDuration){
        finishSession(true);
      }
    }
  }catch(err){
    console.error('[lte]', err);
  }
}

function draw(){
  if(!micOn && !sessionActive){ raf = null; return; }
  const pct = clamp((liveEnv / 0.06) * 100, 0, 100);
  $('lteEnvFill').style.width = pct.toFixed(1) + '%';
  if(sessionActive) paintTimer();
  raf = requestAnimationFrame(draw);
}

/* ---------- mic & session lifecycle ---------- */
async function startMic(){
  if(micOn) return true;
  bus.emit('mic:claim', 'lte');     // the chord check stops listening
  try{
    analyser = await acquire(FFT);
    buf = new Float32Array(analyser.fftSize);
    makeTracker();
    micOn = true;
    lastReadAt = 0;
    liveEnv = 0;
    paintControls();
    clearReadout();
    timer = setInterval(sample, 33);
    raf = requestAnimationFrame(draw);
    return true;
  }catch(err){
    micOn = false;
    paintControls();
    toast(micError(err));
    return false;
  }
}

function stopMic(){
  micOn = false;
  if(timer) clearInterval(timer);
  timer = null;
  if(raf) cancelAnimationFrame(raf);
  raf = null;
  release(analyser);
  analyser = null;
  liveEnv = 0;
  lastCountDisplayAt = 0;
  lastCountedChord = null;
  $('lteEnvFill').style.width = '0%';
  paintControls();
  clearReadout();
}

async function startSession(){
  if(sessionActive) return;
  const ok = await startMic();
  if(!ok) return;

  tracker.reset();
  sessionLog = [];
  targetIdx = 0;
  lastReadAt = 0;
  lastCountDisplayAt = 0;
  lastCountedChord = null;
  sessionStartMs = performance.now();
  sessionActive = true;

  $('lteSummaryPanel').hidden = true;
  updateSessionCounters();
  renderLog();
  renderTargets();
  paintControls();
  paintTimer();
  clearReadout();
}

function finishSession(completed){
  if(!sessionActive) return;
  const elapsedSec = Math.max(1, (performance.now() - sessionStartMs) / 1000);
  const recordedDur = (completed && state.lteDuration > 0) ? state.lteDuration : Math.round(elapsedSec);
  sessionActive = false;

  if(completed) playChime();
  stopMic();

  if(sessionLog.length > 0){
    const avgAcc = Math.round(sessionLog.reduce((a, x) => a + x.accuracy, 0) / sessionLog.length);
    const cleanCount = sessionLog.filter(x => x.accuracy >= 78 && x.matched !== false).length;
    state.lteHistory.unshift({
      at: new Date().toISOString().slice(0, 16),
      mode: state.lteMode,
      duration: recordedDur,
      count: sessionLog.length,
      avgAcc,
      cleanCount,
      chords: state.lteMode === 'target' ? state.lteChords.slice() : []
    });
    if(state.lteHistory.length > 20) state.lteHistory.length = 20;
    save();
    renderBest();
    showSummary(recordedDur);
    if(completed) toast('Time! ' + sessionLog.length + ' chords · ' + avgAcc + '% accuracy');
  }else if(completed){
    toast('Time! No chords detected');
  }

  paintTimer();
  paintControls();
  renderTargets();
}

export function stopLte(){
  if(sessionActive) finishSession(false);
  else if(micOn) stopMic();
}

export function refreshLte(){
  buildPresets();
  syncPresetFromChords();
  paintControls();
  paintTimer();
  renderTargets();
  updateSessionCounters();
  renderLog();
  renderBest();
  clearReadout();
}

/* ---------- init ---------- */
export function initLte(){
  buildChromaStrip();
  makeTracker();

  // the chord check took the mic: stop listening and any session
  bus.on('mic:claim', who => { if(who !== 'lte') stopLte(); });

  $('lteMicBtn').addEventListener('click', () => {
    if(sessionActive){ finishSession(false); return; }
    micOn ? stopMic() : startMic();
  });

  $('lteStartBtn').addEventListener('click', () => {
    sessionActive ? finishSession(false) : startSession();
  });

  $('lteDetailsBtn').addEventListener('click', () => {
    state.lteShowDetails = !state.lteShowDetails;
    paintControls();
    save();
  });

  segment($('lteModeSeg'), 'ltemode', v => {
    state.lteMode = v === 'guess' ? 'guess' : 'target';
    targetIdx = 0;
    paintControls();
    renderTargets();
    clearReadout();
    save();
  });

  $('ltePreset').addEventListener('change', e => {
    const id = e.target.value;
    if(id === 'custom'){
      // "Custom chords…" means: type a new set below
      state.ltePreset = 'custom';
      paintRemove();
      const inp = $('lteChordInput');
      inp.focus();
      inp.select();
      save();
      return;
    }
    const set = findSet(id);
    if(!set) return;
    state.ltePreset = id;
    state.lteChords = set.chords.slice();
    targetIdx = 0;
    paintRemove();
    paintControls();
    renderTargets();
    clearReadout();
    save();
  });

  /* Setting custom chords keeps them in the Drill list for next time. A set
     that is already a built-in drill is just selected; one you have saved
     before moves back to the top rather than appearing twice. */
  const applyCustomChords = () => {
    const parsed = parseChordList($('lteChordInput').value);
    if(!parsed.length){
      toast('Enter chord names like A, D or C G Am F');
      return;
    }
    const chords = parsed.slice(0, 12);
    state.lteChords = chords;
    targetIdx = 0;

    const drill = CHORD_PRESETS.find(p => sameChords(p.chords, chords));
    let note;
    if(drill){
      state.ltePreset = drill.id;
      note = 'already a built-in drill';
    }else{
      const r = rememberChordSet(state.lteSaved, chords);
      state.lteSaved = r.list;
      state.ltePreset = r.set.id;
      note = r.added ? 'saved to your chord sets' : 'already in your chord sets';
    }

    buildPresets();
    paintControls();
    renderTargets();
    clearReadout();
    save();
    toast(chordSetLabel(chords) + ' — ' + note);
  };

  $('ltePresetRemove').addEventListener('click', () => {
    const s = state.lteSaved.find(x => x.id === state.ltePreset);
    if(!s) return;
    const label = chordSetLabel(s.chords);
    if(!confirm('Remove ' + label + ' from your chord sets?')) return;
    state.lteSaved = forgetChordSet(state.lteSaved, s.id);
    // the chords stay loaded for this practice; only the saved entry goes
    state.ltePreset = 'custom';
    buildPresets();
    save();
    toast('Removed ' + label);
  });
  $('lteChordApply').addEventListener('click', applyCustomChords);
  $('lteChordInput').addEventListener('keydown', ev => {
    if(ev.key === 'Enter'){ ev.preventDefault(); applyCustomChords(); }
  });

  $('lteOrderChk').addEventListener('change', e => {
    state.lteFollowOrder = e.target.checked;
    targetIdx = 0;
    renderTargets();
    save();
  });

  $('lteChangesChk').addEventListener('change', e => {
    state.lteChangesOnly = e.target.checked;
    save();
  });

  segment($('lteDurSeg'), 'dur', v => {
    state.lteDuration = +v;
    paintControls();
    paintTimer();
    save();
  });

  const stepDur = delta => {
    if(sessionActive) return;
    const next = state.lteDuration === 0 ? (delta > 0 ? 15 : 60) : state.lteDuration + delta;
    state.lteDuration = clamp(next, 15, 600);
    paintControls();
    paintTimer();
    save();
  };
  $('lteDurMinus').addEventListener('click', () => stepDur(-15));
  $('lteDurPlus').addEventListener('click',  () => stepDur(15));

  $('lteSensRange').addEventListener('input', e => {
    state.lteSens = +e.target.value;
    $('lteSensVal').textContent = state.lteSens;
    makeTracker();
    paintControls();
    save();
  });

  $('lteClear').addEventListener('click', () => {
    sessionLog = [];
    $('lteSummaryPanel').hidden = true;
    updateSessionCounters();
    renderLog();
  });

  refreshLte();
}
