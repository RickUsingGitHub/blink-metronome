/* The chord check: plucked strings and strums are synthesised as sound over
   time, cut into the same overlapping frames the app reads from the mic, and
   run through the same listeners and diagnosers.
   Run: node tests/check.test.js */

import {
  diagnoseString, createPluckListener,
  diagnoseStrum, summariseStrum, createStrumListener, averageFrames,
  chordStrings, noteName
} from '../js/check.js';
import { extractChroma, getChordTabs, rateChordAccuracy, buildCustomChord, STANDARD_STRINGS } from '../js/chord.js';
import { detectPitch } from '../js/pitch.js';

const SR = 48000;
const WIN = 4096;          // analyser frame, as in the app
const HOP = 1584;          // 33 ms between reads, as in the app

let pass = 0, fail = 0;
function check(label, ok, detail){
  ok ? pass++ : fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label.padEnd(52) + (detail ? ' ' + detail : ''));
}

/* ---------- sound ---------- */
const midiHz = (m, cents = 0) => 440 * Math.pow(2, (m - 69 + cents / 100) / 12);

/* A plucked string: harmonics that fade faster the higher they are, a short
   attack, and an exponential decay with time constant `tau` seconds. */
function addString(x, start, midi, { tau = 1.4, cents = 0, gain = 1, rattle = 0, seed = 0 } = {}){
  const f0 = midiHz(midi, cents);
  const s0 = Math.floor(start * SR);
  for(let i = s0; i < x.length; i++){
    const t = (i - s0) / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / tau);
    if(t > 0.01 && env < 1e-4) break;      // faded out (the attack itself starts at 0)
    let s = 0;
    for(let h = 1; h <= 8; h++){
      if(f0 * h > SR * 0.45) break;
      s += (1 / Math.pow(h, 0.95)) * Math.exp(-t * (h - 1) * 0.35) * Math.sin(2 * Math.PI * f0 * h * t + seed * h);
    }
    if(rattle) s += (Math.random() * 2 - 1) * rattle * (1 + 0.8 * Math.sin(2 * Math.PI * f0 * t));
    x[i] += s * env * gain * 0.2;
  }
}

/* A dead thud: what a properly muted string gives when picked. */
function addThud(x, start){
  const s0 = Math.floor(start * SR);
  for(let i = s0; i < x.length; i++){
    const t = (i - s0) / SR;
    const env = Math.exp(-t / 0.02);
    if(env < 1e-4) break;
    x[i] += (Math.random() * 2 - 1) * env * 0.08;
  }
}

