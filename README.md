# Blink Metronome

A metronome you can silence while it keeps flashing the beat. Any beat can be set to **flash without clicking**, or the
whole bar can be muted in one tap while the screen keeps the time.

It runs in the phone browser, installs to the home screen, and works offline.

**[Open it](https://rickusinggithub.github.io/blink-metronome/)** — then Share → *Add to Home Screen*
on iPhone, or the ⋮ menu → *Install app* on Android.

## What's in it

**Metronome**
- 20–400 BPM: rotary dial, slider, ± buttons, tap tempo
- Time signatures from 1 to 32 beats, over 1 / 2 / 4 / 8 / 16
- Three sounding tones per beat — each beat cycles
  **High → Mid → Low → Flash (silent) → Rest**
- Per-beat volume, 0–150%, so one beat can sit back or push forward on its own
- 16 split patterns, drawn as their own rhythm rather than labelled with a number —
  including the ones with a written rest inside the split. Names below assume a
  denominator of 4; the app adjusts note names to the selected denominator
  (for example, no split in 4/8 is an eighth note / quaver):

  | | |
  |---|---|
  | Quarter | one note on the beat |
  | Two quavers, triplet, four semiquavers | the plain even splits |
  | **Swing** | quaver, rest, quaver |
  | Triplet — first two / rest then two | the other two triplet feels |
  | Quaver + two semiquavers, two semiquavers + quaver | |
  | Semiquaver, quaver, semiquaver | |
  | Dotted quaver + semiquaver, semiquaver + dotted quaver | |
  | Rest, three semiquavers | |
  | Quintuplets, sextuplets, septuplets | |

- 11 synthesised sounds: woodblock, click, beep, clave, cowbell, hi-hat, rimshot, kick,
  marimba, glass, tick
- Vibration on the beat where the browser supports it (Android does, iOS does not)
- Italian tempo markings, bar and beat counter, elapsed time

**The flash**
- Whole screen, dial only, or off
- Brightness and flash length
- Separate colours for the downbeat and the other beats
- Subdivisions flash dimmer, or not at all
- Stage mode: everything disappears except the dial and the flash

**Practice**
- Count-in of 1 or 2 bars
- Gap trainer: play *n* bars, mute *m* bars — the flash can keep going through the silence, or stop too
- Tempo ramp: speed up by *n* BPM every *m* bars up to a target
- Practice time tracked for today and all time

**Setlists**
- Several lists, each with songs holding tempo, signature, split, sound, beat pattern,
  per-beat volumes and notes
- Reorder, edit, delete; auto-advance after a set number of bars
- Export and import as JSON

**Tuner**
- Chromatic, autocorrelation pitch detection with octave correction
- A4 adjustable 415–465 Hz
- Presets for guitar (standard, drop D, half step down, open G), bass 4 and 5 string,
  ukulele, violin, cello, mandolin, banjo

**Sound level meter**
- dB with peak hold, min / average / max and a scrolling graph
- Calibration offset, because a phone mic is not a measurement instrument

## Timing

Clicks are scheduled on the Web Audio clock about 120 ms ahead, and the flashes are drained from a
queue in `requestAnimationFrame` against `AudioContext.currentTime`. That keeps the beat steady even
when the main thread is busy — a plain `setInterval` metronome drifts audibly.

## Updates

The page, its code and the manifest are fetched network-first and revalidated past the
browser's own HTTP cache — GitHub Pages sends `max-age=600`, which will otherwise hand
back a module up to ten minutes old and pair a new `index.html` with stale code. So a
published change is live on the next load; icons and other assets stay cache-first, and
everything falls back to the cache offline. A new worker installs and then waits rather than taking over, and that waiting worker is
what the page treats as "a new version is ready": it shows a bar with Reload and Later.
Reload tells the waiting worker to take over and reloads once it has; nothing happens
until then, because a reload mid-bar would stop the metronome. The app re-checks for a
new version each time it comes back to the foreground.

## Support

Blink is free. If it earns its place on your music stand, you can
[buy me a coffee](https://ko-fi.com/rickapps).

## Privacy

Everything stays on the device. Settings and setlists go in `localStorage`; the microphone is only
open while the tuner or the level meter is running, and no audio is recorded, stored or sent anywhere.

## Running it locally

Any static server will do — ES modules and the service worker need http, not `file://`:

```
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Layout

The version lives in one place, `VERSION` at the top of `js/store.js`; the service worker
cache name in `sw.js` is bumped with it.

```
index.html              markup for all five tabs
css/app.css             tokens and layout, three themes
js/store.js             VERSION, state, persistence, split and tuning tables
js/audio.js             synth voices + lookahead scheduler
js/flash.js             the beat flash
js/mic.js               shared microphone, reference counted
js/ui-*.js              one module per tab
sw.js                   offline cache
```
