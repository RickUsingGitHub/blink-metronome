/* Checks the polyphonic chord detector, accuracy scorer and envelope tracker
   against synthesised multi-string guitar chords.
   Run: node tests/chord.test.js */

import {
  detectChord, extractChroma, rateChordAccuracy,
  parseChordName, parseChordList, chordVoicing,
  getChordTabs, fretsToVoicing,
  createEnvelopeTracker, CHORD_PRESETS
} from '../js/chord.js';
import { hzFromName } from '../js/pitch.js';

const SR  = 48000;
const WIN = 4096;

/* Synthesise a multi-string plucked chord: each note has rich harmonics (1/h)
   and optional detuning, weak fundamentals, or extra stray strings. */
function synthChord(notesOrId, {
  a4 = 440,
  partials = 7,
  noise = 0.008,
  detuneCents = 0,
  weakFundamental = false,
  ampScale = 0.22
} = {}){
  const notes = Array.isArray(notesOrId)
    ? notesOrId.map(n => typeof n === 'string' ? { note: n, hz: hzFromName(n, a4) } : n)
    : chordVoicing(notesOrId, a4);

  const x = new Float32Array(WIN);
  const detuneRatio = Math.pow(2, detuneCents / 1200);

  notes.forEach((n, idx) => {
    const f0 = n.hz * detuneRatio;
    const weight = n.gain === undefined ? 1 : n.gain;
    const phase0 = idx * 0.61;
    for(let i = 0; i < WIN; i++){
      let s = 0;
      for(let h = 1; h <= partials; h++){
        if(f0 * h >= SR * 0.45) break;
        let a = 1 / Math.pow(h, 0.95);
        if(weakFundamental && h === 1) a *= 0.2;
        s += a * Math.sin(2 * Math.PI * f0 * h * (i / SR) + phase0 * h);
      }
      x[i] += s * weight;
    }
  });

  const norm = Math.max(1, Math.sqrt(notes.length));
  for(let i = 0; i < WIN; i++){
    x[i] = (x[i] / norm) * ampScale + (Math.random() * 2 - 1) * noise;
  }
  return x;
}

let pass = 0, fail = 0;
function assert(label, cond, detail = ''){
  if(cond) pass++; else fail++;
  console.log((cond ? '  ok   ' : '  FAIL ') + label.padEnd(38) + (detail ? ' ' + detail : ''));
}

console.log('\nChord parser & presets');
{
  assert('parse C major',    parseChordName('C')?.id === 'C');
  assert('parse Am',         parseChordName('Am')?.id === 'Am');
  assert('parse F#m7',       parseChordName('F#m7')?.id === 'F#m7');
  assert('parse Bb -> A#',   parseChordName('Bb')?.id === 'A#');
  assert('parse Ebmaj7',     parseChordName('Ebmaj7')?.id === 'D#maj7');
  assert('parse Dsus4',      parseChordName('Dsus4')?.id === 'Dsus4');
  assert('parse G5 power',   parseChordName('G5')?.id === 'G5');
  const list = parseChordList('C -> G -> Am -> F');
  assert('parseChordList',   list.join(',') === 'C,G,Am,F', 'got ' + list.join(','));
  assert('presets valid',    CHORD_PRESETS.every(p => p.chords.every(c => parseChordName(c))));
}

console.log('\nOpen guitar chords — Guess (auto-detect) mode');
for(const name of ['C', 'D', 'Dm', 'E', 'Em', 'F', 'G', 'A', 'Am', 'G7', 'C7', 'E7', 'Am7', 'Dsus4', 'Asus2']){
  const buf = synthChord(name);
  const res = detectChord(buf, SR);
  const ok = res.chord === name && res.accuracy >= 75;
  assert('detect ' + name, ok, 'got ' + (res.chord || 'none') + ' (' + res.accuracy + '% acc)');
}

console.log('\nWeak fundamentals on bass strings');
for(const name of ['E', 'Em', 'A', 'Am', 'G', 'C']){
  const buf = synthChord(name, { weakFundamental: true });
  const res = detectChord(buf, SR);
  assert(name + ' (weak f0)', res.chord === name, 'got ' + (res.chord || 'none') + ' (' + res.accuracy + '%)');
}

