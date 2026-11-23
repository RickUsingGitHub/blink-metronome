/* Saved LTE chord sets: the list logic and how it survives a reload.
   Run: node tests/lte-sets.test.js  */

// store.js keeps settings in localStorage; give node a minimal one.
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};

const {
  state, load, save, resetAll, MAX_SAVED_SETS,
  sameChords, chordSetLabel, rememberChordSet, forgetChordSet
} = await import('../js/store.js');

let pass = 0, fail = 0;
function check(label, ok, detail){
  ok ? pass++ : fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || !detail ? '' : '  — ' + detail));
}
const ids = () => { let n = 0; return () => 'my' + (++n); };

console.log('\nLabels');
check('a pair swaps', chordSetLabel(['G', 'C']) === 'G ↔ C', chordSetLabel(['G', 'C']));
check('a longer set runs on', chordSetLabel(['C', 'G', 'Am', 'F']) === 'C → G → Am → F');
check('a single chord is just its name', chordSetLabel(['Em']) === 'Em');

console.log('\nRemembering sets');
{
  const make = ids();
  let r = rememberChordSet([], ['C', 'G', 'Am', 'F'], make);
  check('a new set is added', r.added && r.list.length === 1 && sameChords(r.list[0].chords, ['C', 'G', 'Am', 'F']));

  r = rememberChordSet(r.list, ['Dm', 'G7', 'C'], make);
  check('the newest set goes to the top', r.list[0].chords[0] === 'Dm' && r.list.length === 2);

  const before = r.list.length;
  r = rememberChordSet(r.list, ['C', 'G', 'Am', 'F'], make);
  check('setting a saved set again does not duplicate it', !r.added && r.list.length === before);
  check('...and moves it back to the top', sameChords(r.list[0].chords, ['C', 'G', 'Am', 'F']));
  check('...keeping its id', r.list[0].id === 'my1', r.list[0].id);

  r = rememberChordSet(r.list, ['Am', 'F', 'C', 'G'], make);
  check('the same chords in another order are a different set', r.added && r.list.length === before + 1);

  const input = ['E', 'A'];
  r = rememberChordSet(r.list, input, make);
  input.push('B7');
  check('a saved set is a copy, not the caller\'s array', r.set.chords.length === 2);
}

console.log('\nThe list has a limit');
{
  const make = ids();
  let list = [];
  for(let i = 0; i < MAX_SAVED_SETS + 5; i++) list = rememberChordSet(list, ['C', 'D' + i], make).list;
  check('it stops at ' + MAX_SAVED_SETS, list.length === MAX_SAVED_SETS, String(list.length));
  check('the most recent is kept', list[0].chords[1] === 'D' + (MAX_SAVED_SETS + 4));
  check('the least recently used is dropped', !list.some(s => s.chords[1] === 'D0'));
}

console.log('\nRemoving sets');
{
  const make = ids();
  let list = rememberChordSet([], ['A', 'D'], make).list;
  list = rememberChordSet(list, ['G', 'C'], make).list;
  const gone = list[1].id;
  const after = forgetChordSet(list, gone);
  check('the chosen set is removed', after.length === 1 && !after.some(s => s.id === gone));
  check('the others are left alone', after[0].chords[0] === 'G');
  check('removing an unknown id changes nothing', forgetChordSet(after, 'nope').length === 1);
}

console.log('\nSurviving a reload');
{
  resetAll();
  state.lteSaved = rememberChordSet([], ['C', 'G', 'Am', 'F']).list;
  state.lteSaved = rememberChordSet(state.lteSaved, ['Dm', 'G7', 'C']).list;
  save();
  state.lteSaved = [];
  load();
  check('saved sets come back after reload', state.lteSaved.length === 2 &&
        sameChords(state.lteSaved[0].chords, ['Dm', 'G7', 'C']));
}
{
  // settings written by a version before sets were kept, with custom chords in use
  mem.set('blink.v1', JSON.stringify({ ltePreset: 'custom', lteChords: ['E', 'B7', 'A'] }));
  load();
  check('the custom set in use is kept the first time', state.lteSaved.length === 1 &&
        sameChords(state.lteSaved[0].chords, ['E', 'B7', 'A']));

  // that ran once; once removed it must stay removed even though it is still loaded
  state.lteSaved = forgetChordSet(state.lteSaved, state.lteSaved[0].id);
  save();
  load();
  check('a removed set does not come back on the next load', state.lteSaved.length === 0,
        JSON.stringify(state.lteSaved));
}
{
  // old settings whose chords were a built-in drill: nothing to keep
  mem.set('blink.v1', JSON.stringify({ ltePreset: 'A-D', lteChords: ['A', 'D'] }));
  load();
  check('a built-in drill is not copied into your sets', state.lteSaved.length === 0);
}
{
  mem.set('blink.v1', JSON.stringify({ lteSaved: [
    { id: 'myok', chords: ['C', 'G'] },
    { id: 'myempty', chords: [] },
    { chords: ['D', 42, null, 'A'] },
    'junk',
    null,
    { id: 'mynochords' }
  ] }));
  load();
  check('damaged entries are dropped', state.lteSaved.length === 2, JSON.stringify(state.lteSaved));
  check('non-chord values inside a set are dropped',
        state.lteSaved[1] && sameChords(state.lteSaved[1].chords, ['D', 'A']));
  check('a set saved without an id is given one', state.lteSaved[1] && /^my/.test(state.lteSaved[1].id));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
