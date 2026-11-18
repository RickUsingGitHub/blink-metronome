/* Polyphonic chord detection, accuracy rating and envelope/strum tracking —
   pure functions with no DOM or Web Audio dependencies, so the same code runs
   in the browser and under node in tests/chord.test.js. */

import { NOTE_NAMES, hzFromName } from './pitch.js';

const TARGET_SR = 12000;
const FFT_SIZE  = 4096;               // ~2.93 Hz per bin after 4x decimation

/* Flat/sharp aliases so user-typed chords like Bb, Eb, F#m7 resolve cleanly. */
const ENHARMONIC = {
  'C':0, 'B#':0,
  'C#':1, 'DB':1,
  'D':2,
  'D#':3, 'EB':3,
  'E':4, 'FB':4,
  'F':5, 'E#':5,
  'F#':6, 'GB':6,
  'G':7,
  'G#':8, 'AB':8,
  'A':9,
  'A#':10, 'BB':10,
  'B':11, 'CB':11
};

export const CHORD_TYPES = [
  { id:'maj',  suffix:'',     label:'Major',  intervals:[0, 4, 7],     core:[0, 4, 7],     weights:[1.15, 1.10, 0.85],           prior:1.00 },
  { id:'m',    suffix:'m',    label:'Minor',  intervals:[0, 3, 7],     core:[0, 3, 7],     weights:[1.15, 1.10, 0.85],           prior:1.00 },
  { id:'7',    suffix:'7',    label:'Dom 7',  intervals:[0, 4, 7, 10], core:[0, 4, 10],    weights:[1.10, 1.00, 0.70, 1.05],     prior:0.98 },
  { id:'m7',   suffix:'m7',   label:'Min 7',  intervals:[0, 3, 7, 10], core:[0, 3, 10],    weights:[1.10, 1.00, 0.70, 1.05],     prior:0.98 },
  { id:'maj7', suffix:'maj7', label:'Maj 7',  intervals:[0, 4, 7, 11], core:[0, 4, 11],    weights:[1.10, 1.00, 0.70, 1.05],     prior:0.98 },
  { id:'sus4', suffix:'sus4', label:'Sus 4',  intervals:[0, 5, 7],     core:[0, 5, 7],     weights:[1.12, 1.12, 0.85],           prior:0.96 },
  { id:'sus2', suffix:'sus2', label:'Sus 2',  intervals:[0, 2, 7],     core:[0, 2, 7],     weights:[1.12, 1.12, 0.85],           prior:0.96 },
  { id:'5',    suffix:'5',    label:'Power',  intervals:[0, 7],        core:[0, 7],        weights:[1.20, 1.05],                 prior:0.82 },
  { id:'dim',  suffix:'dim',  label:'Dim',    intervals:[0, 3, 6],     core:[0, 3, 6],     weights:[1.12, 1.05, 1.08],           prior:0.92 },
  { id:'aug',  suffix:'aug',  label:'Aug',    intervals:[0, 4, 8],     core:[0, 4, 8],     weights:[1.12, 1.05, 1.08],           prior:0.92 }
];

export const CHORD_PRESETS = [
  { id:'A-D',      name:'A ↔ D (Classic 1-min changes)', chords:['A', 'D'] },
  { id:'E-A',      name:'E ↔ A (Anchor finger drill)',   chords:['E', 'A'] },
  { id:'G-C',      name:'G ↔ C (Open stretch)',          chords:['G', 'C'] },
  { id:'Am-Em',    name:'Am ↔ Em (Two-finger swap)',     chords:['Am', 'Em'] },
  { id:'D-G',      name:'D ↔ G (Ring finger pivot)',     chords:['D', 'G'] },
  { id:'C-Am',     name:'C ↔ Am (One-finger change)',    chords:['C', 'Am'] },
  { id:'E-Am',     name:'E ↔ Am (Same shape jump)',      chords:['E', 'Am'] },
  { id:'C-G-Am-F', name:'C → G → Am → F (Four-chord loop)', chords:['C', 'G', 'Am', 'F'] },
  { id:'Em-G-D-A', name:'Em → G → D → A (Anthem loop)',  chords:['Em', 'G', 'D', 'A'] },
  { id:'Dm-G7-C',  name:'Dm → G7 → C (ii–V–I)',          chords:['Dm', 'G7', 'C'] }
];

/* Standard guitar voicings for common chords; fallback builds a clean voicing
   from root + intervals so every chord in the 120-chord dictionary can be
   previewed or synthesised. */
export const GUITAR_VOICINGS = {
  'C':    ['C3','E3','G3','C4','E4'],
  'Cm':   ['C3','G3','C4','D#4','G4'],
  'C7':   ['C3','E3','A#3','C4','E4'],
  'Cmaj7':['C3','E3','G3','B3','E4'],
  'D':    ['D3','A3','D4','F#4'],
  'Dm':   ['D3','A3','D4','F4'],
  'D7':   ['D3','A3','C4','F#4'],
  'Dm7':  ['D3','A3','C4','F4'],
  'Dsus4':['D3','A3','D4','G4'],
  'Dsus2':['D3','A3','D4','E4'],
  'E':    ['E2','B2','E3','G#3','B3','E4'],
  'Em':   ['E2','B2','E3','G3','B3','E4'],
  'E7':   ['E2','B2','D3','G#3','B3','E4'],
  'Em7':  ['E2','B2','D3','G3','B3','E4'],
  'F':    ['F2','C3','F3','A3','C4','F4'],
  'Fm':   ['F2','C3','F3','G#3','C4','F4'],
  'Fmaj7':['F3','A3','C4','E4'],
  'G':    ['G2','B2','D3','G3','B3','G4'],
  'Gm':   ['G2','D3','G3','A#3','D4','G4'],
  'G7':   ['G2','B2','D3','G3','B3','F4'],
  'A':    ['A2','E3','A3','C#4','E4'],
  'Am':   ['A2','E3','A3','C4','E4'],
  'A7':   ['A2','E3','G3','C#4','E4'],
  'Am7':  ['A2','E3','G3','C4','E4'],
  'Asus2':['A2','E3','A3','B3','E4'],
  'Asus4':['A2','E3','A3','D4','E4'],
  'B':    ['B2','F#3','B3','D#4','F#4'],
  'Bm':   ['B2','F#3','B3','D4','F#4'],
  'B7':   ['B2','D#3','A3','B3','F#4']
};

