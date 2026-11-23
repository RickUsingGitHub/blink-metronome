/* Grading strictness: gentler levels forgive more, stricter ones less; the
   middle level is exactly the grading Blink always used; and facts — a wrong
   chord, a wrong fret, a muted string ringing — are facts at every level.
   Run: node tests/strictness.test.js */

import { STRICTNESS, STRICT_DEFAULT, strictProfile } from '../js/strictness.js';
import { detectChord, rateChordAccuracy, accuracyVerdict, extractChroma, chordVoicing, getChordTabs, NOTE_HI } from '../js/chord.js';
import { diagnoseString, diagnoseStrum } from '../js/check.js';
import { hzFromName } from '../js/pitch.js';

const SR = 48000, WIN = 4096;
let pass = 0, fail = 0;
function check(label, ok, detail){
  ok ? pass++ : fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label.padEnd(58) + (detail ? ' ' + detail : ''));
}
const L = n => strictProfile(n);
const nondecreasing = arr => arr.every((v, i) => i === 0 || v >= arr[i - 1]);
const nonincreasing = arr => arr.every((v, i) => i === 0 || v <= arr[i - 1]);

function synth(notes, cents = 0){
  const x = new Float32Array(WIN);
  notes.forEach((n, idx) => {
    const c = Array.isArray(cents) ? cents[idx] : cents;
    const f0 = hzFromName(n, 440) * Math.pow(2, c / 1200);
    for(let i = 0; i < WIN; i++){
      let s = 0;
      for(let h = 1; h <= 7; h++){
        if(f0 * h >= SR * 0.45) break;
        s += (1 / Math.pow(h, 0.95)) * Math.sin(2 * Math.PI * f0 * h * (i / SR) + idx * 0.61 * h);
      }
      x[i] += s;
    }
  });
  const norm = Math.max(1, Math.sqrt(notes.length));
  for(let i = 0; i < WIN; i++) x[i] = x[i] / norm * 0.22 + (Math.random() * 2 - 1) * 0.008;
  return x;
}
// exactly what ui-lte.js passes the tracker for a level
const opts = (p, extra) => Object.assign({
  tuneGrace: p.tuneGrace, tuneSlope: p.tuneSlope, expectedBonus: p.expectedBonus,
  acceptPartial: !!p.acceptPartial, partialMax: p.partialMax
}, extra);

/* ================================================================= */
console.log('\nThe levels');
{
  check('five levels, 1 to 5', STRICTNESS.length === 5 && STRICTNESS.every((s, i) => s.level === i + 1));
  check('ends are the ones asked for',
        /beginner, be gentle with me/i.test(L(1).name) && /guitar God/i.test(L(5).name), L(1).name + ' … ' + L(5).name);
  check('default is the middle', STRICT_DEFAULT === 3 && L(undefined).level === 3 && L(99).level === 3);
  check('verdict cut-offs rise with strictness', [0, 1, 2].every(k => nondecreasing(STRICTNESS.map(s => s.verdict[k]))));
  check('free tuning drift shrinks', nonincreasing(STRICTNESS.map(s => s.tuneGrace)));
  check('tuning penalty steepens', nondecreasing(STRICTNESS.map(s => s.tuneSlope)));
  check('benefit of the doubt shrinks to none', nonincreasing(STRICTNESS.map(s => s.expectedBonus)) && L(5).expectedBonus === 0);
  check('chord check: string tuning tolerance shrinks', nonincreasing(STRICTNESS.map(s => s.checkTuneOk)));
  check('chord check: strum tuning tolerance shrinks', nonincreasing(STRICTNESS.map(s => s.strumTuneOk)));
  check('chord check: damping threshold rises', nondecreasing(STRICTNESS.map(s => s.shortSustain)));
  check('only the gentlest level accepts a chord with a note missing',
        STRICTNESS.filter(s => s.acceptPartial).map(s => s.level).join() === '1');
  check('...and caps it below Sealed', STRICTNESS.filter(s => s.acceptPartial).every(s => s.partialMax < s.verdict[0]));
}

