# Research findings

What was learned about *Dancing Demon* from the supplied files, and how each
fact was established. **Verified** = read directly from the program or
measured; **hypothesis** = plausible but not proven.

## 1. The cassette is George Phillips' *Doubled Dancing Demon*

`data/source/dandem2.cas` is not Leo Christopherson's original program but
George Phillips' 2009 Model III remake
([48k.ca/dandem2.html](https://www.48k.ca/dandem2.html)), which, in his
words, reuses "Leo Christopherson's great art". Its title string reads
*"Doubled Dancing Demon / Programmed by George Phillips (using Leo
Christopherson's great art)!"*.

**Cassette format (verified, `tools/cas_decode.py`).** 256 × `0x55` leader,
`0x7F` sync byte, then every byte is stored as 9 bits (a `0` start bit + 8
data bits, MSB first) packed into one bit stream. That stream is a standard
SYSTEM tape: `0x55`, name `DANDEM`, 70 `0x3C` blocks (all checksums valid) loading
`0x8000–0xA867` and `0xA870–0xC484`, entry point `0x807F`. It is all Z80 machine
code: no BASIC.

## 2. How the program works (verified by disassembly + emulation)

| Address | What it is |
|---|---|
| `0x807F` | entry: clears the screen, prints credits, installs a 30 Hz RTC interrupt handler through the RAM vector at `0x4012`, `HALT`s once to lock onto the video beam |
| `0xA5FE` | main dispatcher; from here on everything is cycle-counted (HL is used as a T-state budget) |
| `0xA614` | reads the next **dance letter** from `0xA81F` and dispatches through the table at `0xC41B` (`'@'` = end) |
| `0xA635` | reads the next **tune letter** from `0xA67D` (`0` byte → loop) |
| `0xA652` | square-wave routine: letter − `'?'` indexes a 6-byte entry at `0xA777` (time cost, cycle count, half-period, two output levels) and toggles cassette port `0xFF`: frequency = 2 027 520 / (26·d + 38) Hz |

* **Display: racing the beam.** The demon is drawn in a 14 × 10 character
  window. Each character is rewritten six times per 60 Hz frame, every 256
  T-states (two scan lines), which doubles the vertical resolution of
  TRS-80 semigraphics. Every sprite is 28 × 60 pixels. That is the "doubled" in the
  title. `tools/emulate_dandem.py` reconstructs the picture by
  replaying every VRAM write against a model of the beam (264 lines × 128
  T-states).
* **Sprites.** The emulated performance uses exactly **28 distinct sprites**.
  They are the same bitmap flip-book frames, shown at different window
  positions.
* **Window motion.** The window moves horizontally (from column 17 to 32,
  i.e. the demon walks off-centre and back) and up two character rows (the jump).
  The app reproduces this as root translation.
* **Dance string** (`0xA81F`, 73 letters):
  `JJJFGFGFGFGDEDEFGFGLMFMLGLMFMLGDEDEFGFGAAAAAAAZAAAAEDEDTTQQQQRRRRDEDEFGJ@`.
* **Tune** (`0xA67D`, 128 letters, `Z` = rest):
  `EFHJZIZHZZZJJIIHZZJMMLLJJHFEZCZAEFHJZIZHZZHJJIIHZZJMMLLJJHFEZCZAMMJMZZZZMMMMZHZZMMJMZZZZMMMMHHGFFECJZIZHZZHJJIIHZZJMMLLJJHFEZCZA`.
  A second tune at `0xA6FE` is present but not played. I did not identify the
  songs.
* **Timing structure.** One tune letter every 20 frames (1/3 s). Steps `J L M R`
  last one note and all others two, so the dance and the tune end together
  (128 notes, 42.67 s in Phillips' version).
* **Step vocabulary.** Each dance letter always expands to the same sprite
  sequence (with the same window motion). Two-note steps flip through 8 sprites,
  the jump `Z` through 12. Exported as `stepLibrary` in `choreography.json`:

| letter | sprites | what it looks like |
|---|---|---|
| J | 0 / 1 | idle bounce |
| F | 2 3 4 5 6 3 2 1 | arm wave (screen-right arm) with crossing step |
| G | 7 8 9 10 11 8 7 1 | mirror of F |
| D, E | mixes of F and G frames | alternating arm waves, legs crossing |
| L, M | 7 12 5 1 / 2 13 10 1 | kicks |
| A, T | 2 3 7 1 7 8 2 1 / 7 8 2 1 … | shuffles |
| Z | 2 14 15 … 21 7 22 1 | the jump (window rises 2 rows) |
| Q | 11 23 24 25 26 27 6 1 | turn around: head turns, back view, turns back |
| R | 7 2 6 1 | travelling step |

## 3. The reference recording

`data/source/reference.mp4`: 640×480, 29.97 fps (constant), 78.9 s, AAC audio
starting at 0. It shows the original program (Powersoft disk version,
"Copyright 1979, 1980") on a CP-500 (a Brazilian Model III clone): menu →
"Play preset show" → curtain rises (21.9–24.8 s) → dance with music (24.9–61.7 s) →
**silent curtain call** (61.7–73.1 s) → curtain falls (73.1–75.8 s).

* **Grid (measured).** The TRS-80 128×48 grid sits at pitch 4.792 × 9.6 px,
  origin (1.5, 8.5), found by fitting edge positions. The demon's resting window
  is at pixel (48, 12) = characters (24, 4). Phillips places it at (25, 2).
* **Same choreography (verified).** Matching every frame against the 28 sprites
  at every character-aligned position, then aligning the two sprite-change
  sequences, matches 468 of 509 changes in order. The unmatched ones are poses
  shown for less than a video frame, or frames torn by progressive redraw.
  The window motion agrees in every matched frame (0 mismatches).
* **Tempo (measured).** The original at the speed used in the recording runs
  1.149× faster than Phillips' fixed 20-frames-per-note grid, and not exactly
  proportionally: a single linear map leaves ±0.1 s drift. A monotone
  per-note piecewise-linear warp brings the residual to **18 ms std, 70 ms
  max**, about half a video frame. Hypothesis: the original's note length
  depends on the pitch (cycle-counted sound loops).
* **Sound and animation are interleaved (measured).** Tonal onsets in the
  soundtrack coincide with sprite flips: the original plays a burst of the
  current note between frames. The soundtrack also has broadband "tap" clicks
  (often in triplets).
* **Curtain call (video only).** After the music the original does a silent
  routine: hands on hips → bow (head down, one arm sweeping) → hands on hips →
  … with a cocky head tilt at the end. Phillips' remake does not have it. Three
  extra sprites (akimbo, bow, akimbo + tilt) were extracted from the video at
  the original 28 × 30 resolution, with rows doubled.

## 4. Things that remain hypotheses

* The pitch table, the second tune and the exact song identities were not
  decoded into musical notation. The app uses the recording's own soundtrack.
* The tune-note markers on the timeline are Phillips' note-read events, warped.
  A pitch-consistency scan suggests the audible notes may start ~60 ms
  earlier, but the evidence is weak (the pitch tracker struggles with the
  clicks), so the markers were not shifted. Pose timing does not depend on
  them: it comes from the sprite flips.
* Head turn amounts (±55°), the back-view interpretation of sprites 24–26, the
  curtain-call arm angles and the bow's head pitch are read by eye
  (`data/pose_overrides.json`).
* I did not run Leo Christopherson's original program, only Phillips' remake
  plus the recording. They agree on the dance itself; the curtain call and the
  exact tempo come from the recording.