/* ---------- chord dictionary & parser ---------- */
const ALL_CHORDS = [];
const CHORD_MAP  = new Map();

for(let root = 0; root < 12; root++){
  const rootName = NOTE_NAMES[root];
  for(const t of CHORD_TYPES){
    const id = rootName + t.suffix;
    const pcs = t.intervals.map(iv => (root + iv) % 12);
    const corePcs = t.core.map(iv => (root + iv) % 12);
    const notes = pcs.map(pc => NOTE_NAMES[pc]);
    const mask = new Float32Array(12);
    t.intervals.forEach((iv, idx) => { mask[(root + iv) % 12] = t.weights[idx]; });
    const entry = {
      id,
      root,
      rootName,
      type: t.id,
      suffix: t.suffix,
      label: rootName + (t.suffix ? ' ' + t.label.toLowerCase() : ' major'),
      intervals: t.intervals,
      pitchClasses: pcs,
      corePcs,
      notes,
      mask,
      prior: t.prior
    };
    ALL_CHORDS.push(entry);
    CHORD_MAP.set(id.toUpperCase(), entry);
  }
}

export function getChord(idOrName){
  if(!idOrName) return null;
  if(typeof idOrName === 'object' && idOrName.id) return idOrName;
  return parseChordName(String(idOrName));
}