function room(seconds, noise = 0.0015){
  const x = new Float32Array(Math.floor(seconds * SR));
  for(let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * noise;
  return x;
}

function* frames(x){
  for(let end = WIN; end <= x.length; end += HOP){
    yield { t: end / SR, buf: x.subarray(end - WIN, end) };
  }
}

const rmsOf = buf => { let s = 0; for(let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };

/* Pluck one string of a shape the way the app listens to it. */
function listenToPluck(x){
  const L = createPluckListener({ gate: 0.006 });
  let result = null;
  for(const f of frames(x)){
    const p = detectPitch(f.buf, SR);
    const r = L.step({ t: f.t, rms: rmsOf(f.buf), hz: p.hz, clarity: p.clarity });
    if(r){ result = r; break; }
  }
  return result;
}

function pluck(frets, idx, opts = {}){
  const x = room(2.4);
  const strs = chordStrings(frets);
  const s = strs[idx];
  if(opts.thud){ addThud(x, 0.3); }
  else{
    const playedFret = opts.fret !== undefined ? opts.fret : (s.muted ? 0 : s.fret);
    const midi = opts.midi !== undefined ? opts.midi : s.openMidi + playedFret;
    addString(x, 0.3, midi, opts);
  }
  const heard = listenToPluck(x);
  return { heard, d: heard ? diagnoseString(heard, frets, idx) : null };
}

const C = getChordTabs('C')[0].frets;     // x 3 2 0 1 0
const D = getChordTabs('D')[0].frets;     // x x 0 2 3 2
const G = getChordTabs('G')[0].frets;     // 3 2 0 0 0 3

/* ================================================================= */
console.log('\nOne string at a time');
{
  let r = pluck(C, 1);                                    // string 5, fret 3, C3
  check('C chord, string 5 played right: Clean', r.d && r.d.status === 'ok', r.d && r.d.title);

  r = pluck(C, 2);                                        // string 4, fret 2, E3
  check('C chord, string 4 played right: Clean', r.d && r.d.status === 'ok', r.d && r.d.title);

  r = pluck(C, 1, { fret: 4 });
  check('one fret too high: names fret 4', r.d && r.d.status === 'fret' && /fret 4/.test(r.d.title), r.d && r.d.title);
  check('...and says to move towards the headstock', r.d && /headstock/.test(r.d.tip));

  r = pluck(C, 1, { fret: 2 });
  check('one fret too low: names fret 2', r.d && r.d.status === 'fret' && /fret 2/.test(r.d.title), r.d && r.d.title);
  check('...and says to move towards the body', r.d && /body/.test(r.d.tip));

  r = pluck(C, 2, { fret: 0 });
  check('finger not pressing: Ringing open', r.d && r.d.status === 'open', r.d && r.d.title);

  r = pluck(C, 3, { fret: 2 });                            // G string should be open
  check('open string being touched at fret 2: Should be open', r.d && r.d.status === 'fret' && /open/i.test(r.d.title), r.d && r.d.title);

  r = pluck(C, 1, { tau: 0.12 });
  check('right note that dies fast: damped', r.d && r.d.status === 'dull', r.d && (r.d.title + ' sustain ' + r.heard.sustainSec.toFixed(2)));

  r = pluck(C, 1, { cents: 22 });
  check('22 cents sharp on a fretted string', r.d && r.d.status === 'tune' && /sharp/.test(r.d.title), r.d && r.d.title);
  check('...suggests easing finger pressure', r.d && /Pressing too hard/.test(r.d.tip));

  r = pluck(C, 3, { cents: -25 });
  check('25 cents flat on an open string: retune', r.d && r.d.status === 'tune' && /flat/.test(r.d.title) && /Tuner/.test(r.d.tip), r.d && r.d.title);

  r = pluck(C, 1, { cents: 6 });
  check('6 cents off still counts as Clean', r.d && r.d.status === 'ok', r.d && r.d.title);

  r = pluck(C, 4, { midi: STANDARD_STRINGS[3].midi });     // asked for string 2 (C4), plucked open G3
  check('plucked the wrong string: says so', r.d && r.d.status === 'string', r.d && r.d.title + ' — ' + r.d.detail);

  r = pluck(C, 1, { thud: true });
  check('a pick on a dead string: No clear note', r.d && r.d.status === 'muffled', r.d && r.d.title);
}

console.log('\nStrings the chord leaves out');
{
  let r = pluck(C, 0);                                     // low E rings open, but C mutes it
  check('C chord, low E rings: flagged', r.d && r.d.status === 'rings', r.d && r.d.title);
  r = pluck(C, 0, { thud: true });
  check('C chord, low E muted properly: Muted — good', r.d && r.d.status === 'quiet', r.d && r.d.title);
  r = pluck(D, 1);
  check('D chord, A string rings: flagged', r.d && r.d.status === 'rings', r.d && r.d.title);
}

console.log('\nQuiet room: nothing triggers');
{
  const L = createPluckListener({ gate: 0.006 });
  let fired = false;
  for(const f of frames(room(2))){
    const p = detectPitch(f.buf, SR);
    if(L.step({ t: f.t, rms: rmsOf(f.buf), hz: p.hz, clarity: p.clarity })) fired = true;
  }
  check('room noise alone never counts as a pluck', !fired);
}

/* ================================================================= */
function strum(frets, played, { cents = {}, stagger = 0.012 } = {}){
  const x = room(1.6);
  played.forEach((f, i) => {
    if(!(f >= 0)) return;
    addString(x, 0.3 + i * stagger, STANDARD_STRINGS[i].midi + f, { cents: cents[i] || 0, seed: i * 0.7 });
  });
  const L = createStrumListener({ gate: 0.006 });
  let info = null;
  for(const f of frames(x)){
    const r = L.step({ t: f.t, info: extractChroma(f.buf, SR) });
    if(r){ info = r; break; }
  }
  const strings = info ? diagnoseStrum(info, frets) : [];
  return { info, strings, byString: n => strings.find(s => s.idx === 6 - n) };
}

console.log('\nWhole strum');
for(const ch of ['C', 'G', 'D', 'A', 'Am', 'E', 'Em']){
  const frets = getChordTabs(ch)[0].frets;
  const r = strum(frets, frets);
  const sum = summariseStrum(r.strings);
  check(ch + ' strummed right: no problems reported', r.info && sum.issues.length === 0,
        sum.issues.map(i => (6 - i.idx) + ':' + i.status).join(' ') || sum.headline);
  if(r.info){
    const m = rateChordAccuracy(buildCustomChord(ch, frets), r.info);
    check(ch + ' strummed right: purity and fullness high', m.purity >= 80 && m.completeness >= 75,
          'purity ' + m.purity + ' fullness ' + m.completeness + ' tuning ' + m.tuning);
  }
}

{
  let p = C.slice(); p[2] = -1;                            // string 4 (E3) silent
  let r = strum(C, p);
  check('C, string 4 not ringing: Not ringing', r.byString(4) && r.byString(4).status === 'silent', r.byString(4) && r.byString(4).title);

  p = C.slice(); p[1] = 4;                                 // string 5 on fret 4 instead of 3
  r = strum(C, p);
  check('C, string 5 on the wrong fret: names fret 4', r.byString(5) && r.byString(5).status === 'fret' && /fret 4/.test(r.byString(5).title),
        r.byString(5) && r.byString(5).title);

  p = C.slice(); p[2] = 0;                                 // string 4 rings open (D3)
  r = strum(C, p);
  check('C, string 4 ringing open: Ringing open', r.byString(4) && r.byString(4).status === 'open', r.byString(4) && r.byString(4).title);

  p = C.slice(); p[0] = 0;                                 // low E rings in a C chord
  r = strum(C, p);
  check('C, low E ringing: Should be muted', r.byString(6) && r.byString(6).status === 'rings', r.byString(6) && r.byString(6).title);

  /* Found in the browser test: low E rings AND string 4 (E3) is missing. The
     stray E2's 2nd harmonic sits on E3 and must not pass for string 4. */
  p = C.slice(); p[0] = 0; p[2] = -1;
  r = strum(C, p);
  check('C, low E rings + string 4 missing: low E flagged', r.byString(6) && r.byString(6).status === 'rings', r.byString(6) && r.byString(6).title);
  check('...and string 4 is not passed as ringing', r.byString(4) && r.byString(4).status !== 'ok', r.byString(4) && r.byString(4).title);

  p = D.slice(); p[1] = 0;                                 // open A rings in a D chord
  r = strum(D, p);
  check('D, A string ringing: Should be muted', r.byString(5) && r.byString(5).status === 'rings', r.byString(5) && r.byString(5).title);

  p = G.slice(); p[4] = -1;                                // G chord, string 2 (B3) silent — shared with B2
  r = strum(G, p);
  const s2 = r.byString(2);
  check('G, string 2 silent (doubles B2): silent or honest "can\'t tell"', s2 && (s2.status === 'silent' || s2.status === 'unsure'), s2 && s2.title);
  check('...and never claimed to ring', s2 && s2.status !== 'ok');

  /* In a C chord, string 5's C3 has its 2nd harmonic on string 2's C4, which is
     where the analyser reads low notes' tuning — so a strum can't judge string
     5's tuning. It must say so rather than guess, and must not blame string 5
     for string 2 being out. (String by string reads it exactly, tested above.) */
  r = strum(C, C, { cents: { 1: 30 } });
  const t5 = r.byString(5);
  check('C, string 5 sharp: not misdiagnosed, says tuning unreadable', t5 && t5.status === 'ok' && /can't be read/.test(t5.detail),
        t5 && (t5.title + ' — ' + t5.detail));

  r = strum(C, C, { cents: { 4: 30 } });                   // string 2 (C4) sharp
  const s2c = r.byString(2), s5c = r.byString(5);
  check('C, string 2 30 cents sharp: blamed on string 2', s2c && s2c.status === 'tune' && /sharp/.test(s2c.title),
        s2c && (s2c.title + ' — ' + s2c.detail));
  check('...and not on string 5, which shares its harmonic', s5c && s5c.status === 'ok', s5c && s5c.title);

  r = strum(C, C, { cents: { 2: -30 } });                  // string 4 noticeably flat
  const t4 = r.byString(4);
  check('C, string 4 30 cents flat: Rings, but flat', t4 && t4.status === 'tune' && /flat/.test(t4.title), t4 && (t4.title + ' — ' + t4.detail));

  r = strum(C, C, { cents: { 1: 8, 2: -6 } });             // small, normal drift
  const ok5 = r.byString(5), ok4 = r.byString(4);
  check('a few cents of drift is not flagged', ok5 && ok5.status === 'ok' && ok4 && ok4.status === 'ok',
        (ok5 && ok5.status) + ' / ' + (ok4 && ok4.status));
}

console.log('\nNames');
check('noteName', noteName(40) === 'E2' && noteName(61) === 'C#4');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
