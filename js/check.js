/* Chord check — what is wrong with a chord shape, string by string.

   Two ways in:
   - one string at a time: exact pitch (pitch.js) tells us precisely which fret
     was played, how far out of tune it is, and — from how fast it dies away —
     whether something is damping it;
   - the whole strum: per-note strengths from chord.js tell us which strings
     rang, which sounded a neighbouring fret, and which should have been muted.

   Everything here is pure: the listeners take one analysed frame at a time and
   the diagnosers take their results, so tests drive them under node with no
   microphone. */

import { STANDARD_STRINGS, NOTE_LO, NOTE_HI } from './chord.js';
import { NOTE_NAMES } from './pitch.js';

/* frets[] runs low E (index 0, string 6) to high E (index 5, string 1). */
const STRING_NAMES = ['low E', 'A', 'D', 'G', 'B', 'high E'];

export function noteName(midi){
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function stringLabel(idx){
  return 'string ' + (6 - idx) + ' (' + STRING_NAMES[idx] + ')';
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many) => n === 1 ? one : many;

export function chordStrings(frets){
  return frets.map((f, i) => {
    const s = STANDARD_STRINGS[i];
    const muted = !(f >= 0);
    return {
      idx: i,
      string: s.string,
      label: s.label,
      name: STRING_NAMES[i],
      openMidi: s.midi,
      fret: muted ? -1 : f,
      muted,
      midi: muted ? null : s.midi + f
    };
  });
}

/* Harmonics of a lower string land on these intervals above it. A string whose
   note sits there shares its sound with that lower string, so a strum cannot
   always tell whether it rang by itself. */
const HARMONIC_STEPS = [12, 19, 24, 28, 31];

/* sources: the MIDI notes actually sounding below — the strings the shape
   plays, plus any muted string caught ringing. */
function sharedWithLower(sources, s){
  return sources.some(m => m < s.midi && HARMONIC_STEPS.includes(s.midi - m));
}

/* =================================================================
   One string
   ================================================================= */

export const STRING_TUNING_OK  = 12;    // cents either way that count as in tune
export const SHORT_SUSTAIN_SEC = 0.45;  // a free string rings far longer than this

/* pluck: { heardHz, clarity, pitchedFrac, sustainSec } from createPluckListener.
   Returns { status, title, detail, tip, heard } where status is one of
   ok · tune · dull · open · fret · string · octave · wrong · muffled ·
   rings (a muted string ringing) · quiet (a muted string, correctly silent).

   Fret buzz is deliberately not judged: the pitch analysis filters out the
   rattle, and through a phone mic buzz cannot be told reliably from pick
   noise — a wrong "buzz" verdict would send you fixing the wrong thing. */
export function diagnoseString(pluck, frets, idx, a4 = 440){
  const strs = chordStrings(frets);
  const s = strs[idx];
  const who = stringLabel(idx);
  const heardHz = pluck && pluck.heardHz > 0 ? pluck.heardHz : 0;
  const pitched = heardHz > 0 && pluck.pitchedFrac >= 0.3;

  let heard = null;
  if(pitched){
    const v = 69 + 12 * Math.log2(heardHz / a4);
    const midi = Math.round(v);
    heard = { midi, note: noteName(midi), cents: Math.round((v - midi) * 100), fret: midi - s.openMidi };
  }
  const out = (status, title, detail, tip) => ({ status, title, detail, tip: tip || '', heard });

  /* A string the shape leaves out: the check is that it stays quiet. */
  if(s.muted){
    if(pitched && pluck.sustainSec >= 0.35){
      return out('rings', 'This string is ringing',
        cap(who) + ' should stay silent in this chord, but it rang out' +
        (heard ? ' as ' + heard.note : '') + '.',
        idx === 0
          ? 'Start your strum from string 5, or let your thumb over the neck rest lightly on the low E.'
          : 'Let the fingertip on the string next to it lean over just enough to touch it, or aim your strum past it.');
    }
    return out('quiet', 'Muted — good', cap(who) + ' stays quiet, as it should.');
  }

  const want = noteName(s.midi);
  const where = s.fret === 0 ? 'open' : 'fret ' + s.fret;

  if(!pitched){
    return out('muffled', 'No clear note',
      cap(who) + ' sounds dead or muffled — it should ring as ' + want + ' (' + where + ').',
      s.fret === 0
        ? 'Something is touching this open string. Arch your fingers so the tips come straight down and clear it.'
        : 'Press firmly with the very tip of your finger, just behind fret ' + s.fret + ', and keep neighbouring fingers off it.');
  }

  /* The right note. */
  if(heard.midi === s.midi){
    if(pluck.sustainSec < SHORT_SUSTAIN_SEC){
      return out('dull', 'Right note, but it dies away fast',
        cap(who) + ' plays ' + want + ', then fades in under half a second — something is damping it.',
        'Usually the underside of a neighbouring finger is resting on it. Arch that finger more so it only touches its own string.');
    }
    const c = heard.cents;
    if(Math.abs(c) > STRING_TUNING_OK){
      const sharp = c > 0;
      return out('tune', Math.abs(c) + ' ' + plural(Math.abs(c), 'cent', 'cents') + (sharp ? ' sharp' : ' flat'),
        cap(who) + ' plays the right note, ' + want + ', but ' + (sharp ? 'a little high.' : 'a little low.'),
        sharp && s.fret > 0
          ? 'Pressing too hard pulls a note sharp — ease off. If the open string is sharp too, retune it on the Tuner tab.'
          : 'Retune this string on the Tuner tab.');
    }
    return out('ok', 'Clean',
      cap(who) + ' rings as ' + want + (c === 0 ? ', bang in tune.' : ', ' + Math.abs(c) + ' ' +
        plural(Math.abs(c), 'cent', 'cents') + (c > 0 ? ' sharp' : ' flat') + ' — fine.'));
  }

  /* A different note. Work out the likeliest physical cause. */
  const playedFret = heard.fret;

  if(playedFret === 0 && s.fret > 0){
    return out('open', 'Ringing open',
      cap(who) + ' sounds as the open ' + heard.note + ' — the finger on fret ' + s.fret + ' is not holding it down.',
      'Press firmly with your fingertip just behind fret ' + s.fret + '.');
  }

  if(playedFret > 0 && playedFret <= s.fret + 3){
    if(s.fret === 0){
      return out('fret', 'Should be open',
        cap(who) + ' should ring open as ' + want + ', but it sounds like fret ' + playedFret + ' (' + heard.note + ').',
        'A finger is pressing or leaning on this string. Arch it so the open string can ring.');
    }
    const up = playedFret > s.fret;
    const gap = Math.abs(playedFret - s.fret);
    return out('fret', 'That is fret ' + playedFret,
      cap(who) + ' should be at fret ' + s.fret + ' (' + want + '), but it sounds like fret ' +
        playedFret + ' (' + heard.note + ').',
      'Move that finger ' + gap + ' ' + plural(gap, 'fret', 'frets') + ' towards the ' +
        (up ? 'headstock.' : 'body of the guitar.'));
  }

  const other = strs.find(o => o.idx !== idx && !o.muted && o.midi === heard.midi);
  if(other){
    return out('string', 'Wrong string?',
      'That sounds like ' + stringLabel(other.idx) + ' (' + heard.note + '), not ' + who + '.',
      'Make sure you are plucking ' + who + ' — the one marked on the diagram.');
  }

  if(Math.abs(heard.midi - s.midi) === 12){
    return out('octave', 'Right note, wrong octave',
      'Heard ' + heard.note + ' — an octave ' + (heard.midi > s.midi ? 'above' : 'below') + ' the ' + want + ' this string should give.',
      'Make sure you are plucking ' + who + ', and pluck it near the middle of the string.');
  }

  return out('wrong', 'Heard ' + heard.note,
    cap(who) + ' should give ' + want + ' (' + where + ').',
    'Check your finger against the diagram for this string.');
}

/* Listens for one pluck. Feed it a frame at a time:
     step({ t (s), rms, hz (0 if none), clarity })
   It returns null while waiting or ringing, and once the note has died away
   — or rung for SUSTAIN_CAP seconds — a result for diagnoseString. */
const SUSTAIN_CAP = 1.6;

export function createPluckListener(opts){
  const gate = (opts && opts.gate) || 0.006;
  let armed = true, quiet = 0, prev = 0;
  let collecting = false, t0 = 0, tPeak = 0, peak = 0, frames = 0;
  let pitches = [], clarities = [], early = 0, earlyPitched = 0;

  function begin(t, rms){
    collecting = true; armed = false;
    t0 = t; tPeak = t; peak = rms; frames = 0;
    pitches = []; clarities = []; early = 0; earlyPitched = 0;
  }

  function finish(t){
    collecting = false;
    const sustainSec = Math.max(0, t - tPeak);
    const median = arr => {
      if(!arr.length) return 0;
      const a = arr.slice().sort((x, y) => x - y);
      return a[a.length >> 1];
    };
    // the settled start of the note is the most trustworthy part
    const head = pitches.slice(0, 14);
    return {
      heardHz: median(head),
      clarity: median(clarities.slice(0, 14)),
      pitchedFrac: early ? earlyPitched / early : 0,
      sustainSec: Math.min(SUSTAIN_CAP, sustainSec),
      peakRms: peak
    };
  }

  function step(f){
    const { t, rms } = f;
    let result = null;

    if(rms < gate){ if(++quiet >= 3) armed = true; }
    else quiet = 0;

    const jump = rms >= gate * 1.8 && (armed || (rms > prev * 1.7 && rms > peak * 0.6 && t - t0 > 0.25));
    if(jump && (!collecting || t - t0 > 0.25)){
      begin(t, rms);
    }else if(collecting){
      frames++;
      if(rms > peak && t - t0 < 0.2){ peak = rms; tPeak = t; }
      // skip the pick's transient, then read the note
      if(frames >= 2){
        if(t - t0 <= 0.6){ early++; if(f.hz > 0) earlyPitched++; }
        if(f.hz > 0){ pitches.push(f.hz); clarities.push(f.clarity || 0); }
      }
      const fallen = rms < peak * 0.25 && t - tPeak > 0.08;
      if(fallen || t - tPeak >= SUSTAIN_CAP) result = finish(t);
    }

    prev = rms;
    return result;
  }

  return { step, get listening(){ return collecting; } };
}

/* =================================================================
   Whole strum
   ================================================================= */

/* Thresholds on extractChroma's per-note strength (0..1 of the loudest note).
   Measured on synthesised strums: a string with a note of its own reads 0.3+
   when it rings and ~0 when it does not. One whose note is a harmonic of a
   lower string is different both ways: silent, it can keep ~0.25 of the lower
   string's harmonic; ringing, its own sound can be subtracted away as that
   harmonic and read near 0. So it needs more to count as ringing, and it is
   never called silent on strength alone — only "can't tell". */
const RING = 0.2,  SILENT = 0.1;
const RING_SHARED = 0.3;
const STRUM_TUNING_OK = 20;    // a strum reads tuning more coarsely than one string

/* Fold several analysed frames of one strum into one. */
export function averageFrames(frames){
  const n = NOTE_HI + 1;
  const notes = new Float32Array(n), cents = new Float32Array(n), centsW = new Float32Array(n);
  const chroma = new Float32Array(12);
  let wSum = 0, clarity = 0, rms = 0, bassVotes = new Float32Array(12);
  for(const f of frames){
    if(!f || !(f.clarity > 0) || !f.notes) continue;
    const w = Math.max(1e-9, f.rms * f.rms);
    wSum += w;
    for(let m = NOTE_LO; m <= NOTE_HI; m++){
      notes[m] += f.notes[m] * w;
      if(f.notes[m] > 0){ cents[m] += f.noteCents[m] * f.notes[m] * w; centsW[m] += f.notes[m] * w; }
    }
    for(let i = 0; i < 12; i++) chroma[i] += f.chroma[i] * w;
    if(f.bassPc >= 0) bassVotes[f.bassPc] += w;
    clarity = Math.max(clarity, f.clarity);
    rms = Math.max(rms, f.rms);
  }
  if(wSum <= 0) return null;
  let maxN = 0, maxC = 0;
  for(let m = NOTE_LO; m <= NOTE_HI; m++){
    notes[m] /= wSum;
    if(notes[m] > maxN) maxN = notes[m];
    cents[m] = centsW[m] > 0 ? cents[m] / centsW[m] : 0;
  }
  for(let i = 0; i < 12; i++){ chroma[i] /= wSum; if(chroma[i] > maxC) maxC = chroma[i]; }
  if(maxN > 0) for(let m = NOTE_LO; m <= NOTE_HI; m++) notes[m] /= maxN;
  let activePcs = 0, tw = 0, tc = 0, bassPc = -1, bestBass = 0;
  for(let i = 0; i < 12; i++){
    if(maxC > 0) chroma[i] /= maxC;
    if(chroma[i] >= 0.22) activePcs++;
    if(bassVotes[i] > bestBass){ bestBass = bassVotes[i]; bassPc = i; }
  }
  for(let m = NOTE_LO; m <= NOTE_HI; m++){
    if(notes[m] >= 0.22){ tc += Math.abs(cents[m]) * notes[m]; tw += notes[m]; }
  }
  return { notes, noteCents: cents, chroma, clarity, rms, bassPc, activePcs, avgAbsCents: tw > 0 ? tc / tw : 0 };
}

/* info: an averageFrames() result. Returns one entry per string:
   { idx, status, title, detail, tip } with status
   ok · tune · silent · unsure · open · fret · rings · quiet · range */
export function diagnoseStrum(info, frets){
  const strs = chordStrings(frets);
  const notes = info && info.notes;
  const strength = m => (notes && m >= NOTE_LO && m <= NOTE_HI) ? notes[m] : 0;
  const inRange = m => m >= NOTE_LO && m <= NOTE_HI;
  const expectedMidis = new Set(strs.filter(s => !s.muted).map(s => s.midi));

  /* A muted string is only blamed for ringing if no string the chord plays
     explains that note. One caught ringing also counts as a source of
     harmonics: a stray low E puts its 2nd harmonic on E3, and that must not
     pass for string 4 ringing. */
  const mutedRinging = s => {
    const open = s.openMidi;
    const explained = [...expectedMidis].some(m => m === open || (open > m && HARMONIC_STEPS.includes(open - m)));
    return !explained && inRange(open) && strength(open) >= 0.3;
  };
  const sources = strs.filter(s => !s.muted).map(s => s.midi)
    .concat(strs.filter(s => s.muted && mutedRinging(s)).map(s => s.openMidi));

  return strs.map(s => {
    const who = cap(stringLabel(s.idx));
    const entry = (status, title, detail, tip) => ({ idx: s.idx, status, title, detail, tip: tip || '' });

    if(s.muted){
      const open = s.openMidi;
      if(mutedRinging(s)){
        return entry('rings', 'Should be muted',
          who + ' is ringing as ' + noteName(open) + ' — this chord leaves it out.',
          s.idx === 0
            ? 'Start your strum from string 5, or rest your thumb over the neck lightly on the low E.'
            : 'Aim the strum past it, or let a neighbouring fingertip lean on it just enough to stop it.');
      }
      return entry('quiet', 'Muted', who + ' is left out of this chord.');
    }

    const want = noteName(s.midi);
    if(!inRange(s.midi)){
      return entry('range', 'Check this one alone',
        who + ' plays ' + want + ', too high to pick out of a strum.',
        'Use String by string to check it.');
    }

    const shared = sharedWithLower(sources, s);
    const v = strength(s.midi);
    const ring = shared ? RING_SHARED : RING;

    /* Did this string sound on a different fret? A note one or two frets
       away, or the open string, that no other string in the shape explains.
       That is evidence even when the expected note also reads present: other
       strings' harmonics can fake a reading of it. */
    const candidates = [];
    const tryFret = f => {
      if(f < 0 || f === s.fret) return;
      const m = s.openMidi + f;
      if(!inRange(m) || expectedMidis.has(m)) return;     // another string's note: not evidence
      candidates.push({ f, m, v: strength(m) });
    };
    tryFret(0);
    for(const d of [1, -1, 2, -2]) tryFret(s.fret + d);
    candidates.sort((a, b) => b.v - a.v);
    const best = candidates[0];
    const misplay = best && ((v < ring && best.v >= 0.25) || (best.v >= 0.3 && best.v >= v * 0.5)) ? best : null;

    if(!misplay && v >= ring){
      /* Below E3 the analyser reads a note's tuning from its 2nd harmonic. If
         that harmonic is another string's note, the reading belongs to that
         string — so don't judge this one, or a sharp string 2 in a C chord
         would be blamed on string 5. */
      const centsReadable = !(s.midi < 52 && expectedMidis.has(s.midi + 12));
      if(!centsReadable){
        return entry('ok', 'Rings', who + ' rings as ' + want + ' (its tuning can\'t be read in a strum).');
      }
      const c = Math.round(info.noteCents[s.midi] || 0);
      if(Math.abs(c) > STRUM_TUNING_OK){
        return entry('tune', 'Rings, but ' + (c > 0 ? 'sharp' : 'flat'),
          who + ' rings as ' + want + ', about ' + Math.abs(c) + ' cents ' + (c > 0 ? 'sharp' : 'flat') + '.',
          'Check this string with String by string or on the Tuner tab for an exact reading.');
      }
      return entry('ok', 'Rings', who + ' rings as ' + want + '.');
    }

    if(misplay){
      if(misplay.f === 0){
        return entry('open', 'Ringing open',
          who + ' sounds as the open ' + noteName(misplay.m) + ' — the finger on fret ' + s.fret + ' is not holding it down.',
          'Press firmly with your fingertip just behind fret ' + s.fret + '.');
      }
      const up = misplay.f > s.fret;
      return entry('fret', 'Sounds like fret ' + misplay.f,
        who + ' should be at ' + (s.fret === 0 ? 'open' : 'fret ' + s.fret) + ' (' + want +
          ') but sounds like fret ' + misplay.f + ' (' + noteName(misplay.m) + ').',
        s.fret === 0
          ? 'A finger is pressing or leaning on this string — arch it so the open string rings.'
          : 'Move that finger ' + Math.abs(misplay.f - s.fret) + ' ' + plural(Math.abs(misplay.f - s.fret), 'fret', 'frets') +
            ' towards the ' + (up ? 'headstock.' : 'body of the guitar.'));
    }

    if(!shared && v <= SILENT){
      return entry('silent', 'Not ringing',
        who + ' should give ' + want + ' but did not sound.',
        'A finger may be resting on it, or the strum missed it. Arch your fingers and strum through all the strings the chord uses.');
    }
    return entry('unsure', 'Can\'t tell',
      shared
        ? who + ' should give ' + want + ', but a lower string shares that sound, so a strum can\'t confirm it.'
        : who + ' should give ' + want + ', but it came through only faintly.',
      'Check it with String by string.');
  });
}

/* A short summary line and the strings that need attention, worst first. */
const SEVERITY = { rings: 5, open: 5, fret: 5, silent: 4, tune: 3, unsure: 1, range: 1, ok: 0, quiet: 0 };

export function summariseStrum(strings){
  const issues = strings.filter(s => SEVERITY[s.status] >= 3)
                        .sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || a.idx - b.idx);
  const unsure = strings.filter(s => s.status === 'unsure' || s.status === 'range');
  let headline;
  if(!issues.length){
    headline = unsure.length
      ? 'Every string the strum can judge rang clean'
      : 'Every string rang clean';
  }else{
    headline = issues.length + ' ' + plural(issues.length, 'string needs', 'strings need') + ' attention';
  }
  return { headline, issues, unsure };
}

/* Listens for one strum and gathers the settled frames after the attack.
     step({ t, info }) where info is an extractChroma() result
   Returns null until a strum has been gathered, then an averageFrames() result. */
export function createStrumListener(opts){
  const gate = (opts && opts.gate) || 0.006;
  const keep = (opts && opts.frames) || 6;
  let armed = true, quiet = 0, prev = 0, collecting = false, skip = 0, t0 = 0, frames = [];

  function step(f){
    const rms = f.info.rms;
    let result = null;
    if(rms < gate){ if(++quiet >= 3) armed = true; }
    else quiet = 0;

    const jump = rms >= gate * 1.8 && (armed || (rms > prev * 1.7 && f.t - t0 > 0.3));
    if(jump && !collecting){
      collecting = true; armed = false; skip = 2; frames = []; t0 = f.t;
    }else if(collecting){
      if(skip > 0) skip--;
      else if(f.info.clarity > 0) frames.push(f.info);
      if(frames.length >= keep || f.t - t0 > 0.9){
        collecting = false;
        result = frames.length ? averageFrames(frames) : null;
      }
    }
    prev = rms;
    return result;
  }
  return { step, get listening(){ return collecting; } };
}
