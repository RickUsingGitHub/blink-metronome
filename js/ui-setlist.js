/* Setlists: saved songs with their own tempo, signature, split, sound and
   beat pattern; optional auto-advance after a number of bars. */

import {
  state, bus, save, currentList, newId, cleanSong,
  SUBS, SOUNDS, subById, clamp
} from './store.js';
import { engine } from './audio.js';
import { $, $$, toast } from './ui.js';
import { refreshMetronome } from './ui-metronome.js';

let editing = null;        // index of the song open in the editor
let barsIntoSong = 0;

/* ---------- apply / capture ---------- */
export function loadSong(i, announce){
  const list = currentList();
  const s = list.songs[i];
  if(!s) return;
  state.songIdx = i;
  state.bpm = s.bpm;
  state.num = s.num;
  state.den = s.den;
  state.sub = s.sub;
  state.soundId = s.soundId;
  state.pattern = s.pattern.slice();
  barsIntoSong = 0;
  refreshMetronome();
  renderSongs();
  paintSongName();
  save();
  if(announce) toast(s.name + ' · ' + s.bpm + ' BPM');
  if(engine.running) engine.restart();
}

function captureSong(name){
  return {
    id: newId('S'),
    name: name || 'Song ' + (currentList().songs.length + 1),
    bpm: state.bpm, num: state.num, den: state.den,
    sub: state.sub, soundId: state.soundId,
    pattern: state.pattern.slice(),
    notes: ''
  };
}

function paintSongName(){
  const el = $('songName');
  const list = currentList();
  const s = state.songIdx !== null ? list.songs[state.songIdx] : null;
  el.hidden = !s;
  el.textContent = s ? s.name : '';
}

/* ---------- rendering ---------- */
function renderLists(){
  const sel = $('slSelect');
  sel.textContent = '';
  state.lists.forEach((l, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = l.name + ' (' + l.songs.length + ')';
    sel.appendChild(o);
  });
  sel.value = String(state.listIdx);
  const list = currentList();
  $('slAuto').checked = list.auto;
  $('slBarsVal').textContent = list.bars;
}

function renderSongs(){
  const list = currentList();
  const ul = $('songList');
  ul.textContent = '';
  list.songs.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'song' + (i === state.songIdx ? ' active' : '');

    const main = document.createElement('div');
    main.className = 'song-main';
    main.tabIndex = 0;
    main.setAttribute('role', 'button');
    const sub = subById(s.sub);
    const snd = SOUNDS.find(x => x.id === s.soundId);
    main.innerHTML =
      '<div class="song-name"></div>' +
      '<div class="song-meta"></div>';
    main.querySelector('.song-name').textContent = (i + 1) + '. ' + s.name;
    main.querySelector('.song-meta').textContent =
      s.bpm + ' BPM · ' + s.num + '/' + s.den + ' · ' + sub.name +
      (snd ? ' · ' + snd.name : '') + (s.notes ? ' · ' + s.notes : '');
    main.addEventListener('click', () => loadSong(i, true));
    main.addEventListener('keydown', ev => {
      if(ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); loadSong(i, true); }
    });

    const acts = document.createElement('div');
    acts.className = 'song-acts';
    acts.innerHTML =
      '<button data-act="up"   title="Move up" aria-label="Move up">↑</button>' +
      '<button data-act="down" title="Move down" aria-label="Move down">↓</button>' +
      '<button data-act="edit" title="Edit" aria-label="Edit">✎</button>' +
      '<button data-act="del"  title="Delete" aria-label="Delete">✕</button>';
    acts.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if(!b) return;
      act(b.dataset.act, i);
    });

    li.appendChild(main);
    li.appendChild(acts);
    ul.appendChild(li);
  });
  $('songEmpty').hidden = list.songs.length > 0;
}

function act(what, i){
  const list = currentList();
  if(what === 'up' && i > 0){
    [list.songs[i - 1], list.songs[i]] = [list.songs[i], list.songs[i - 1]];
    if(state.songIdx === i) state.songIdx = i - 1;
    else if(state.songIdx === i - 1) state.songIdx = i;
  }else if(what === 'down' && i < list.songs.length - 1){
    [list.songs[i + 1], list.songs[i]] = [list.songs[i], list.songs[i + 1]];
    if(state.songIdx === i) state.songIdx = i + 1;
    else if(state.songIdx === i + 1) state.songIdx = i;
  }else if(what === 'del'){
    const s = list.songs[i];
    if(!confirm('Delete "' + s.name + '" from this setlist?')) return;
    list.songs.splice(i, 1);
    if(state.songIdx === i) state.songIdx = null;
    else if(state.songIdx !== null && state.songIdx > i) state.songIdx--;
  }else if(what === 'edit'){
    openEditor(i);
    return;
  }
  renderSongs(); renderLists(); paintSongName(); save();
}

/* ---------- editor ---------- */
function openEditor(i){
  const s = currentList().songs[i];
  if(!s) return;
  editing = i;
  $('seName').value = s.name;
  $('seBpm').value = s.bpm;
  $('seNum').value = s.num;
  $('seDen').value = s.den;
  $('seNotes').value = s.notes || '';
  $('songEditPanel').hidden = false;
  $('songEditPanel').scrollIntoView({ block:'nearest' });
}
function closeEditor(){ editing = null; $('songEditPanel').hidden = true; }

