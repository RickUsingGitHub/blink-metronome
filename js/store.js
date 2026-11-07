/* Shared state, persistence and a tiny event bus. */

export const VERSION = '1.0.0';
const KEY = 'blink.v1';

/* ---------- event bus ---------- */
const handlers = new Map();
export const bus = {
  on(evt, fn){
    if(!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt).delete(fn);
  },
  emit(evt, data){
    const set = handlers.get(evt);
    if(!set) return;
    for(const fn of set){
      try{ fn(data); }catch(err){ console.error('[bus]', evt, err); }
    }
  }
};

/* ---------- subdivisions: offsets are fractions of one beat ---------- */
export const SUBS = [
  { id:'q',   label:'♩',  name:'Quarter',       offsets:[0] },
  { id:'8',   label:'♫',  name:'Eighths',       offsets:[0, 1/2] },
  { id:'8t',  label:'3',       name:'Triplets',      offsets:[0, 1/3, 2/3] },
  { id:'16',  label:'4',       name:'Sixteenths',    offsets:[0, 1/4, 1/2, 3/4] },
  { id:'8d',  label:'♪.', name:'Dotted + 16th', offsets:[0, 3/4] },
  { id:'sw',  label:'Sw',      name:'Swing eighths', offsets:[0, 2/3] },
  { id:'16r', label:'‖',  name:'Off-beat 16ths',offsets:[0, 1/4, 3/4] },
  { id:'5',   label:'5',       name:'Quintuplets',   offsets:[0, .2, .4, .6, .8] },
  { id:'6',   label:'6',       name:'Sextuplets',    offsets:[0, 1/6, 2/6, 3/6, 4/6, 5/6] },
  { id:'7',   label:'7',       name:'Septuplets',    offsets:[0, 1/7, 2/7, 3/7, 4/7, 5/7, 6/7] }
];
export const subById = id => SUBS.find(s => s.id === id) || SUBS[0];

export const SOUNDS = [
  { id:'woodblock', name:'Woodblock' },
  { id:'click',     name:'Click' },
  { id:'beep',      name:'Beep' },
  { id:'clave',     name:'Clave' },
  { id:'cowbell',   name:'Cowbell' },
  { id:'hihat',     name:'Hi-hat' },
  { id:'rim',       name:'Rimshot' },
  { id:'kick',      name:'Kick' },
  { id:'marimba',   name:'Marimba' },
  { id:'glass',     name:'Glass' },
  { id:'tick',      name:'Tick' }
];

/* Italian tempo markings, by lower bound. */
const MARKS = [
  [1,'Larghissimo'],[24,'Grave'],[40,'Largo'],[56,'Adagio'],[66,'Adagietto'],
  [76,'Andante'],[92,'Andante moderato'],[108,'Moderato'],[116,'Allegretto'],
  [120,'Allegro'],[156,'Vivace'],[172,'Presto'],[200,'Prestissimo']
];
export function tempoMark(bpm){
  let out = MARKS[0][1];
  for(const [lo, name] of MARKS){ if(bpm >= lo) out = name; }
  return out;
}

export const TUNINGS = [
  { id:'guitar',   name:'Guitar (standard)', notes:['E2','A2','D3','G3','B3','E4'] },
  { id:'guitar-d', name:'Guitar (drop D)',   notes:['D2','A2','D3','G3','B3','E4'] },
  { id:'guitar-h', name:'Guitar (half step down)', notes:['D#2','G#2','C#3','F#3','A#3','D#4'] },
  { id:'guitar-o', name:'Guitar (open G)',   notes:['D2','G2','D3','G3','B3','D4'] },
  { id:'bass',     name:'Bass (4-string)',   notes:['E1','A1','D2','G2'] },
  { id:'bass5',    name:'Bass (5-string)',   notes:['B0','E1','A1','D2','G2'] },
  { id:'ukulele',  name:'Ukulele',           notes:['G4','C4','E4','A4'] },
  { id:'violin',   name:'Violin',            notes:['G3','D4','A4','E5'] },
  { id:'cello',    name:'Cello',             notes:['C2','G2','D3','A3'] },
  { id:'mandolin', name:'Mandolin',          notes:['G3','D4','A4','E5'] },
  { id:'banjo',    name:'Banjo (open G)',    notes:['G4','D3','G3','B3','D4'] },
  { id:'chromatic',name:'Chromatic',         notes:[] }
];

export const MODES = ['accent','on','flash','off'];
export const MODE_LABEL = { accent:'Acc', on:'Click', flash:'Flash', off:'Rest' };

/* ---------- defaults ---------- */
function defaults(){
  return {
    bpm:120, num:4, den:4, sub:'q',
    pattern:['accent','on','on','on'],
    soundOn:true, soundId:'woodblock', vol:85, vibrate:false,
    flashTarget:'screen', bright:85, hold:30,
    colAccent:'#ffc83d', colBeat:'#5fd0ff', subFlash:true,
    countIn:0,
    gapOn:false, gapPlay:2, gapMute:2, gapFlash:false,
    rampOn:false, rampBy:2, rampEvery:4, rampTo:160,
    theme:null, wake:true, quarterBpm:false,
    a4:440, tuning:'guitar', lvCal:0,
    lists:[{ id:'L1', name:'My setlist', auto:false, bars:8, songs:[] }],
    listIdx:0, songIdx:null,
    stats:{ day:today(), today:0, total:0 }
  };
}
export function today(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

export const state = defaults();

/* ---------- validation helpers ---------- */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
};
const hex = (v, dflt) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) ? v : dflt;

