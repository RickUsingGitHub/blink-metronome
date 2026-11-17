/* Shared DOM helpers. */

export const $  = id => document.getElementById(id);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

let toastTimer = null;
export function toast(msg){
  const el = $('toast');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}

/* Press-and-hold repeat for − / + buttons. */
export function repeat(btn, fn){
  if(!btn) return;
  let t = null, iv = null;
  const fire = () => fn();
  const down = ev => {
    if(ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    fire();
    t = setTimeout(() => { iv = setInterval(fire, 65); }, 400);
  };
  const up = () => { clearTimeout(t); clearInterval(iv); iv = null; };
  btn.addEventListener('pointerdown', down);
  ['pointerup','pointerleave','pointercancel'].forEach(n => btn.addEventListener(n, up));
  btn.addEventListener('click', ev => ev.preventDefault());
}

/* Segmented control: marks one child pressed and reports its data value. */
export function segment(el, attr, onPick){
  if(!el) return;
  el.addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if(!b || !b.dataset[attr]) return;
    onPick(b.dataset[attr], b);
  });
}
export function segmentSet(el, attr, value){
  if(!el) return;
  $$('button', el).forEach(b => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value))));
}

/* Tooltips on mouse hover, keyboard focus, and touch long-press (~450 ms).
   Long-pressing a tappable control suppresses its trailing click once so
   mobile users can inspect a tip without accidentally triggering the button. */
export function initTooltips(){
  const tip = $('tooltip');
  if(!tip) return;

  let curTarget = null;
  let hoverTimer = null;
  let holdTimer = null;
  let hideTimer = null;
  let downX = 0, downY = 0;
  let suppressClickEl = null;

  function place(target){
    const r = target.getBoundingClientRect();
    tip.hidden = false;
    tip.classList.remove('show');
    const tw = tip.offsetWidth || 220;
    const th = tip.offsetHeight || 48;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(10, Math.min(vw - tw - 10, left));
    let top = r.top - th - 10;
    if(top < 10) top = Math.min(vh - th - 10, r.bottom + 10);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    tip.classList.add('show');
  }

  function show(target, autoHideMs){
    const text = target && target.dataset ? target.dataset.tip : '';
    if(!text) return;
    clearTimeout(hideTimer);
    curTarget = target;
    tip.textContent = text;
    place(target);
    if(autoHideMs > 0){
      hideTimer = setTimeout(hide, autoHideMs);
    }
  }

  function hide(){
    clearTimeout(hoverTimer);
    clearTimeout(holdTimer);
    clearTimeout(hideTimer);
    hoverTimer = holdTimer = hideTimer = null;
    curTarget = null;
    tip.classList.remove('show');
    tip.hidden = true;
  }

  document.addEventListener('pointerover', ev => {
    if(ev.pointerType && ev.pointerType !== 'mouse') return;
    const el = ev.target.closest('[data-tip]');
    if(!el){
      if(curTarget) hide();
      return;
    }
    if(el === curTarget) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => show(el, 0), 220);
  });

  document.addEventListener('pointerout', ev => {
    if(ev.pointerType && ev.pointerType !== 'mouse') return;
    const el = ev.target.closest('[data-tip]');
    if(el && !el.contains(ev.relatedTarget)){
      if(el === curTarget || hoverTimer) hide();
    }
  });

  document.addEventListener('pointerdown', ev => {
    const el = ev.target.closest('[data-tip]');
    if(curTarget && curTarget !== el) hide();
    if(ev.pointerType === 'mouse'){ hide(); return; }
    if(!el) return;
    downX = ev.clientX;
    downY = ev.clientY;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      suppressClickEl = el;
      show(el, 4500);
    }, 450);
  }, { passive: true });

  document.addEventListener('pointermove', ev => {
    if(!holdTimer) return;
    if(Math.hypot(ev.clientX - downX, ev.clientY - downY) > 10){
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }, { passive: true });

  ['pointerup', 'pointercancel'].forEach(evt => {
    document.addEventListener(evt, () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      if(suppressClickEl){
        setTimeout(() => { suppressClickEl = null; }, 400);
      }
    }, { passive: true });
  });

  /* Prevent touch long-press from also firing the control's click action. */
  document.addEventListener('click', ev => {
    if(suppressClickEl && (ev.target === suppressClickEl || suppressClickEl.contains(ev.target))){
      ev.preventDefault();
      ev.stopImmediatePropagation();
      suppressClickEl = null;
    }
  }, true);

  document.addEventListener('focusin', ev => {
    if(!ev.target.matches(':focus-visible')) return;
    const el = ev.target.closest('[data-tip]');
    if(el) show(el, 0);
  });
  document.addEventListener('focusout', () => { if(curTarget) hide(); });
  document.addEventListener('keydown', ev => { if(ev.key === 'Escape' && curTarget) hide(); });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
}