export function parseChordName(raw){
  if(!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^([A-Ga-g])([#b♯♭]?)\s*(.*)$/.exec(s);
  if(!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '♯' ? '#' : (m[2] === '♭' || m[2] === 'b') ? 'B' : m[2].toUpperCase();
  const root = ENHARMONIC[letter + acc];
  if(root === undefined) return null;

  let qual = m[3].trim().toLowerCase()
    .replace(/^major7|^maj7|^Δ7|^m7\+/i, 'maj7')
    .replace(/^(?:major|maj|M)$/, '')
    .replace(/^(?:minor7|min7|-7)$/, 'm7')
    .replace(/^(?:minor|min|-)$/, 'm')
    .replace(/^(?:dom7|7th)$/, '7')
    .replace(/^(?:diminished|dim7|o)$/, 'dim')
    .replace(/^(?:augmented|\+)$/, 'aug')
    .replace(/^(?:power|no3)$/, '5');

  const t = CHORD_TYPES.find(x => x.suffix.toLowerCase() === qual || x.id.toLowerCase() === qual);
  if(!t) return null;
  const key = (NOTE_NAMES[root] + t.suffix).toUpperCase();
  return CHORD_MAP.get(key) || null;
}

export function parseChordList(str){
  if(!str || typeof str !== 'string') return [];
  return str
    .split(/[\s,|/→↔\-]+/)
    .map(tok => parseChordName(tok))
    .filter(Boolean)
    .map(c => c.id);
}

export function chordVoicing(idOrName, a4 = 440, customFrets = null){
  if(Array.isArray(customFrets) && customFrets.length === 6){
    const custom = fretsToVoicing(customFrets, a4);
    if(custom.length) return custom;
  }
  const c = getChord(idOrName);
  if(!c) return [];
  const preset = GUITAR_VOICINGS[c.id];
  if(preset) return preset.map(n => ({ note: n, hz: hzFromName(n, a4) }));

  const baseMidi = c.root >= 4 ? 40 + (c.root - 4) : 48 + c.root; // E2..D#3
  const midis = [
    baseMidi,
    baseMidi + (c.intervals[2] || 7),
    baseMidi + 12,
    baseMidi + 12 + c.intervals[1],
    baseMidi + 12 + (c.intervals[3] || c.intervals[2] || 7)
  ];
  return midis.map(midi => {
    const name = NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
    return { note: name, hz: a4 * Math.pow(2, (midi - 69) / 12) };
  });
}

/* ---------- 6-string guitar chord tabs & custom voicings ---------- */
export const STANDARD_STRINGS = [
  { string:6, label:'E', note:'E2', midi:40 },
  { string:5, label:'A', note:'A2', midi:45 },
  { string:4, label:'D', note:'D3', midi:50 },
  { string:3, label:'G', note:'G3', midi:55 },
  { string:2, label:'B', note:'B3', midi:59 },
  { string:1, label:'e', note:'E4', midi:64 }
];

export const CHORD_TAB_PRESETS = {
  'C': [
    { name:'Open',       frets:[-1, 3, 2, 0, 1, 0] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 0, 1, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 0, 1, 0] },
    { name:'Full /G',    frets:[3, 3, 2, 0, 1, 0] }
  ],
  'Cm': [
    { name:'Barre 3rd',  frets:[-1, 3, 5, 5, 4, 3] },
    { name:'Easy 4-str', frets:[-1, -1, 5, 5, 4, 3] },
    { name:'Open',       frets:[-1, 3, 1, 0, 1, 3] }
  ],
  'C7': [
    { name:'Open',       frets:[-1, 3, 2, 3, 1, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 3, 1, 0] }
  ],
  'Cmaj7': [
    { name:'Open',       frets:[-1, 3, 2, 0, 0, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 0, 0, 0] }
  ],
  'D': [
    { name:'Open',       frets:[-1, -1, 0, 2, 3, 2] },
    { name:'Open /A',    frets:[-1, 0, 0, 2, 3, 2] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 2, 3, 2] }
  ],
  'Dm': [
    { name:'Open',       frets:[-1, -1, 0, 2, 3, 1] },
    { name:'Open /A',    frets:[-1, 0, 0, 2, 3, 1] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 2, 3, 1] }
  ],
  'D7': [
    { name:'Open',       frets:[-1, -1, 0, 2, 1, 2] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 2, 1, 2] }
  ],
  'Dm7': [
    { name:'Open',       frets:[-1, -1, 0, 2, 1, 1] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 2, 1, 1] }
  ],
  'Dsus4': [
    { name:'Open',       frets:[-1, -1, 0, 2, 3, 3] }
  ],
  'Dsus2': [
    { name:'Open',       frets:[-1, -1, 0, 2, 3, 0] }
  ],
  'E': [
    { name:'Open',       frets:[0, 2, 2, 1, 0, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 1, 0, 0] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 1, 0, 0] }
  ],
  'Em': [
    { name:'Open',       frets:[0, 2, 2, 0, 0, 0] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 0, 0, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 0, 0, 0] }
  ],
  'E7': [
    { name:'Open 2-fgr', frets:[0, 2, 0, 1, 0, 0] },
    { name:'Open 4-fgr', frets:[0, 2, 2, 1, 3, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 0, 1, 0, 0] }
  ],
  'Em7': [
    { name:'Open 1-fgr', frets:[0, 2, 0, 0, 0, 0] },
    { name:'Open 4-fgr', frets:[0, 2, 2, 0, 3, 0] }
  ],
  'F': [
    { name:'Easy 4-str', frets:[-1, -1, 3, 2, 1, 1] },
    { name:'Full barre', frets:[1, 3, 3, 2, 1, 1] },
    { name:'5-str',      frets:[-1, 3, 3, 2, 1, 1] },
    { name:'Open Fmaj7', frets:[-1, -1, 3, 2, 1, 0] }
  ],
  'Fm': [
    { name:'Easy 4-str', frets:[-1, -1, 3, 1, 1, 1] },
    { name:'Full barre', frets:[1, 3, 3, 1, 1, 1] }
  ],
  'Fmaj7': [
    { name:'Open',       frets:[-1, -1, 3, 2, 1, 0] },
    { name:'5-str',      frets:[-1, 3, 3, 2, 1, 0] }
  ],
  'G': [
    { name:'Open',       frets:[3, 2, 0, 0, 0, 3] },
    { name:'4-finger',   frets:[3, 2, 0, 0, 3, 3] },
    { name:'Easy 4-str', frets:[-1, -1, 0, 0, 0, 3] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 0, 0, 3] }
  ],
  'Gm': [
    { name:'Barre 3rd',  frets:[3, 5, 5, 3, 3, 3] },
    { name:'Easy 4-str', frets:[-1, -1, 0, 3, 3, 3] }
  ],
  'G7': [
    { name:'Open 6-str', frets:[3, 2, 0, 0, 0, 1] },
    { name:'Easy 4-str', frets:[-1, -1, 0, 0, 0, 1] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 0, 0, 1] },
    { name:'Open 5-str', frets:[3, -1, 0, 0, 0, 1] },
    { name:'Barre 3rd',  frets:[3, 5, 3, 4, 3, 3] }
  ],
  'Gmaj7': [
    { name:'Open 6-str', frets:[3, 2, 0, 0, 0, 2] },
    { name:'Easy 4-str', frets:[-1, -1, 0, 0, 0, 2] }
  ],
  'A': [
    { name:'Open',       frets:[-1, 0, 2, 2, 2, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 2, 2, 0] }
  ],
  'Am': [
    { name:'Open',       frets:[-1, 0, 2, 2, 1, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 2, 1, 0] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 2, 1, 0] }
  ],
  'A7': [
    { name:'Open 2-fgr', frets:[-1, 0, 2, 0, 2, 0] },
    { name:'Open 4-fgr', frets:[-1, 0, 2, 2, 2, 3] }
  ],
  'Am7': [
    { name:'Open 2-fgr', frets:[-1, 0, 2, 0, 1, 0] },
    { name:'Easy 4-str', frets:[-1, -1, 2, 0, 1, 0] }
  ],
  'Asus2': [
    { name:'Open',       frets:[-1, 0, 2, 2, 0, 0] }
  ],
  'Asus4': [
    { name:'Open',       frets:[-1, 0, 2, 2, 3, 0] }
  ],
  'B': [
    { name:'Barre 2nd',  frets:[-1, 2, 4, 4, 4, 2] },
    { name:'Easy 4-str', frets:[-1, -1, 4, 4, 4, 2] }
  ],
  'Bm': [
    { name:'Barre 2nd',  frets:[-1, 2, 4, 4, 3, 2] },
    { name:'Easy 4-str', frets:[-1, -1, 4, 4, 3, 2] },
    { name:'Easy 3-str', frets:[-1, -1, -1, 4, 3, 2] }
  ],
  'B7': [
    { name:'Open',       frets:[-1, 2, 1, 2, 0, 2] },
    { name:'Easy 4-str', frets:[-1, -1, 1, 2, 0, 2] }
  ]
};

export function getChordTabs(idOrName){
  const c = getChord(idOrName);
  if(!c) return [{ name:'Open', frets:[-1, 0, 2, 2, 2, 0] }];
  if(CHORD_TAB_PRESETS[c.id]) return CHORD_TAB_PRESETS[c.id];

  /* Fallback movable shapes for any of the 120 chords in the dictionary. */
  const eFret = (c.root - 4 + 12) % 12;
  const aFret = (c.root - 9 + 12) % 12;
  const isMin = c.type === 'm' || c.type === 'm7' || c.type === 'dim';
  const is7   = c.type === '7' || c.type === 'm7';
  const isMaj7 = c.type === 'maj7';
  const is5   = c.type === '5';

  const eShape = is5
    ? [eFret, eFret + 2, eFret + 2, -1, -1, -1]
    : [
        eFret,
        eFret + 2,
        eFret + (is7 ? 0 : (isMaj7 ? 1 : 2)),
        eFret + (isMin ? 0 : 1),
        eFret,
        eFret
      ];
  const aShape = is5
    ? [-1, aFret, aFret + 2, aFret + 2, -1, -1]
    : [
        -1,
        aFret,
        aFret + 2,
        aFret + (is7 ? 0 : (isMaj7 ? 1 : 2)),
        aFret + (isMin ? 1 : 2),
        aFret
      ];
  const easy4 = [-1, -1, eShape[2], eShape[3], eShape[4], eShape[5]];
  return [
    { name:'Barre E',    frets:eShape },
    { name:'Barre A',    frets:aShape },
    { name:'Easy 4-str', frets:easy4 }
  ];
}