console.log('\nAccuracy rating — clean vs sloppy vs detuned vs wrong target');
{
  const cleanC = detectChord(synthChord('C', { noise: 0.003 }), SR, { expected: 'C' });
  /* Sloppy C: add unintended F#3 and G#3 clashes */
  const sloppyNotes = [
    ...chordVoicing('C'),
    { note:'F#3', hz: hzFromName('F#3', 440), gain: 0.85 },
    { note:'G#3', hz: hzFromName('G#3', 440), gain: 0.85 }
  ];
  const sloppyC = detectChord(synthChord(sloppyNotes), SR, { expected: 'C' });
  const detunedC = detectChord(synthChord('C', { detuneCents: 34 }), SR, { expected: 'C' });
  const wrongDm = detectChord(synthChord('Dm'), SR, { expected: 'C' });

  assert('clean C high accuracy',       cleanC.accuracy >= 84, 'got ' + cleanC.accuracy + '%');
  assert('sloppy C lower purity',       sloppyC.purity < cleanC.purity && sloppyC.accuracy < cleanC.accuracy,
    'clean ' + cleanC.accuracy + '% vs sloppy ' + sloppyC.accuracy + '%');
  assert('detuned C lower tuning score', detunedC.tuning < cleanC.tuning,
    'clean tuning ' + cleanC.tuning + '% vs detuned ' + detunedC.tuning + '%');
  assert('wrong chord flags mismatch',  wrongDm.chord === 'Dm' && !wrongDm.matchedTarget && wrongDm.accuracy < cleanC.accuracy,
    'heard ' + wrongDm.chord + ', matched=' + wrongDm.matchedTarget + ', acc=' + wrongDm.accuracy + '%');
}

