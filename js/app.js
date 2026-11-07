/* Boot: theme, tabs, transport, wake lock, keyboard, install, service worker. */

import { state, bus, save, load, resetAll, VERSION, KOFI_URL } from './store.js';
import { engine, resume } from './audio.js';
import { initFlash } from './flash.js';
import { initMetronome, refreshMetronome, setBpm, setNum } from './ui-metronome.js';
import { initSetlist, refreshSetlist } from './ui-setlist.js';
import { initTuner, stopTuner } from './ui-tuner.js';
import { initLevels, stopLevels } from './ui-levels.js';
import { $, $$, toast, segment, segmentSet } from './ui.js';

load();

/* ---------- theme ---------- */
function applyTheme(){
  let t = state.theme;
  if(!t){
    const dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
    t = dark ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', t === 'light' ? '#e9edf3' : t === 'black' ? '#000000' : '#0a0c10');
  segmentSet($('themeSeg'), 'theme', t);
}

/* ---------- tabs ---------- */
let currentTab = 'metronome';
function showTab(name){
  currentTab = name;
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  if(name !== 'tuner') stopTuner();
  if(name !== 'levels') stopLevels();
  document.querySelector('.shell').scrollTop = 0;
}

/* ---------- wake lock ---------- */
let lock = null;
async function keepAwake(){
  if(!state.wake) return;
  try{
    if(navigator.wakeLock && navigator.wakeLock.request){
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    }
  }catch(err){ /* denied or unsupported — nothing to do */ }
}
function dropAwake(){
  if(lock){ try{ lock.release(); }catch(err){} lock = null; }
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && engine.running) keepAwake();
});

/* ---------- transport button ---------- */
function paintPlay(){
  const b = $('playBtn');
  b.textContent = engine.running ? 'Stop' : 'Start';
  b.dataset.on = String(engine.running);
}

/* ---------- init ---------- */
function init(){
  applyTheme();
  initFlash();
  initMetronome();
  initSetlist();
  initTuner();
  initLevels();

  $('playBtn').addEventListener('click', () => engine.toggle());
  bus.on('start', () => { paintPlay(); keepAwake(); });
  bus.on('stop',  () => { paintPlay(); dropAwake(); });

  $$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  /* stage mode */
  $('stageBtn').addEventListener('click', () => {
    const on = document.body.classList.toggle('stage');
    $('stageBtn').textContent = on ? 'Controls' : 'Stage';
    $('stageBtn').dataset.on = String(on);
    if(on) toast('Tap the dial to start and stop');
  });
  $('dial').addEventListener('click', ev => {
    if(document.body.classList.contains('stage')) engine.toggle();
  });

  /* full screen */
  $('fsBtn').addEventListener('click', () => {
    try{
      if(document.fullscreenElement){
        document.exitFullscreen();
      }else if(document.documentElement.requestFullscreen){
        const p = document.documentElement.requestFullscreen();
        if(p && p.catch) p.catch(() => toast('Full screen was refused'));
      }else{
        toast('Full screen is not available here — add Blink to your home screen instead');
      }
    }catch(err){}
  });

  /* settings */
  segment($('themeSeg'), 'theme', v => { state.theme = v; applyTheme(); save(); });
  $('wakeChk').checked = state.wake;
  $('wakeChk').addEventListener('change', e => {
    state.wake = e.target.checked;
    if(!state.wake) dropAwake(); else if(engine.running) keepAwake();
    save();
  });
  $('bpmUnitChk').checked = state.quarterBpm;
  $('bpmUnitChk').addEventListener('change', e => { state.quarterBpm = e.target.checked; save(); });
  $('wipeBtn').addEventListener('click', () => {
    if(!confirm('Clear every saved setting, setlist and practice total?')) return;
    engine.stop();
    resetAll();
    applyTheme();
    refreshMetronome();
    refreshSetlist();
    toast('Cleared');
  });
  $('verTag').textContent = 'v' + VERSION;
  $('verBadge').textContent = 'v' + VERSION;
  $('kofiBtn').href = KOFI_URL;
  $('kofiFoot').href = KOFI_URL;

  /* keyboard */
  document.addEventListener('keydown', ev => {
    const tag = ev.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if(ev.code === 'Space' && !typing){ ev.preventDefault(); engine.toggle(); return; }
    if(typing) return;
    const big = ev.shiftKey ? 10 : 1;
    if(ev.key === 'ArrowUp'){ ev.preventDefault(); setBpm(state.bpm + big); }
    else if(ev.key === 'ArrowDown'){ ev.preventDefault(); setBpm(state.bpm - big); }
    else if(ev.key === 't' || ev.key === 'T'){ $('tapBtn').click(); }
    else if(ev.key === 's' || ev.key === 'S'){ $('soundSw').click(); }
    else if(/^[1-9]$/.test(ev.key)){ setNum(+ev.key); }
  });

  /* first gesture unlocks audio on iOS */
  const unlock = () => { resume(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock, { once:true });

  wireUpdateBar();
  paintPlay();
  showTab('metronome');
}

/* ---------- install prompt ---------- */
let installEvent = null;
window.addEventListener('beforeinstallprompt', ev => {
  ev.preventDefault();
  installEvent = ev;
  const b = $('installBtn');
  if(b){
    b.hidden = false;
    b.onclick = async () => {
      b.hidden = true;
      installEvent.prompt();
      installEvent = null;
    };
  }
});

/* ---------- service worker and version updates ----------
   A new worker takes over as soon as it installs, but this page is still running
   the old code until it reloads. Say so and let the user pick the moment — an
   automatic reload would cut off a bar mid-practice. */
function offerUpdate(){
  const bar = $('updateBar');
  if(bar) bar.hidden = false;
}
function wireUpdateBar(){
  $('updateBtn').addEventListener('click', () => { location.reload(); });
  $('updateLater').addEventListener('click', () => { $('updateBar').hidden = true; });
}

if('serviceWorker' in navigator){
  const TAG = 'blink-v' + VERSION;          // what this page is actually running

  const ask = () => {
    const c = navigator.serviceWorker.controller;
    if(c) c.postMessage({ type:'version?' });
  };

  navigator.serviceWorker.addEventListener('message', ev => {
    const d = ev.data;
    if(d && d.type === 'sw-version' && d.version !== TAG) offerUpdate();
  });

  navigator.serviceWorker.addEventListener('controllerchange', ask);

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      const el = $('swState');
      if(el) el.textContent = 'Ready to run offline.';
      ask();

      // look for a new version whenever the app comes back to the foreground
      document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'visible'){
          try{ reg.update(); }catch(err){}
          ask();
        }
      });
    }, () => {
      const el = $('swState');
      if(el) el.textContent = 'Offline mode unavailable.';
    });
  });
}

init();