export function fretsToVoicing(frets, a4 = 440){
  if(!Array.isArray(frets) || frets.length !== 6) return [];
  const out = [];
  for(let i = 0; i < 6; i++){
    const f = frets[i];
    if(f === null || f === undefined || f < 0) continue;
    const midi = STANDARD_STRINGS[i].midi + f;
    const pc = ((midi % 12) + 12) % 12;
    const noteClass = NOTE_NAMES[pc];
    const note = noteClass + (Math.floor(midi / 12) - 1);
    const hz = a4 * Math.pow(2, (midi - 69) / 12);
    out.push({ string:6 - i, fret:f, midi, pc, noteClass, note, hz });
  }
  return out;
}

export function buildCustomChord(idOrName, frets){
  const base = getChord(idOrName);
  if(!base || !Array.isArray(frets) || frets.length !== 6) return base;
  const voiced = fretsToVoicing(frets, 440);
  if(!voiced.length) return base;

  const pcs = [];
  for(const v of voiced){
    if(!pcs.includes(v.pc)) pcs.push(v.pc);
  }
  if(!pcs.length) return base;

  const mask = new Float32Array(12);
  pcs.forEach((pc, idx) => {
    mask[pc] = idx === 0 ? 1.15 : (pc === base.root ? 1.12 : 1.0);
  });
  const notes = pcs.map(pc => NOTE_NAMES[pc]);
  return {
    ...base,
    root: voiced[0].pc,
    pitchClasses: pcs,
    corePcs: pcs,
    notes,
    mask
  };
}

/* ---------- FFT (in-place Radix-2) ---------- */
let fftRe = null, fftIm = null, decBuf = null, magBuf = null, specWork = null, bitRev = null;

function ensureBuffers(){
  if(fftRe) return;
  fftRe = new Float32Array(FFT_SIZE);
  fftIm = new Float32Array(FFT_SIZE);
  decBuf = new Float32Array(FFT_SIZE);
  magBuf = new Float32Array(FFT_SIZE >> 1);
  specWork = new Float32Array(FFT_SIZE >> 1);
  bitRev = new Uint16Array(FFT_SIZE);
  const bits = Math.round(Math.log2(FFT_SIZE));
  for(let i = 0; i < FFT_SIZE; i++){
    let r = 0, x = i;
    for(let b = 0; b < bits; b++){ r = (r << 1) | (x & 1); x >>= 1; }
    bitRev[i] = r;
  }
}