console.log('\nEnvelope & strum tracker ("Licking Them Envelopes")');
{
  const tracker = createEnvelopeTracker({ cooldownMs: 200, settleFrames: 2 });
  const sequence = ['A', 'D', 'A', 'D'];
  const quiet = new Float32Array(WIN);
  const counted = [];
  let t = 0;

  for(const ch of sequence){
    /* 2 quiet frames between strums */
    for(let q = 0; q < 2; q++){
      tracker.step(quiet, SR, t, { targets: ['A', 'D'] });
      t += 40;
    }
    /* 4 ringing frames of the strummed chord */
    const buf = synthChord(ch);
    for(let f = 0; f < 4; f++){
      const out = tracker.step(buf, SR, t, { targets: ['A', 'D'], expected: ch });
      if(out.counted) counted.push(out.counted);
      t += 40;
    }
  }

  assert('counted all 4 strums', counted.length === 4, 'got ' + counted.length);
  assert('identified A -> D -> A -> D', counted.map(c => c.chord).join(',') === 'A,D,A,D',
    'got ' + counted.map(c => c.chord).join(','));

  /* Sustained 4-second decaying piano C chord with ±18% string-beating shimmer
     must count exactly 1 chord, never 3 or 4 phantom counts during decay. */
  const susTracker = createEnvelopeTracker({ cooldownMs: 280, settleFrames: 3, gate: 0.006 });
  const susCounted = [];
  let st = 0;
  for(let f = 0; f < 120; f++){
    const sec = f * 0.033;
    const decay = Math.exp(-sec * 1.15);
    const shimmer = 1 + 0.18 * Math.sin(sec * 11.0);
    const amp = 0.28 * decay * shimmer;
    const buf = synthChord('C', { ampScale: amp, noise: 0.002 });
    const out = susTracker.step(buf, SR, st, {});
    if(out.counted) susCounted.push(out.counted);
    st += 33;
  }
  assert('1 sustained C chord counts once', susCounted.length === 1 && susCounted[0].chord === 'C',
    'got ' + susCounted.length + ' (' + susCounted.map(x => x.chord).join(',') + ')');

  /* Repeated strums of the same C chord with partial decay (not full silence) */
  const repTracker = createEnvelopeTracker({ cooldownMs: 280, settleFrames: 3, gate: 0.006 });
  const repCounted = [];
  let rt = 0;
  for(let strum = 0; strum < 3; strum++){
    for(let f = 0; f < 18; f++){
      const amp = 0.26 * Math.exp(-(f * 0.033) * 2.8);
      const buf = synthChord('C', { ampScale: amp, noise: 0.002 });
      const out = repTracker.step(buf, SR, rt, { expected: 'C', targets: ['C'] });
      if(out.counted) repCounted.push(out.counted);
      rt += 33;
    }
  }
  assert('3 repeated C strums count 3 times', repCounted.length === 3,
    'got ' + repCounted.length);

  /* Guitar G7 with rolled bass-to-treble onset & strong B2 3rd harmonic (F#4)
     + B3 3rd harmonic (F#5) must count once as G7 without Bm/Gmaj7 double-split. */
  const SR_G = 48000, WIN_G = 4096;
  function makeRolledStrum(notesHz, durSec, onsetSpreadSec, boostThirds){
    const len = Math.floor(SR_G * durSec);
    const out = new Float32Array(len);
    notesHz.forEach((hz, idx) => {
      const startSample = Math.floor(idx * onsetSpreadSec * SR_G);
      const isLowB = hz < 130;
      const w1 = isLowB ? 0.12 : 1.0;
      const w2 = isLowB ? 0.90 : 0.70;
      const w3 = boostThirds && (Math.abs(hz - 123.47) < 2 || Math.abs(hz - 246.94) < 2) ? 0.85 : 0.45;
      for(let i = startSample; i < len; i++){
        const t = (i - startSample) / SR_G;
        const env = Math.min(1, t / 0.012) * Math.exp(-t * 1.4);
        out[i] += 0.16 * env * (
          w1 * Math.sin(2 * Math.PI * hz * t) +
          w2 * Math.sin(2 * Math.PI * hz * 2 * t) +
          w3 * Math.sin(2 * Math.PI * hz * 3 * t) +
          0.25 * Math.sin(2 * Math.PI * hz * 4 * t)
        );
      }
    });
    return out;
  }
  const g7Seq = [
    makeRolledStrum([98.00, 123.47, 146.83, 196.00, 246.94, 349.23], 1.5, 0.018, true),
    makeRolledStrum([130.81, 164.81, 196.00, 261.63, 329.63], 1.5, 0.014, false),
    makeRolledStrum([98.00, 123.47, 146.83, 196.00, 246.94, 349.23], 1.5, 0.018, true),
    makeRolledStrum([130.81, 164.81, 196.00, 261.63, 329.63], 1.5, 0.014, false)
  ];
  const g7Tr = createEnvelopeTracker({ cooldownMs: 280, settleFrames: 3, gate: 0.008 });
  const g7Counted = [];
  let g7Now = 0;
  for(let si = 0; si < g7Seq.length; si++){
    const seg = g7Seq[si];
    for(let off = 0; off + WIN_G <= seg.length; off += Math.floor(SR_G * 0.033)){
      const r = g7Tr.step(seg.subarray(off, off + WIN_G), SR_G, g7Now, {
        targets: ['G7', 'C'], expected: si % 2 === 0 ? 'G7' : 'C'
      });
      if(r.counted) g7Counted.push(r.counted.chord);
      g7Now += 33;
    }
    g7Now += 250;
  }
  assert('rolled guitar G7 <-> C (with B2/B3 3rd harmonics) counts 4 cleanly',
    g7Counted.length === 4 && g7Counted.join(',') === 'G7,C,G7,C',
    'got ' + g7Counted.length + ' (' + g7Counted.join(',') + ')');

  /* Custom guitar tab shapes: 3-string easy G7 (xxx001) & user-customized fret */
  const g7Tabs = getChordTabs('G7');
  assert('G7 has multiple preset guitar tab shapes', g7Tabs.length >= 4, 'got ' + g7Tabs.length);
  const easy3Frets = [-1, -1, -1, 0, 0, 1];
  const easy3Notes = fretsToVoicing(easy3Frets, 440).map(v => v.note);
  const easy3Wave = synthChord(easy3Notes);
  const easy3Res = detectChord(easy3Wave, SR, {
    targets: ['G7', 'C'],
    expected: 'G7',
    customTabs: { 'G7': easy3Frets }
  });
  assert('custom 3-string G7 tab (xxx001) matches G7 at >=90% accuracy',
    easy3Res.chord === 'G7' && easy3Res.matchedTarget && easy3Res.accuracy >= 90,
    'got ' + easy3Res.chord + ' acc=' + easy3Res.accuracy);

  const customFretG7 = [3, 2, 0, 0, 0, 2]; // user modified 1st string to fret 2
  const customWave = synthChord(fretsToVoicing(customFretG7, 440).map(v => v.note));
  const customRes = detectChord(customWave, SR, {
    targets: ['G7', 'C'],
    expected: 'G7',
    customTabs: { 'G7': customFretG7 }
  });
  assert('user-adjusted G7 tab matches G7 when customTabs provided',
    customRes.chord === 'G7' && customRes.matchedTarget && customRes.accuracy >= 90,
    'got ' + customRes.chord + ' acc=' + customRes.accuracy);
}

console.log('\nSilence and white noise must report no chord');
{
  const quiet = new Float32Array(WIN);
  const r1 = detectChord(quiet, SR);
  assert('silence', r1.chord === null && r1.accuracy === 0);

  const hiss = new Float32Array(WIN);
  for(let i = 0; i < WIN; i++) hiss[i] = (Math.random() * 2 - 1) * 0.3;
  const r2 = detectChord(hiss, SR);
  assert('white noise', r2.chord === null, 'got ' + r2.chord);
}

console.log('\nSpeed');
{
  const x = synthChord('G');
  const t0 = process.hrtime.bigint();
  const RUNS = 100;
  for(let i = 0; i < RUNS; i++) detectChord(x, SR);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
  assert('per chord detection', ms < 8, ms.toFixed(2) + ' ms');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
