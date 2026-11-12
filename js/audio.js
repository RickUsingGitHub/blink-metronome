/* Audio engine: synthesised click library + a lookahead scheduler.
   Beats are scheduled on the audio clock; the visual queue is drained in
   requestAnimationFrame against ctx.currentTime, so flashes sit on the beat. */

import { state, bus, subById, isRest, clamp, save, today, beatGain, BPM_MIN, BPM_MAX } from './store.js';

const LOOKAHEAD = 0.12;   // seconds of audio scheduled ahead
const TICK_MS   = 25;     // how often the scheduler runs

let ctx = null, master = null, noiseBuf = null;

export function audioCtx(){
  if(!ctx){
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function resume(){
  const c = audioCtx();
  return (c.state === 'suspended' && c.resume) ? c.resume().catch(() => {}) : Promise.resolve();
}

function noise(){
  if(!noiseBuf){
    const len = Math.floor(ctx.sampleRate * 0.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

/* ---------- small synth helpers ---------- */
function env(g, t, peak, dur, attack){
  const a = attack === undefined ? 0.0015 : attack;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function tone(t, { type = 'sine', freq, to, dur, gain }){
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if(to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  env(g, t, gain, dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function burst(t, { dur, gain, type = 'highpass', freq = 2000, Q = 1 }){
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noise();
  s.playbackRate.value = 1;
  f.type = type; f.frequency.value = freq; f.Q.value = Q;
  env(g, t, gain, dur, 0.0008);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t, Math.random() * 0.2); s.stop(t + dur + 0.02);
}

/* Each voice: (time, gain 0..1, pitch factor). The pitch factor is what gives
   each beat its tone — high, mid or low, like the three tones on the original. */
const SYNTH = {
  woodblock(t, g, p){
    tone(t, { type:'triangle', freq: 1180 * p, dur: 0.045, gain: g * 0.9 });
    burst(t, { dur: 0.014, gain: g * 0.35, type:'bandpass', freq: 1900 * p, Q: 2 });
  },
  click(t, g, p){
    burst(t, { dur: 0.011 * (p > 1 ? 1.4 : 1), gain: g * 0.85, type:'highpass', freq: 2200 * p });
  },
  beep(t, g, p){
    tone(t, { type:'sine', freq: 880 * p, dur: 0.06, gain: g * 0.8 });
  },
  clave(t, g, p){
    tone(t, { type:'sine', freq: 2400 * p, to: 1900 * p, dur: 0.05, gain: g * 0.85 });
  },
  cowbell(t, g, p){
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    const bp = ctx.createBiquadFilter(), gg = ctx.createGain();
    o1.type = o2.type = 'square';
    o1.frequency.value = 540 * p; o2.frequency.value = 800 * p;
    bp.type = 'bandpass'; bp.frequency.value = 2200 * p; bp.Q.value = 2;
    env(gg, t, g * 0.5, 0.13);
    o1.connect(bp); o2.connect(bp); bp.connect(gg); gg.connect(master);
    o1.start(t); o2.start(t); o1.stop(t + 0.15); o2.stop(t + 0.15);
  },
  hihat(t, g, p){
    burst(t, { dur: 0.035 * (p > 1 ? 1.6 : 0.85), gain: g * 0.65, type:'highpass', freq: 7200 * Math.sqrt(p) });
  },
  rim(t, g, p){
    burst(t, { dur: 0.028, gain: g * 0.7, type:'bandpass', freq: 1700 * p, Q: 3 });
    tone(t, { type:'triangle', freq: 420 * p, dur: 0.03, gain: g * 0.4 });
  },
  kick(t, g, p){
    tone(t, { type:'sine', freq: 160 * p, to: 52 * p, dur: 0.13, gain: g * 0.95 });
  },
  marimba(t, g, p){
    const f = 698 * p;
    tone(t, { type:'sine', freq: f, dur: 0.26, gain: g * 0.7 });
    tone(t, { type:'sine', freq: f * 4, dur: 0.07, gain: g * 0.12 });
  },
  glass(t, g, p){
    const f = 1760 * p;
    tone(t, { type:'sine', freq: f, dur: 0.3, gain: g * 0.42 });
    tone(t, { type:'sine', freq: f * 1.003, dur: 0.3, gain: g * 0.3 });
  },
  tick(t, g, p){
    tone(t, { type:'square', freq: 3200 * p, dur: 0.008, gain: g * 0.55 });
  }
};

/* High / mid / low, plus the quieter subdivision tick. */
const LEVELS = {
  accent: { gain: 1.00, pitch: 1.50 },
  on:     { gain: 0.62, pitch: 1.00 },
  soft:   { gain: 0.42, pitch: 0.67 },
  sub:    { gain: 0.20, pitch: 1.25 }
};

function playClick(time, kind, beat){
  if(!state.soundOn) return;
  const lv = LEVELS[kind] || LEVELS.on;
  const v = (state.vol / 100) * (beat === undefined ? 1 : beatGain(beat));
  if(v <= 0) return;
  const fn = SYNTH[state.soundId] || SYNTH.woodblock;
  try{ fn(time, Math.min(1.4, v * lv.gain * 0.9), lv.pitch); }
  catch(err){ /* a dropped click must never stop the transport */ }
}

export function previewSound(soundId, kind, beat){
  resume().then(() => {
    const keep = state.soundId, keepOn = state.soundOn;
    state.soundId = soundId; state.soundOn = true;
    playClick(audioCtx().currentTime + 0.02, kind || 'accent', beat);
    state.soundId = keep; state.soundOn = keepOn;
  });
}

/* ---------- transport ---------- */
let running = false, timer = null, raf = null;
let queue = [];
let beatIdx = 0, offIdx = 0, barIdx = 0, beatStart = 0;
let startedAt = 0, lastStatFlush = 0;
let rampBarCount = 0;
let lastShownBar = null;

function beatDur(){
  const spb = 60 / state.bpm;
  return state.quarterBpm ? spb * (4 / state.den) : spb;
}

function isMutedBar(bar){
  if(!state.gapOn) return false;
  const cycle = state.gapPlay + state.gapMute;
  if(cycle <= 0) return false;
  return (bar % cycle) >= state.gapPlay;
}

function onNewBar(){
  if(barIdx < 0) return;
  bus.emit('bar:sched', { bar: barIdx });
  if(state.rampOn && barIdx > 0){
    rampBarCount++;
    if(rampBarCount >= state.rampEvery){
      rampBarCount = 0;
      const dir = Math.sign(state.rampTo - state.bpm);
      if(dir !== 0){
        const next = clamp(state.bpm + dir * state.rampBy, BPM_MIN, BPM_MAX);
        state.bpm = dir > 0 ? Math.min(next, state.rampTo) : Math.max(next, state.rampTo);
        bus.emit('bpm', state.bpm);
      }
    }
  }
}

function schedule(){
  if(!ctx) return;
  let guard = 0;
  for(;;){
    if(++guard > 4000) break;
    if(beatIdx >= state.num) beatIdx = 0;
    const sub = subById(state.sub);
    const offs = sub.slots;
    if(offIdx >= offs.length) offIdx = 0;
    const bd = beatDur();
    const t = beatStart + offs[offIdx] * bd;
    if(t >= ctx.currentTime + LOOKAHEAD) break;

    const down = offIdx === 0;
    const rest = isRest(sub, offIdx);     // written in the split, but not played
    const countingIn = barIdx < 0;
    const mode = countingIn ? (beatIdx === 0 ? 'accent' : 'on') : (state.pattern[beatIdx] || 'on');
    const muted = !countingIn && isMutedBar(barIdx);

    if(mode !== 'off'){
      // 'flash' is the silent-but-visible beat; everything else sounds
      if(!muted && !rest && mode !== 'flash') playClick(t, down ? mode : 'sub', countingIn ? undefined : beatIdx);
      const flashes = !rest && !(muted && state.gapFlash) && (down || state.subFlash);
      queue.push({
        t,
        kind: flashes ? (down ? (mode === 'accent' ? 'accent' : 'on') : 'sub') : 'none',
        beat: beatIdx, bar: barIdx, down, muted
      });
    }else if(down){
      queue.push({ t, kind:'none', beat: beatIdx, bar: barIdx, down: true, muted });
    }

    if(queue.length > 512) queue.splice(0, queue.length - 512);   // see frame()

    offIdx++;
    if(offIdx >= offs.length){
      offIdx = 0;
      beatStart += bd;
      beatIdx++;
      if(beatIdx >= state.num){
        beatIdx = 0;
        barIdx++;
        onNewBar();
      }
    }
  }
}

function frame(){
  if(!running){ raf = null; return; }
  const now = ctx.currentTime;
  while(queue.length && queue[0].t <= now + 0.004){
    const e = queue.shift();
    // The page is not painted while it is hidden, so frames stop arriving and
    // these pile up. Beats whose moment has passed are dropped rather than
    // fired all at once when the page comes back.
    if(now - e.t > 0.25) continue;
    if(e.down && e.bar !== lastShownBar){
      lastShownBar = e.bar;
      bus.emit('bar', { bar: e.bar });
    }
    bus.emit('beat', e);
    if(e.down && e.kind !== 'none' && state.vibrate && navigator.vibrate){
      try{ navigator.vibrate(e.kind === 'accent' ? 38 : 22); }catch(err){}
    }
  }
  const el = now - startedAt;
  bus.emit('tick', { elapsed: el });
  if(el - lastStatFlush >= 10){
    addPractice(el - lastStatFlush);
    lastStatFlush = el;
  }
  raf = requestAnimationFrame(frame);
}

function addPractice(sec){
  if(sec <= 0) return;
  if(state.stats.day !== today()){ state.stats.day = today(); state.stats.today = 0; }
  state.stats.today += sec;
  state.stats.total += sec;
  bus.emit('stats');
  save();
}

export const engine = {
  get running(){ return running; },
  get elapsed(){ return running && ctx ? ctx.currentTime - startedAt : 0; },

  start(){
    if(running) return;
    audioCtx();
    resume().then(() => {
      queue = [];
      beatIdx = 0; offIdx = 0;
      barIdx = -state.countIn;
      rampBarCount = 0;
      lastShownBar = null;
      beatStart = ctx.currentTime + 0.12;
      startedAt = ctx.currentTime;
      lastStatFlush = 0;
      running = true;
      schedule();
      timer = setInterval(schedule, TICK_MS);
      raf = requestAnimationFrame(frame);
      bus.emit('start');
    });
  },

  stop(){
    if(!running) return;
    running = false;
    if(timer) clearInterval(timer);
    timer = null;
    if(raf) cancelAnimationFrame(raf);
    raf = null;
    addPractice((ctx ? ctx.currentTime - startedAt : 0) - lastStatFlush);
    queue = [];
    bus.emit('stop');
  },

  toggle(){ running ? this.stop() : this.start(); },

  /* Jump to the top of bar 1 without stopping — used when a setlist song changes. */
  restart(){
    if(!running) return;
    queue = [];
    beatIdx = 0; offIdx = 0; barIdx = 0;
    rampBarCount = 0;
    lastShownBar = null;
    beatStart = ctx.currentTime + 0.06;
    schedule();
  }
};
