/* Audio engine: synthesised click library + a lookahead scheduler.
   Beats are scheduled on the audio clock; the visual queue is drained in
   requestAnimationFrame against ctx.currentTime, so flashes sit on the beat. */

import { state, bus, subById, clamp, save, today } from './store.js';

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

/* Each voice: (time, gain 0..1, accent, isSubdivision) */
const SYNTH = {
  woodblock(t, g, acc){
    tone(t, { type:'triangle', freq: acc ? 1750 : 1180, dur: 0.045, gain: g * 0.9 });
    burst(t, { dur: 0.014, gain: g * 0.35, type:'bandpass', freq: acc ? 2600 : 1900, Q: 2 });
  },
  click(t, g, acc){
    burst(t, { dur: acc ? 0.016 : 0.011, gain: g * (acc ? 1 : 0.7), type:'highpass', freq: acc ? 3200 : 2200 });
  },
  beep(t, g, acc){
    tone(t, { type:'sine', freq: acc ? 1320 : 880, dur: 0.06, gain: g * 0.8 });
  },
  clave(t, g, acc){
    tone(t, { type:'sine', freq: acc ? 3000 : 2400, to: acc ? 2400 : 1900, dur: 0.05, gain: g * 0.85 });
  },
  cowbell(t, g, acc){
    const f = acc ? 1.22 : 1;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    const bp = ctx.createBiquadFilter(), gg = ctx.createGain();
    o1.type = o2.type = 'square';
    o1.frequency.value = 540 * f; o2.frequency.value = 800 * f;
    bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 2;
    env(gg, t, g * 0.5, 0.13);
    o1.connect(bp); o2.connect(bp); bp.connect(gg); gg.connect(master);
    o1.start(t); o2.start(t); o1.stop(t + 0.15); o2.stop(t + 0.15);
  },
  hihat(t, g, acc){
    burst(t, { dur: acc ? 0.06 : 0.035, gain: g * (acc ? 0.8 : 0.5), type:'highpass', freq: 7200 });
  },
  rim(t, g, acc){
    burst(t, { dur: 0.028, gain: g * 0.7, type:'bandpass', freq: acc ? 2200 : 1700, Q: 3 });
    tone(t, { type:'triangle', freq: acc ? 520 : 420, dur: 0.03, gain: g * 0.4 });
  },
  kick(t, g, acc){
    tone(t, { type:'sine', freq: acc ? 190 : 160, to: acc ? 62 : 52, dur: 0.13, gain: g * 0.95 });
  },
  marimba(t, g, acc){
    const f = acc ? 1046 : 698;
    tone(t, { type:'sine', freq: f, dur: 0.26, gain: g * 0.7 });
    tone(t, { type:'sine', freq: f * 4, dur: 0.07, gain: g * 0.12 });
  },
  glass(t, g, acc){
    const f = acc ? 2350 : 1760;
    tone(t, { type:'sine', freq: f, dur: 0.3, gain: g * 0.42 });
    tone(t, { type:'sine', freq: f * 1.003, dur: 0.3, gain: g * 0.3 });
  },
  tick(t, g, acc){
    tone(t, { type:'square', freq: acc ? 4200 : 3200, dur: 0.008, gain: g * 0.55 });
  }
};

function playClick(time, kind){
  if(!state.soundOn) return;
  const v = state.vol / 100;
  if(v <= 0) return;
  const level = kind === 'accent' ? 1 : kind === 'on' ? 0.6 : 0.2;
  const fn = SYNTH[state.soundId] || SYNTH.woodblock;
  try{ fn(time, v * level * 0.9, kind === 'accent', kind === 'sub'); }
  catch(err){ /* a dropped click must never stop the transport */ }
}

export function previewSound(soundId){
  resume().then(() => {
    const keep = state.soundId, keepOn = state.soundOn;
    state.soundId = soundId; state.soundOn = true;
    playClick(audioCtx().currentTime + 0.02, 'accent');
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
        const next = clamp(state.bpm + dir * state.rampBy, 20, 400);
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
    const offs = subById(state.sub).offsets;
    if(offIdx >= offs.length) offIdx = 0;
    const bd = beatDur();
    const t = beatStart + offs[offIdx] * bd;
    if(t >= ctx.currentTime + LOOKAHEAD) break;

    const down = offIdx === 0;
    const countingIn = barIdx < 0;
    const mode = countingIn ? (beatIdx === 0 ? 'accent' : 'on') : (state.pattern[beatIdx] || 'on');
    const muted = !countingIn && isMutedBar(barIdx);

    if(mode !== 'off'){
      const sounds = !muted && (down ? (mode === 'accent' || mode === 'on') : mode !== 'flash');
      if(sounds) playClick(t, down ? mode : 'sub');
      const flashes = !(muted && state.gapFlash) && (down || state.subFlash);
      queue.push({
        t,
        kind: flashes ? (down ? (mode === 'accent' ? 'accent' : 'on') : 'sub') : 'none',
        beat: beatIdx, bar: barIdx, down, muted
      });
    }else if(down){
      queue.push({ t, kind:'none', beat: beatIdx, bar: barIdx, down: true, muted });
    }

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
