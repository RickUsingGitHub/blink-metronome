/* How harshly chords are graded — one table, from "be gentle with me" to
   "pitch perfect".

   Strictness changes judgement, never facts. A wrong fret, a string ringing
   open or a muted string ringing is reported at every level; what moves is how
   much messiness, drift and damping is forgiven before it counts against you.

   Level 3 is the grading Blink has always used, number for number, so nothing
   changes for anyone who leaves it there. */

export const STRICT_DEFAULT = 3;

export const STRICTNESS = [
  {
    level: 1,
    name: 'I\'m a beginner, be gentle with me',
    short: 'Beginner',
    desc: 'Messy is fine. A chord with a note missing still counts as the one you were going for, tuning can drift, and only real problems are flagged.',
    verdict: [72, 58, 40],    // score needed for Sealed / Clean / Fair
    acceptPartial: true,      // C with its 3rd missing still counts as C, scored down
    partialMax: 71,           // ...but never above Clean: a missing note is not "bang on"
    tuneGrace: 14,            // cents of drift that cost nothing
    tuneSlope: 0.8,           // points lost per cent beyond that
    expectedBonus: 0.12,      // benefit of the doubt towards the chord you meant
    checkTuneOk: 25,          // chord check, one string: cents still "in tune"
    strumTuneOk: 32,          // chord check, strum: cents still "in tune"
    shortSustain: 0.3         // chord check: a note dying sooner than this is damped
  },
  {
    level: 2,
    name: 'Getting there',
    short: 'Learner',
    desc: 'A little give: small slips and a few cents of drift won\'t count against you.',
    verdict: [82, 68, 50],
    tuneGrace: 8,
    tuneSlope: 1.2,
    expectedBonus: 0.08,
    checkTuneOk: 18,
    strumTuneOk: 26,
    shortSustain: 0.38
  },
  {
    level: 3,
    name: 'Solid player',
    short: 'Solid',
    desc: 'The standard grading — clean chords, reasonably in tune.',
    verdict: [90, 78, 62],
    tuneGrace: 3,
    tuneSlope: 1.75,
    expectedBonus: 0.04,
    checkTuneOk: 12,
    strumTuneOk: 20,
    shortSustain: 0.45
  },
  {
    level: 4,
    name: 'Gigging musician',
    short: 'Gigging',
    desc: 'Stage-ready: full, clean chords and tight tuning.',
    verdict: [94, 86, 72],
    tuneGrace: 2,
    tuneSlope: 2.4,
    expectedBonus: 0.02,
    checkTuneOk: 7,
    strumTuneOk: 15,
    shortSustain: 0.55
  },
  {
    level: 5,
    name: 'I\'m a guitar God',
    short: 'Guitar God',
    desc: 'Pitch perfect or it doesn\'t count. Every string clean and ringing, every note in tune.',
    verdict: [97, 92, 82],
    tuneGrace: 1,
    tuneSlope: 3.2,
    expectedBonus: 0,
    checkTuneOk: 4,
    // a strum reads tuning more coarsely than one string, so this is as tight
    // as it can honestly go; String by string is the exact test
    strumTuneOk: 12,
    shortSustain: 0.65
  }
];

export function strictProfile(level){
  const n = Math.round(Number(level));
  return STRICTNESS.find(s => s.level === n) || STRICTNESS[STRICT_DEFAULT - 1];
}