export function fixPattern(){
  const p = state.pattern.slice(0, state.num);
  while(p.length < state.num) p.push('on');
  state.pattern = p.map(m => MODES.includes(m) ? m : 'on');
  if(state.num > 0 && state.pattern[0] === 'on' && state.pattern.every(m => m === 'on')) state.pattern[0] = 'accent';
}

/* ---------- persistence ---------- */
export function save(){
  try{ localStorage.setItem(KEY, JSON.stringify(state)); }
  catch(err){ /* private mode or full quota — the app still works, just forgets */ }
}

export function load(){
  let raw = null;
  try{ raw = localStorage.getItem(KEY); }catch(err){ return; }
  if(!raw) return;
  let o;
  try{ o = JSON.parse(raw); }catch(err){ return; }
  if(!o || typeof o !== 'object') return;

  state.bpm   = int(o.bpm, 20, 400, 120);
  state.num   = int(o.num, 1, 32, 4);
  state.den   = [1,2,4,8,16].includes(+o.den) ? +o.den : 4;
  state.sub   = SUBS.some(s => s.id === o.sub) ? o.sub : 'q';
  if(Array.isArray(o.pattern)) state.pattern = o.pattern.filter(m => MODES.includes(m));
  fixPattern();

  state.soundOn = o.soundOn !== false;
  state.soundId = SOUNDS.some(s => s.id === o.soundId) ? o.soundId : 'woodblock';
  state.vol     = int(o.vol, 0, 100, 85);
  state.vibrate = !!o.vibrate;

  state.flashTarget = ['screen','dial','off'].includes(o.flashTarget) ? o.flashTarget : 'screen';
  state.bright  = int(o.bright, 5, 100, 85);
  state.hold    = int(o.hold, 10, 60, 30);
  state.colAccent = hex(o.colAccent, '#ffc83d');
  state.colBeat   = hex(o.colBeat, '#5fd0ff');
  state.subFlash  = o.subFlash !== false;

  state.countIn = int(o.countIn, 0, 2, 0);
  state.gapOn   = !!o.gapOn;
  state.gapPlay = int(o.gapPlay, 1, 16, 2);
  state.gapMute = int(o.gapMute, 1, 16, 2);
  state.gapFlash= !!o.gapFlash;
  state.rampOn  = !!o.rampOn;
  state.rampBy  = int(o.rampBy, 1, 20, 2);
  state.rampEvery = int(o.rampEvery, 1, 32, 4);
  state.rampTo  = int(o.rampTo, 20, 400, 160);

  state.theme = ['dark','black','light'].includes(o.theme) ? o.theme : null;
  state.wake  = o.wake !== false;
  state.quarterBpm = !!o.quarterBpm;

  state.a4    = int(o.a4, 415, 465, 440);
  state.tuning= TUNINGS.some(t => t.id === o.tuning) ? o.tuning : 'guitar';
  state.lvCal = int(o.lvCal, -20, 40, 0);

  if(Array.isArray(o.lists) && o.lists.length){
    state.lists = o.lists.map((l, i) => ({
      id: typeof l.id === 'string' ? l.id : 'L' + (i+1),
      name: typeof l.name === 'string' ? l.name.slice(0,60) : 'Setlist ' + (i+1),
      auto: !!l.auto,
      bars: int(l.bars, 1, 64, 8),
      songs: Array.isArray(l.songs) ? l.songs.map(cleanSong).filter(Boolean) : []
    }));
  }
  state.listIdx = int(o.listIdx, 0, state.lists.length - 1, 0);
  state.songIdx = (o.songIdx === null || o.songIdx === undefined) ? null
                : int(o.songIdx, 0, Math.max(0, currentList().songs.length - 1), null);

  const st = o.stats && typeof o.stats === 'object' ? o.stats : {};
  state.stats = {
    day: typeof st.day === 'string' ? st.day : today(),
    today: Math.max(0, Number(st.today) || 0),
    total: Math.max(0, Number(st.total) || 0)
  };
  if(state.stats.day !== today()){ state.stats.day = today(); state.stats.today = 0; }
}

function cleanSong(s){
  if(!s || typeof s !== 'object') return null;
  const num = int(s.num, 1, 32, 4);
  let pattern = Array.isArray(s.pattern) ? s.pattern.filter(m => MODES.includes(m)).slice(0, num) : [];
  while(pattern.length < num) pattern.push(pattern.length === 0 ? 'accent' : 'on');
  return {
    id: typeof s.id === 'string' ? s.id : 'S' + Math.random().toString(36).slice(2,9),
    name: typeof s.name === 'string' ? s.name.slice(0,80) : 'Untitled',
    bpm: int(s.bpm, 20, 400, 120),
    num, den: [1,2,4,8,16].includes(+s.den) ? +s.den : 4,
    sub: SUBS.some(x => x.id === s.sub) ? s.sub : 'q',
    soundId: SOUNDS.some(x => x.id === s.soundId) ? s.soundId : 'woodblock',
    pattern,
    notes: typeof s.notes === 'string' ? s.notes.slice(0,200) : ''
  };
}
export { cleanSong };

export function currentList(){
  if(!state.lists.length) state.lists.push({ id:'L1', name:'My setlist', auto:false, bars:8, songs:[] });
  state.listIdx = clamp(state.listIdx, 0, state.lists.length - 1);
  return state.lists[state.listIdx];
}

export function resetAll(){
  try{ localStorage.removeItem(KEY); }catch(err){}
  Object.assign(state, defaults());
}

export function newId(prefix){ return prefix + Math.random().toString(36).slice(2,9); }

export function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  return h ? h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0')
           : m + ':' + String(s).padStart(2,'0');
}