function saveEditor(){
  if(editing === null) return;
  const list = currentList();
  const s = list.songs[editing];
  if(!s) return;
  s.name  = ($('seName').value || 'Untitled').slice(0, 80);
  s.bpm   = clamp(Math.round(+$('seBpm').value || 120), 20, 400);
  s.num   = clamp(Math.round(+$('seNum').value || 4), 1, 32);
  const den = Math.round(+$('seDen').value || 4);
  s.den   = [1,2,4,8,16].includes(den) ? den : 4;
  s.notes = ($('seNotes').value || '').slice(0, 200);
  const p = s.pattern.slice(0, s.num);
  while(p.length < s.num) p.push(p.length === 0 ? 'accent' : 'on');
  s.pattern = p;
  closeEditor();
  renderSongs(); renderLists(); paintSongName(); save();
  toast('Saved');
}

/* ---------- export / import ---------- */
function exportLists(){
  const data = JSON.stringify({ app:'blink-metronome', version:1, lists: state.lists }, null, 2);
  const blob = new Blob([data], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'blink-setlists.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function importLists(file){
  const r = new FileReader();
  r.onload = () => {
    let o;
    try{ o = JSON.parse(String(r.result)); }
    catch(err){ toast('That file is not valid JSON'); return; }
    const lists = Array.isArray(o) ? o : (o && Array.isArray(o.lists) ? o.lists : null);
    if(!lists){ toast('No setlists found in that file'); return; }
    let added = 0;
    lists.forEach((l, i) => {
      if(!l || typeof l !== 'object') return;
      state.lists.push({
        id: newId('L'),
        name: (typeof l.name === 'string' ? l.name : 'Imported ' + (i + 1)).slice(0, 60),
        auto: !!l.auto,
        bars: clamp(Math.round(+l.bars || 8), 1, 64),
        songs: Array.isArray(l.songs) ? l.songs.map(cleanSong).filter(Boolean) : []
      });
      added++;
    });
    state.listIdx = state.lists.length - 1;
    state.songIdx = null;
    renderLists(); renderSongs(); paintSongName(); save();
    toast(added === 1 ? 'Imported 1 setlist' : 'Imported ' + added + ' setlists');
  };
  r.readAsText(file);
}

/* ---------- auto-advance ---------- */
function onBarScheduled(){
  const list = currentList();
  if(!list.auto || state.songIdx === null || list.songs.length < 2) return;
  barsIntoSong++;
  if(barsIntoSong >= list.bars){
    barsIntoSong = 0;
    const next = (state.songIdx + 1) % list.songs.length;
    loadSong(next, true);
  }
}

/* ---------- init ---------- */
export function initSetlist(){
  renderLists();
  renderSongs();
  paintSongName();

  $('slSelect').addEventListener('change', e => {
    state.listIdx = clamp(+e.target.value, 0, state.lists.length - 1);
    state.songIdx = null;
    renderLists(); renderSongs(); paintSongName(); closeEditor(); save();
  });
  $('slNew').addEventListener('click', () => {
    const name = prompt('Name for the new setlist', 'Setlist ' + (state.lists.length + 1));
    if(name === null) return;
    state.lists.push({ id:newId('L'), name:(name || 'Untitled').slice(0,60), auto:false, bars:8, songs:[] });
    state.listIdx = state.lists.length - 1;
    state.songIdx = null;
    renderLists(); renderSongs(); paintSongName(); save();
  });
  $('slRename').addEventListener('click', () => {
    const list = currentList();
    const name = prompt('Rename setlist', list.name);
    if(name === null) return;
    list.name = (name || list.name).slice(0, 60);
    renderLists(); save();
  });
  $('slDelete').addEventListener('click', () => {
    if(state.lists.length === 1){ toast('Keep at least one setlist'); return; }
    const list = currentList();
    if(!confirm('Delete the setlist "' + list.name + '" and its ' + list.songs.length + ' songs?')) return;
    state.lists.splice(state.listIdx, 1);
    state.listIdx = 0;
    state.songIdx = null;
    renderLists(); renderSongs(); paintSongName(); save();
  });

  $('slAuto').addEventListener('change', e => { currentList().auto = e.target.checked; barsIntoSong = 0; save(); });
  const bars = d => {
    const list = currentList();
    list.bars = clamp(list.bars + d, 1, 64);
    $('slBarsVal').textContent = list.bars;
    save();
  };
  $('slBarsMinus').addEventListener('click', () => bars(-1));
  $('slBarsPlus').addEventListener('click',  () => bars(1));

  $('songAdd').addEventListener('click', () => {
    const list = currentList();
    list.songs.push(captureSong('Song ' + (list.songs.length + 1)));
    state.songIdx = list.songs.length - 1;
    barsIntoSong = 0;
    renderSongs(); renderLists(); paintSongName(); save();
    openEditor(state.songIdx);
    $('seName').focus();
    $('seName').select();
    toast('Added — give it a name');
  });

  $('seSave').addEventListener('click', saveEditor);
  $('songEditClose').addEventListener('click', closeEditor);
  $('seGrab').addEventListener('click', () => {
    if(editing === null) return;
    const s = currentList().songs[editing];
    s.bpm = state.bpm; s.num = state.num; s.den = state.den;
    s.sub = state.sub; s.soundId = state.soundId; s.pattern = state.pattern.slice();
    openEditor(editing);
    renderSongs(); save();
    toast('Took the current metronome settings');
  });

  $('slExport').addEventListener('click', exportLists);
  $('slImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if(f) importLists(f);
    e.target.value = '';
  });

  bus.on('bar:sched', onBarScheduled);
  bus.on('start', () => { barsIntoSong = 0; });
}

export function refreshSetlist(){ renderLists(); renderSongs(); paintSongName(); }