console.log('\nThe middle level is the grading Blink always used');
{
  const s = L(3);
  check('same numbers as before', s.verdict.join() === '90,78,62' && s.tuneGrace === 3 && s.tuneSlope === 1.75 &&
        s.expectedBonus === 0.04 && s.checkTuneOk === 12 && s.strumTuneOk === 20 && s.shortSustain === 0.45 && !s.acceptPartial);
  const buf = synth(chordVoicing('C').map(v => v.note), [9, -11, 7, -8, 10]);
  const plain = detectChord(buf, SR, { expected: 'C', targets: ['C'] });
  const lv3 = detectChord(buf, SR, opts(s, { expected: 'C', targets: ['C'] }));
  check('detectChord: no strictness = level 3', plain.accuracy === lv3.accuracy && plain.tuning === lv3.tuning && plain.chord === lv3.chord,
        plain.accuracy + ' vs ' + lv3.accuracy);
  for(const acc of [95, 85, 70, 50]){
    check('verdict for ' + acc + ': no strictness = level 3', accuracyVerdict(acc).short === accuracyVerdict(acc, s.verdict).short);
  }
}

console.log('\nThe same slightly out-of-tune C, graded at each level');
{
  const buf = synth(chordVoicing('C').map(v => v.note), [14, -14, 12, -12, 14]);
  const res = STRICTNESS.map(p => detectChord(buf, SR, opts(p, { expected: 'C', targets: ['C'] })));
  const tunings = res.map(r => r.tuning), accs = res.map(r => r.accuracy);
  check('tuning score falls as strictness rises', nonincreasing(tunings) && tunings[0] > tunings[4], tunings.join(' → '));
  check('accuracy falls as strictness rises', nonincreasing(accs) && accs[0] > accs[4], accs.join(' → '));
  const v1 = accuracyVerdict(accs[0], L(1).verdict), v5 = accuracyVerdict(accs[4], L(5).verdict);
  const rank = { Sealed: 3, Clean: 2, Fair: 1, Sloppy: 0 };
  check('a beginner is graded better than a guitar God for it', rank[v1.short] > rank[v5.short], v1.short + ' vs ' + v5.short);
}

console.log('\nA chord with a note missing');
{
  // C with both E strings muted: only C and G sound — heard as C5
  const buf = synth(['C3', 'G3', 'C4', 'G4']);
  const r1 = detectChord(buf, SR, opts(L(1), { expected: 'C', targets: ['C'] }));
  check('Beginner: counts as the C you meant', r1.chord === 'C' && r1.matchedTarget, r1.chord + (r1.matchedTarget ? ' ✓' : ' ✗'));
  check('...and says what was really heard', r1.partial === true && r1.heardChord === 'C5', r1.heardChord);
  check('...scored down for the missing note', r1.completeness < 90, 'fullness ' + r1.completeness);
  const v1 = accuracyVerdict(r1.accuracy, L(1).verdict).short;
  check('...graded Clean at best, never Sealed', v1 !== 'Sealed', r1.accuracy + '% → ' + v1);
  for(const n of [2, 3, 4, 5]){
    const r = detectChord(buf, SR, opts(L(n), { expected: 'C', targets: ['C'] }));
    check(L(n).short + ': it is a wrong chord', !r.matchedTarget && !r.partial, r.chord);
  }
  const r1t = detectChord(buf, SR, opts(L(1), { targets: ['C', 'G'] }));
  check('Beginner, any-order drill: also counts as C', r1t.chord === 'C' && r1t.matchedTarget && r1t.partial, r1t.chord);

  // the right root with a note that does not belong is not "a note missing"
  const stray = synth(['C3', 'G3', 'C4', 'F#4']);
  const rs = detectChord(stray, SR, opts(L(1), { expected: 'C', targets: ['C'] }));
  check('Beginner: a stray wrong note is not excused as "missing"', !rs.partial, rs.chord + (rs.matchedTarget ? ' ✓' : ' ✗'));
}

