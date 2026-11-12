/* Checks the pitch detector against synthesised strings.
   Run: node tests/pitch.test.js  */

import { detectPitch, noteFromHz, hzFromName } from '../js/pitch.js';

const SR = 48000;
const WIN = 4096;              // what the analyser hands the page

/* A plucked string is a stack of harmonics with a bit of noise, and the
   fundamental is often weaker than the second or third partial — which is
   exactly what makes naive autocorrelation jump an octave. */
function pluck(hz, { partials = 8, noise = 0.01, weakFundamental = false, phase = 0 } = {}){
  const x = new Float32Array(WIN);
  for(let i = 0; i < WIN; i++){
    let s = 0;
    for(let h = 1; h <= partials; h++){
      let amp = 1 / h;
      if(weakFundamental && h === 1) amp *= 0.15;
      s += amp * Math.sin(2 * Math.PI * hz * h * (i / SR) + phase * h);
    }
    s += (Math.random() * 2 - 1) * noise;
    x[i] = s * 0.25;
  }
  return x;
}

let pass = 0, fail = 0;
function check(label, got, want, tolCents){
  const cents = got > 0 ? 1200 * Math.log2(got / want) : NaN;
  const ok = got > 0 && Math.abs(cents) <= tolCents;
  if(ok) pass++; else fail++;
  const shown = got > 0 ? got.toFixed(2) + ' Hz, ' + cents.toFixed(2) + ' cents off' : 'no pitch';
  console.log((ok ? '  ok   ' : '  FAIL ') + label.padEnd(34) + ' want ' + want.toFixed(2) + ' Hz, got ' + shown);
}

console.log('\nGuitar, standard tuning (rich harmonics)');
for(const name of ['E2','A2','D3','G3','B3','E4']){
  const hz = hzFromName(name, 440);
  check(name, detectPitch(pluck(hz), SR).hz, hz, 2);
}

console.log('\nBass, 4-string (low fundamentals)');
for(const name of ['E1','A1','D2','G2']){
  const hz = hzFromName(name, 440);
  check(name, detectPitch(pluck(hz, { partials: 12 }), SR).hz, hz, 3);
}

console.log('\nWeak fundamental — the classic octave trap');
for(const name of ['E2','A2','D3']){
  const hz = hzFromName(name, 440);
  check(name + ' (weak f0)', detectPitch(pluck(hz, { weakFundamental: true })).hz || detectPitch(pluck(hz, { weakFundamental: true }), SR).hz, hz, 3);
}

console.log('\nDeliberately out of tune — the reading must follow');
for(const off of [-40, -12, -5, 5, 12, 40]){
  const base = hzFromName('A2', 440);
  const hz = base * Math.pow(2, off / 1200);
  const got = detectPitch(pluck(hz), SR).hz;
  check('A2 ' + (off > 0 ? '+' : '') + off + ' cents', got, hz, 2);
}

console.log('\nAlternative A4 references');
for(const a4 of [415, 432, 440, 446]){
  const hz = hzFromName('A4', a4);
  const got = detectPitch(pluck(hz, { partials: 6 }), SR).hz;
  check('A4 at ' + a4, got, hz, 2);
  const n = got > 0 ? noteFromHz(got, a4) : null;
  if(n && (n.name !== 'A' || n.octave !== 4)){
    console.log('  FAIL  named it ' + n.name + n.octave + ' instead of A4');
    fail++;
  }else pass++;
}

console.log('\nUkulele and violin');
for(const [inst, notes] of [['uke', ['G4','C4','E4','A4']], ['violin', ['G3','D4','A4','E5']]]){
  for(const name of notes){
    const hz = hzFromName(name, 440);
    check(inst + ' ' + name, detectPitch(pluck(hz, { partials: 6 }), SR).hz, hz, 3);
  }
}

console.log('\nSilence and noise must report nothing');
{
  const quiet = new Float32Array(WIN);
  const r1 = detectPitch(quiet, SR);
  const ok1 = r1.hz === 0;
  console.log((ok1 ? '  ok   ' : '  FAIL ') + 'silence'.padEnd(34) + ' got ' + r1.hz);
  ok1 ? pass++ : fail++;

  const hiss = new Float32Array(WIN);
  for(let i = 0; i < WIN; i++) hiss[i] = (Math.random() * 2 - 1) * 0.3;
  const r2 = detectPitch(hiss, SR);
  const ok2 = r2.hz === 0 || r2.clarity < 0.6;
  console.log((ok2 ? '  ok   ' : '  FAIL ') + 'white noise'.padEnd(34) +
              ' got ' + r2.hz.toFixed(1) + ' clarity ' + r2.clarity.toFixed(2));
  ok2 ? pass++ : fail++;
}

console.log('\nSpeed');
{
  const x = pluck(hzFromName('A2', 440));
  const t0 = process.hrtime.bigint();
  const RUNS = 200;
  for(let i = 0; i < RUNS; i++) detectPitch(x, SR);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
  const ok = ms < 8;
  console.log((ok ? '  ok   ' : '  FAIL ') + 'per detection'.padEnd(34) + ' ' + ms.toFixed(2) + ' ms');
  ok ? pass++ : fail++;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
