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
