/* Paints the beat flash. Driven by the engine's audio-timed 'beat' event.

   Note: this is never gated behind prefers-reduced-motion — the flash *is* the
   instrument here, and silencing it would remove the feature. */

import { state, bus, subById } from './store.js';

let flashEl, glowEl, dialEl;

function flashLen(){
  const spb = 60 / state.bpm;
  const pct = state.hold / 100;
  return Math.max(28, Math.min(260, spb * 1000 * pct));
}

function paint(kind){
  if(kind === 'none' || state.flashTarget === 'off') return;

  const k = state.bright / 100;
  const accent = kind === 'accent';
  const sub = kind === 'sub';
  const alpha = accent ? 0.95 * k : sub ? 0.2 * k : 0.78 * k;
  const color = accent ? state.colAccent : sub ? '#ffffff' : state.colBeat;

  let dur = flashLen();
  if(sub) dur = Math.max(20, dur * 0.4);

  if(state.flashTarget === 'screen' && flashEl){
    flashEl.style.background = color;
    animate(flashEl, alpha, dur);
  }
  if(glowEl){
    glowEl.style.background = color;
    animate(glowEl, Math.min(1, alpha + 0.12), dur * 1.5);
  }
  if(dialEl && !sub){
    dialEl.style.borderColor = color;
    clearTimeout(dialEl._t);
    dialEl._t = setTimeout(() => { dialEl.style.borderColor = ''; }, dur);
  }
}

function animate(el, alpha, dur){
  if(el.animate){
    try{
      el.animate([{ opacity: alpha }, { opacity: 0 }],
                 { duration: dur, easing: 'cubic-bezier(.12,0,.45,1)' });
      return;
    }catch(err){ /* fall through */ }
  }
  el.style.opacity = alpha;
  clearTimeout(el._ft);
  el._ft = setTimeout(() => { el.style.opacity = '0'; }, dur);
}

export function initFlash(){
  flashEl = document.getElementById('flash');
  glowEl  = document.getElementById('dialGlow');
  dialEl  = document.getElementById('dial');
  bus.on('beat', e => paint(e.kind));
  bus.on('stop', () => {
    if(flashEl) flashEl.style.opacity = '0';
    if(glowEl) glowEl.style.opacity = '0';
    if(dialEl) dialEl.style.borderColor = '';
  });
}

/* one-off flash used when previewing colours */
export function testFlash(kind){ paint(kind || 'accent'); }