console.log('\nWrong chords are wrong at every level');
for(const [played, wanted] of [['Am', 'C'], ['D', 'A'], ['G', 'Em'], ['E', 'Am']]){
  const buf = synth(chordVoicing(played).map(v => v.note));
  const verdicts = STRICTNESS.map(p => detectChord(buf, SR, opts(p, { expected: wanted, targets: [wanted] })));
  check(played + ' when ' + wanted + ' was wanted: never counted', verdicts.every(r => !r.matchedTarget),
        verdicts.map(r => r.chord + (r.matchedTarget ? '✓' : '✗')).join(' '));
}

/* ================================================================= */
console.log('\nChord check, one string');
{
  const C = getChordTabs('C')[0].frets;                 // string 5 at fret 3 = C3
  const pluck = (cents, sustain = 1.6, midi = 48) => ({
    heardHz: 440 * Math.pow(2, (midi - 69 + cents / 100) / 12),
    clarity: 0.99, pitchedFrac: 1, sustainSec: sustain
  });
  const at = (p, lv) => diagnoseString(p, C, 1, 440, L(lv)).status;
  const row = p => STRICTNESS.map(s => at(p, s.level));

  let r = row(pluck(16));
  check('16 cents sharp: fine for gentler levels, flagged from Solid up',
        r.join() === 'ok,ok,tune,tune,tune', r.join(' '));
  r = row(pluck(6));
  check('6 cents sharp: only a guitar God hears it', r.join() === 'ok,ok,ok,ok,tune', r.join(' '));
  r = row(pluck(0, 0.4));
  check('a note dying at 0.4 s: damped from Solid up', r.join() === 'ok,ok,dull,dull,dull', r.join(' '));
  r = row(pluck(0, 1.6, 49));
  check('the wrong fret is the wrong fret at every level', r.every(s => s === 'fret'), r.join(' '));
  r = row(pluck(0, 1.6, 45));
  check('ringing open is ringing open at every level', r.every(s => s === 'open'), r.join(' '));
  const ringsLow = STRICTNESS.map(s => diagnoseString(pluck(0, 1.6, 40), C, 0, 440, s).status);
  check('a muted string ringing is flagged at every level', ringsLow.every(s => s === 'rings'), ringsLow.join(' '));
  check('no strictness = Solid', diagnoseString(pluck(16), C, 1).status === at(pluck(16), 3));
}

console.log('\nChord check, whole strum');
{
  const C = getChordTabs('C')[0].frets;                 // x 3 2 0 1 0 → C3 E3 G3 C4 E4
  const strum = (centsE3, lowEring = false) => {
    const notes = new Float32Array(NOTE_HI + 1), noteCents = new Float32Array(NOTE_HI + 1);
    for(const m of [48, 52, 55, 60, 64]) notes[m] = 1;
    if(lowEring) notes[40] = 1;
    noteCents[52] = centsE3;                            // string 4, read from its own fundamental
    return { notes, noteCents, chroma: new Float32Array(12), clarity: 1, rms: 0.1, bassPc: 0, activePcs: 3, avgAbsCents: 0 };
  };
  const row = info => STRICTNESS.map(s => diagnoseStrum(info, C, s).find(x => x.idx === 2).status);
  let r = row(strum(24));
  check('string 4 24 cents sharp: fine for gentler levels, flagged from Solid up',
        r.join() === 'ok,ok,tune,tune,tune', r.join(' '));
  r = row(strum(17));
  check('17 cents: only Gigging and up flag it', r.join() === 'ok,ok,ok,tune,tune', r.join(' '));
  r = row(strum(14));
  check('14 cents: only a guitar God flags it', r.join() === 'ok,ok,ok,ok,tune', r.join(' '));
  const rings = STRICTNESS.map(s => diagnoseStrum(strum(0, true), C, s).find(x => x.idx === 0).status);
  check('a muted string ringing is flagged at every level', rings.every(s => s === 'rings'), rings.join(' '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