function fftInPlace(re, im){
  const N = FFT_SIZE;
  for(let i = 0; i < N; i++){
    const j = bitRev[i];
    if(j > i){
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for(let len = 2; len <= N; len <<= 1){
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for(let i = 0; i < N; i += len){
      let uRe = 1, uIm = 0;
      for(let j = 0; j < half; j++){
        const a = i + j, b = a + half;
        const vRe = re[b] * uRe - im[b] * uIm;
        const vIm = re[b] * uIm + im[b] * uRe;
        re[b] = re[a] - vRe; im[b] = im[a] - vIm;
        re[a] += vRe;        im[a] += vIm;
        const nextRe = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = nextRe;
      }
    }
  }
}

/* ---------- polyphonic chroma & pitch analysis ---------- */
export function extractChroma(input, sampleRate, opts){
  ensureBuffers();
  const o = opts || {};
  const a4 = o.a4 || 440;
  const gate = o.gate === undefined ? 0.0035 : o.gate;

  const len = input.length;
  let rms = 0;
  for(let i = 0; i < len; i++) rms += input[i] * input[i];
  rms = Math.sqrt(rms / len);

  const empty = () => ({
    chroma: new Float32Array(12),
    rms,
    clarity: 0,
    bassPc: -1,
    avgAbsCents: 0,
    activePcs: 0
  });
  if(rms < gate) return empty();

  /* Decimate to ~12 kHz so a 4096-point FFT has ~2.93 Hz bin spacing. */
  const factor = Math.max(1, Math.round(sampleRate / TARGET_SR));
  const sr = sampleRate / factor;
  const N = Math.min(FFT_SIZE, Math.floor(len / factor));
  if(N < 128) return empty();

  let mean = 0;
  for(let i = 0; i < N; i++){
    let s = 0;
    const base = i * factor;
    for(let k = 0; k < factor; k++) s += input[base + k];
    decBuf[i] = s / factor;
    mean += decBuf[i];
  }
  mean /= N;

  /* Hamming-style window (0.54 - 0.46 cos) gives a narrow main lobe for close
     low-frequency semitones while keeping sidelobes down. */
  const scale = 2 * Math.PI / (N - 1);
  for(let i = 0; i < N; i++){
    const w = 0.54 - 0.46 * Math.cos(scale * i);
    fftRe[i] = (decBuf[i] - mean) * w;
    fftIm[i] = 0;
  }
  for(let i = N; i < FFT_SIZE; i++){
    fftRe[i] = 0;
    fftIm[i] = 0;
  }

  fftInPlace(fftRe, fftIm);

  const half = FFT_SIZE >> 1;
  const binHz = sr / FFT_SIZE;
  const minBin = Math.max(2, Math.floor(55 / binHz));
  const maxBin = Math.min(half - 2, Math.ceil(3200 / binHz));

  let sumMag = 0, maxMag = 0;
  for(let k = 0; k < half; k++){
    const m = (k >= minBin && k <= maxBin) ? Math.hypot(fftRe[k], fftIm[k]) : 0;
    magBuf[k] = m;
    specWork[k] = m;
    if(k >= minBin && k <= maxBin){
      sumMag += m;
      if(m > maxMag) maxMag = m;
    }
  }
  const avgMag = sumMag / Math.max(1, maxBin - minBin + 1);
  const crest = avgMag > 0 ? maxMag / avgMag : 0;
  /* White noise and flat broadband hiss have a low crest factor (< 4.5). */
  if(crest < 4.5 || maxMag <= 0) return empty();

  /* Helper: find strongest TRUE local peak within ±centsTol around target Hz.
     Never fall back to a non-peak bin on the skirt of a neighbour semitone. */
  const peakAround = (arr, hz, centsTol) => {
    const ratio = Math.pow(2, centsTol / 1200);
    const kLo = Math.max(2, Math.floor((hz / ratio) / binHz));
    const kHi = Math.min(half - 3, Math.ceil((hz * ratio) / binHz));
    let bestK = -1, bestV = 0;
    for(let k = kLo; k <= kHi; k++){
      const v = arr[k];
      if(v > bestV && magBuf[k] >= magBuf[k - 1] && magBuf[k] >= magBuf[k + 1]){
        bestV = v; bestK = k;
      }
    }
    if(bestK < 2 || bestV <= 0) return { amp: 0, cents: 0, k: -1 };
    const y1 = magBuf[bestK - 1], y2 = magBuf[bestK], y3 = magBuf[bestK + 1];
    const d = y1 + y3 - 2 * y2;
    const frac = (d !== 0 && y2 >= y1 && y2 >= y3) ? -0.5 * (y3 - y1) / d : 0;
    const trueHz = (bestK + Math.max(-0.6, Math.min(0.6, frac))) * binHz;
    const cents = 1200 * Math.log2(trueHz / hz);
    if(Math.abs(cents) > centsTol) return { amp: 0, cents: 0, k: -1 };
    return { amp: bestV, cents, k: bestK };
  };

  /* Evaluate MIDI notes 38 (D2, 73.4 Hz) through 67 (G4, 392 Hz), subtracting
     confirmed overtones from `specWork` as we climb so upper harmonics of bass
     strings do not create phantom chord thirds, fifths or sevenths. */
  const MIDI_LO = 38, MIDI_HI = 67;
  const noteSalience = new Float32Array(MIDI_HI + 1);
  const noteCents    = new Float32Array(MIDI_HI + 1);
  const noiseFloor   = Math.max(avgMag * 1.8, maxMag * 0.035);

  for(let m = MIDI_LO; m <= MIDI_HI; m++){
    const f0 = a4 * Math.pow(2, (m - 69) / 12);
    const tol1 = m < 45 ? 55 : 42;
    /* Fundamental must still exist in specWork (after lower notes subtracted
       their harmonics), whereas upper harmonics are read from magBuf so a
       real major 3rd whose 2nd/3rd/4th partials overlap the 5th harmonic of
       a bass root/fifth is never suppressed. */
    let p1 = peakAround(specWork, f0, tol1);
    const p2 = peakAround(magBuf, f0 * 2, 38);
    const p3 = peakAround(magBuf, f0 * 3, 36);
    const p4 = peakAround(magBuf, f0 * 4, 36);

    /* If an adjacent semitone is booming in a short 85 ms window, f0 can sit
       on its skirt without a strict local peak; accept it only when BOTH h=2
       and h=3 still form strict local peaks after lower-note harmonic subtraction
       so upper harmonics of bass/mid chord tones don't fabricate a neighbor note. */
    if(p1.amp === 0 && p2.amp > noiseFloor * 1.4 && p3.amp > noiseFloor * 1.4){
      const p2s = peakAround(specWork, f0 * 2, 38);
      const p3s = peakAround(specWork, f0 * 3, 36);
      const kNearest = Math.round(f0 / binHz);
      if(p2s.amp > noiseFloor * 1.4 && p3s.amp > noiseFloor * 1.4 &&
         kNearest >= minBin && kNearest <= maxBin && specWork[kNearest] > noiseFloor * 1.4){
        p1 = { amp: specWork[kNearest], cents: p2s.cents, k: kNearest };
      }
    }

    const a1 = p1.amp > noiseFloor ? p1.amp : 0;
    const a2 = p2.amp > noiseFloor ? p2.amp : 0;
    const a3 = p3.amp > noiseFloor ? p3.amp : 0;
    const a4h = p4.amp > noiseFloor ? p4.amp : 0;

    if(a1 <= 0 || (a2 + a3 + a4h) <= noiseFloor) continue;
    if((a1 + 0.8 * a3) < (a2 + 0.8 * a4h) * 0.16) continue;

    /* Missing-fundamental boost belongs below D#3 (m < 50) where small mics roll
       off bass fundamentals; at G3+ avoid inflating weak bleed off lower 3rds. */
    const boostCap = m < 50 ? 4.5 : (m < 55 ? 2.2 : 1.35);
    const effFund = Math.max(a1, Math.min(a1 * boostCap, a2 * 1.65));
    const sal = Math.sqrt(effFund * (effFund + 0.85 * a2 + 0.60 * a3 + 0.35 * a4h));
    if(sal < noiseFloor * 1.8) continue;

    noteSalience[m] = sal;
    if(m < 52 && a2 > 0) noteCents[m] = p2.cents;
    else if(m < 45 && a3 > 0) noteCents[m] = p3.cents;
    else noteCents[m] = p1.cents;

    /* Subtract expected harmonics of this fundamental from specWork so phantom
       octaves (h=2), twelfths (h=3) and 17ths (h=5) aren't scored as roots.
       Only subtract shoulder bins within ±38 cents so a harmonic does not
       erase an adjacent semitone fundamental at low FFT bin density. */
    for(let h = 2; h <= 6; h++){
      const hHz = f0 * h;
      if(hHz >= 3200) break;
      const hp = peakAround(specWork, hHz, 38);
      if(hp.k > 0){
        const expected = effFund * 0.62 / Math.pow(h, 0.95);
        for(let dk = -1; dk <= 1; dk++){
          const kk = hp.k + dk;
          if(kk >= minBin && kk <= maxBin){
            if(dk === 0 || Math.abs(1200 * Math.log2((kk * binHz) / hHz)) <= 38){
              specWork[kk] = Math.max(0, specWork[kk] - expected);
            }
          }
        }
      }
    }
  }

  /* Aggregate into 12 pitch classes and find the lowest strong bass note. */
  const chroma = new Float32Array(12);
  const pcCentsSum = new Float32Array(12);
  const pcWeightSum = new Float32Array(12);

  let maxSal = 0;
  for(let m = MIDI_LO; m <= MIDI_HI; m++){
    if(noteSalience[m] > maxSal) maxSal = noteSalience[m];
  }
  if(maxSal <= 0) return empty();

  let bassPc = -1;
  for(let m = MIDI_LO; m <= MIDI_HI; m++){
    const s = noteSalience[m];
    if(s < maxSal * 0.14) continue;
    const pc = ((m % 12) + 12) % 12;
    if(bassPc < 0 && s >= maxSal * 0.28) bassPc = pc;
    /* Cap octave-doubling inflation so a 3-string root does not drown out a
       1-string third or seventh. */
    chroma[pc] = chroma[pc] === 0 ? s : Math.max(chroma[pc], s) + 0.18 * Math.min(chroma[pc], s);
    pcCentsSum[pc] += Math.abs(noteCents[m]) * s;
    pcWeightSum[pc] += s;
  }

  let maxChroma = 0;
  for(let i = 0; i < 12; i++) if(chroma[i] > maxChroma) maxChroma = chroma[i];
  if(maxChroma <= 0) return empty();

  let activePcs = 0, weightedCents = 0, totalWeight = 0;
  for(let i = 0; i < 12; i++){
    chroma[i] /= maxChroma;
    if(chroma[i] >= 0.22){
      activePcs++;
      if(pcWeightSum[i] > 0){
        const c = pcCentsSum[i] / pcWeightSum[i];
        weightedCents += c * chroma[i];
        totalWeight += chroma[i];
      }
    }else if(chroma[i] < 0.10){
      chroma[i] = 0;
    }
  }

  const avgAbsCents = totalWeight > 0 ? weightedCents / totalWeight : 0;
  const clarity = Math.min(1, (crest - 4.5) / 14);

  return { chroma, rms, clarity, bassPc, avgAbsCents, activePcs };
}

/* ---------- score any specific chord against an extracted chroma ---------- */
export function rateChordAccuracy(chordObj, chromaInfo){
  const c = getChord(chordObj);
  if(!c || !chromaInfo || chromaInfo.clarity <= 0){
    return { accuracy: 0, purity: 0, completeness: 0, tuning: 0, score: -1 };
  }
  const { chroma, bassPc, avgAbsCents } = chromaInfo;

  let totalEnergy = 0, inChordEnergy = 0, outChordEnergy = 0;
  for(let pc = 0; pc < 12; pc++){
    const e = chroma[pc] * chroma[pc];
    totalEnergy += e;
    if(c.mask[pc] > 0) inChordEnergy += e;
    else outChordEnergy += e;
  }
  if(totalEnergy <= 0) return { accuracy: 0, purity: 0, completeness: 0, tuning: 0, score: -1 };

  /* 1. Purity: fraction of spectral chroma energy belonging to the chord. */
  const purityRatio = inChordEnergy / totalEnergy;
  const purity = Math.round(Math.max(0, Math.min(100, Math.pow(purityRatio, 0.75) * 100)));

  /* 2. Completeness: how well all core chord tones (root, 3rd/7th, 5th) rang out. */
  let minCore = 1, sumCore = 0;
  for(const pc of c.corePcs){
    const v = chroma[pc];
    if(v < minCore) minCore = v;
    sumCore += Math.min(1, v / 0.45);
  }
  const avgCore = sumCore / c.corePcs.length;
  const minFactor = Math.min(1, minCore / 0.24);
  const completeness = Math.round(Math.max(0, Math.min(100, (0.55 * avgCore + 0.45 * minFactor) * 100)));

  /* 3. Tuning: cents deviation of active chord tones from A4 reference. */
  const tuning = Math.round(Math.max(0, Math.min(100, 100 - Math.max(0, avgAbsCents - 3) * 1.75)));

  /* Template match score used to rank candidate chords. */
  let weightedIn = 0, weightSum = 0;
  for(let i = 0; i < c.pitchClasses.length; i++){
    const pc = c.pitchClasses[i];
    const w = c.mask[pc];
    weightedIn += Math.min(1, chroma[pc] / 0.36) * w;
    weightSum += w;
  }
  let score = (weightedIn / weightSum) * c.prior;
  score -= 1.05 * (outChordEnergy / Math.max(0.25, totalEnergy));
  if(minCore < 0.18) score -= (0.18 - minCore) * 1.4;
  if(bassPc === c.root) score += 0.14;
  else if(c.pitchClasses.includes(bassPc)) score += 0.03;

  /* Overall accuracy combines purity (45%), completeness (35%) and tuning (20%),
     plus a small bonus when the root note is cleanly in the bass. */
  let accuracy = Math.round(0.45 * purity + 0.35 * completeness + 0.20 * tuning);
  if(bassPc >= 0 && bassPc !== c.root && !c.pitchClasses.includes(bassPc)){
    accuracy = Math.max(0, accuracy - 12);
  }
  accuracy = Math.max(0, Math.min(100, accuracy));

  return { accuracy, purity, completeness, tuning, score };
}

/* ---------- detect best chord (or evaluate against target chords) ---------- */
export function detectChord(input, sampleRate, opts){
  const o = opts || {};
  const info = o.chromaInfo || extractChroma(input, sampleRate, o);
  if(info.clarity <= 0 || info.activePcs === 0){
    return {
      chord: null,
      name: '',
      rootName: '',
      type: '',
      notes: [],
      confidence: 0,
      accuracy: 0,
      purity: 0,
      completeness: 0,
      tuning: 0,
      matchedTarget: false,
      expected: o.expected || null,
      rms: info.rms,
      chroma: info.chroma,
      bassPc: info.bassPc
    };
  }

  /* Candidate pool: if `candidates` is passed and `strictCandidates` is true,
     only search those; otherwise search all 120 chords (with a slight nudge
     for known target chords when in target mode). */
  const targetSet = new Set(
    Array.isArray(o.targets) ? o.targets.map(t => (getChord(t) || {}).id).filter(Boolean) : []
  );
  const expectedChord = o.expected ? getChord(o.expected) : null;
  const customTabs = (o.customTabs && typeof o.customTabs === 'object') ? o.customTabs : null;

  const evalCandidate = cand => {
    const baseM = rateChordAccuracy(cand, info);
    if(customTabs && Array.isArray(customTabs[cand.id])){
      const customCand = buildCustomChord(cand.id, customTabs[cand.id]);
      const customM = rateChordAccuracy(customCand, info);
      if(customM.score > baseM.score || (customM.score >= baseM.score - 0.04 && customM.accuracy > baseM.accuracy)){
        return { cand: customCand, m: customM };
      }
    }
    return { cand, m: baseM };
  };

  let best = null, bestMetrics = null, bestScore = -Infinity, secondScore = -Infinity;

  for(const rawCand of ALL_CHORDS){
    /* In open guess mode, require at least 2 active pitch classes so a single
       plucked string isn't called a full triad; power chords need 2, triads 2+. */
    if(info.activePcs < 2) continue;

    const { cand, m } = evalCandidate(rawCand);
    let s = m.score;
    if(targetSet.has(cand.id)) s += 0.06;
    if(expectedChord && cand.id === expectedChord.id) s += 0.04;

    if(s > bestScore){
      secondScore = bestScore;
      bestScore = s;
      best = cand;
      bestMetrics = m;
    }else if(s > secondScore){
      secondScore = s;
    }
  }

  if(!best || bestScore < 0.36){
    return {
      chord: null,
      name: '',
      rootName: '',
      type: '',
      notes: [],
      confidence: 0,
      accuracy: 0,
      purity: 0,
      completeness: 0,
      tuning: 0,
      matchedTarget: false,
      expected: expectedChord ? expectedChord.id : null,
      rms: info.rms,
      chroma: info.chroma,
      bassPc: info.bassPc
    };
  }

  const margin = Math.max(0, bestScore - secondScore);
  const confidence = Math.max(0, Math.min(1, bestScore * 0.75 + margin * 1.2));

  /* If an expected target chord was specified, compute accuracy against the
     expected chord (or against the target pool) so wrong chords are scored
     honestly while still reporting what chord was actually heard. */
  let finalMetrics = bestMetrics;
  let matchedTarget = true;

  if(expectedChord){
    matchedTarget = best.id === expectedChord.id;
    if(!matchedTarget){
      const expMetrics = evalCandidate(expectedChord).m;
      finalMetrics = {
        ...expMetrics,
        accuracy: Math.min(expMetrics.accuracy, Math.round(expMetrics.accuracy * 0.72))
      };
    }
  }else if(targetSet.size > 0){
    matchedTarget = targetSet.has(best.id);
    if(!matchedTarget){
      let bestTargetMetrics = { accuracy: 0, purity: 0, completeness: 0, tuning: 0 };
      for(const tid of targetSet){
        const tm = evalCandidate(getChord(tid)).m;
        if(tm.accuracy > bestTargetMetrics.accuracy) bestTargetMetrics = tm;
      }
      finalMetrics = {
        ...bestTargetMetrics,
        accuracy: Math.round(bestTargetMetrics.accuracy * 0.75)
      };
    }
  }

  return {
    chord: best.id,
    name: best.id,
    label: best.label,
    rootName: best.rootName,
    type: best.type,
    notes: best.notes,
    confidence,
    accuracy: finalMetrics.accuracy,
    purity: finalMetrics.purity,
    completeness: finalMetrics.completeness,
    tuning: finalMetrics.tuning,
    heardAccuracy: bestMetrics.accuracy,
    matchedTarget,
    expected: expectedChord ? expectedChord.id : null,
    rms: info.rms,
    chroma: info.chroma,
    bassPc: info.bassPc
  };
}

export function accuracyVerdict(acc){
  if(acc >= 90) return { label:'Sealed · bang on', short:'Sealed', tier:'ok' };
  if(acc >= 78) return { label:'Clean lick',       short:'Clean',  tier:'ok' };
  if(acc >= 62) return { label:'A bit unstuck',    short:'Fair',   tier:'near' };
  return               { label:'Torn envelope',    short:'Sloppy', tier:'far' };
}

/* ---------- envelope & strum counter ("Licking Them Envelopes") ----------
   Tracks amplitude attacks (strums) and chord changes across frames, averages
   the chroma over a short sustain window after the pick attack settles, and
   emits a counted chord event with its accuracy rating. */
export function createEnvelopeTracker(opts){
  const o = opts || {};
  const cooldownMs   = o.cooldownMs === undefined ? 280 : o.cooldownMs;
  const settleFrames = o.settleFrames === undefined ? 2 : o.settleFrames;
  const gate         = o.gate === undefined ? 0.005 : o.gate;

  let env = 0;
  let minEnv = 0;
  let prevRms = 0;
  let armed = true;
  let quietFrames = 0;
  let collecting = false;
  let framesLeft = 0;
  let collectFrames = 0;
  let accumChroma = new Float32Array(12);
  let accumWeight = 0;
  let accumCents = 0;
  let accumClarity = 0;
  let accumBass = -1;
  let peakRms = 0;
  let lastAttackAt = -1e9;
  let lastCountedChord = null;
  let stableChord = null, stableFrames = 0;

  function reset(){
    env = 0;
    minEnv = 0;
    prevRms = 0;
    armed = true;
    quietFrames = 0;
    collecting = false;
    framesLeft = 0;
    collectFrames = 0;
    accumChroma.fill(0);
    accumWeight = 0;
    accumCents = 0;
    accumClarity = 0;
    accumBass = -1;
    peakRms = 0;
    lastAttackAt = -1e9;
    lastCountedChord = null;
    stableChord = null;
    stableFrames = 0;
  }

  function step(input, sampleRate, nowMs, stepOpts){
    const so = stepOpts || {};
    const info = extractChroma(input, sampleRate, { a4: so.a4 || 440, gate });
    const rms = info.rms;

    /* Fast attack, slower release envelope follower. */
    env = rms > env ? env * 0.25 + rms * 0.75 : env * 0.85 + rms * 0.15;

    /* Hysteresis re-arming: only re-arm after sustained silence below the
       noise gate, never mid-sustain during normal piano/guitar decay. */
    if(rms < gate){
      if(!armed && !collecting) minEnv = Math.min(minEnv, rms);
      quietFrames++;
      if(quietFrames >= 4 && env < gate * 1.15){
        armed = true;
        minEnv = 0;
        peakRms = 0;
        stableChord = null;
        stableFrames = 0;
      }
    }else{
      quietFrames = 0;
      if(!armed && !collecting){
        minEnv = Math.min(minEnv, rms);
      }
    }

    const instant = detectChord(null, sampleRate, {
      chromaInfo: info,
      targets: so.targets,
      expected: so.expected,
      customTabs: so.customTabs
    });

    if(instant.chord && instant.chord === stableChord){
      stableFrames++;
    }else if(instant.chord){
      stableChord = instant.chord;
      stableFrames = 1;
    }else{
      stableChord = null;
      stableFrames = 0;
    }

    const sinceAttack = nowMs - lastAttackAt;
    const restrike = !armed && rms >= gate * 1.8 && rms > prevRms * 1.18 && rms > minEnv * 1.90;
    const attackJump = (armed && rms >= gate * 1.8) || restrike;

    const lastObj = lastCountedChord ? getChord(lastCountedChord) : null;
    const decayPowerArtifact = !!(lastObj && instant.type === '5' && lastObj.rootName === instant.rootName);
    const legatoCooldown = Math.max(cooldownMs * 2.2, 620);
    const legatChange = !armed && !decayPowerArtifact && instant.chord &&
                        instant.chord !== lastCountedChord &&
                        sinceAttack >= legatoCooldown &&
                        stableFrames >= 6 && instant.confidence >= 0.62 &&
                        rms >= Math.max(gate * 2.4, peakRms * 0.35);

    prevRms = rms;

    const frameW = Math.max(1e-12, Math.pow(rms * 100, 4));
    if(!collecting && sinceAttack >= cooldownMs && (attackJump || legatChange) && info.clarity > 0){
      collecting = true;
      lastAttackAt = nowMs;
      framesLeft = settleFrames;
      collectFrames = 1;
      for(let i = 0; i < 12; i++) accumChroma[i] = info.chroma[i] * frameW;
      accumWeight = frameW;
      accumCents = info.avgAbsCents * frameW;
      accumClarity = info.clarity;
      accumBass = info.bassPc;
      peakRms = rms;
      minEnv = rms;
      armed = false;
    }else if(collecting){
      collectFrames++;
      if(info.clarity > 0){
        for(let i = 0; i < 12; i++) accumChroma[i] += info.chroma[i] * frameW;
        accumWeight += frameW;
        accumCents += info.avgAbsCents * frameW;
        accumClarity = Math.max(accumClarity, info.clarity);
        if(info.bassPc >= 0 && (accumBass < 0 || rms > peakRms * 1.25)) accumBass = info.bassPc;
      }
      /* If strum energy is still rising sharply across strings, wait past the
         ramp crest (bounded) so transient pick noise does not skew the chord. */
      if(rms > peakRms * 1.15){
        peakRms = rms;
        if(collectFrames < settleFrames + 4 && framesLeft < 2) framesLeft = 2;
      }else if(rms > peakRms){
        peakRms = rms;
      }
      framesLeft--;
    }

    let countedEvent = null;
    if(collecting && framesLeft <= 0){
      collecting = false;
      minEnv = Math.max(rms, peakRms * 0.75);
      const avgChroma = new Float32Array(12);
      const invW = 1 / Math.max(1e-8, accumWeight);
      let maxC = 0;
      for(let i = 0; i < 12; i++){
        avgChroma[i] = accumChroma[i] * invW;
        if(avgChroma[i] > maxC) maxC = avgChroma[i];
      }
      if(maxC > 0){
        for(let i = 0; i < 12; i++) avgChroma[i] /= maxC;
      }
      let activePcs = 0;
      for(let i = 0; i < 12; i++) if(avgChroma[i] >= 0.22) activePcs++;

      const settled = detectChord(null, sampleRate, {
        chromaInfo: {
          chroma: avgChroma,
          rms: peakRms,
          clarity: accumClarity,
          bassPc: accumBass,
          avgAbsCents: accumCents * invW,
          activePcs
        },
        targets: so.targets,
        expected: so.expected,
        customTabs: so.customTabs
      });

      if(settled.chord){
        const changesOnly = !!so.changesOnly;
        const isNewChord = settled.chord !== lastCountedChord;
        if(!changesOnly || isNewChord || lastCountedChord === null){
          lastCountedChord = settled.chord;
          countedEvent = settled;
        }
      }
    }

    return {
      rms,
      envelope: env,
      live: instant,
      counted: countedEvent
    };
  }

  return { step, reset };
}
