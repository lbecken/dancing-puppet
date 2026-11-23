#!/usr/bin/env python3
"""Run George Phillips' "Doubled Dancing Demon" (decoded from the .cas) in a
cycle-counting Z80 emulator and recover the animation exactly.

What the program does (verified by disassembly + emulation):
  * Entry 0x807F clears the screen, prints the credits, installs a 30 Hz RTC
    interrupt handler (vector via RAM 0x4012) and HALTs once to lock onto the
    video beam. From then on everything is cycle counted (HL is used as a
    T-state budget).
  * The demon is drawn by a "racing the beam" kernel that rewrites each
    character of a 14x10 character window six times per 60 Hz frame (every 256
    T-states = 2 scan lines). That doubles the vertical resolution of TRS-80
    semigraphics, so each sprite is 28 x 60 pixels.
  * The kernel window moves (horizontal travel across the stage, a jump).
  * Dance step letters are read at 0xA614 from the string at 0xA81F
    ("JJJFGFG...J@"), dispatched through the table at 0xC41B.
  * Tune letters are read at 0xA635 from 0xA67D (128 letters, 'Z' = rest);
    each letter indexes a 6-byte entry at 0xA777 (time cost, cycle count,
    half-period, output levels) for the square-wave routine at 0xA652 that
    toggles cassette port 0xFF.

Output (JSON): sprite library, per-60Hz-frame sprite id + window origin, and
step / note events, all on the emulated clock (seconds).

Usage: emulate_dandem.py dandem.bin out.json [seconds]
"""
import collections
import json
import sys

import z80

CLK = 2027520            # TRS-80 Model III CPU clock (Hz)
RTC = CLK // 30          # 30 Hz real-time-clock interrupt
FRAME = 33792            # T-states per 60 Hz video frame (264 lines * 128)
FRAME_PHASE = 11000      # frame boundary relative to the sync interrupt
WIN_R, WIN_C = 10, 14    # kernel window in characters


def run(image, seconds):
    m = z80.Z80Machine()
    rom = bytearray(0x3800)
    rom[0x38:0x3B] = bytes([0xC3, 0x12, 0x40])        # RST 38h -> JP 4012h
    m.set_memory_block(0, bytes(rom))
    m.set_memory_block(0x4012, bytes([0xC3, 0x00, 0x41]))
    # default handler: push af; in a,(ech); pop af; ei; reti
    m.set_memory_block(0x4100, bytes([0xF5, 0xDB, 0xEC, 0xF1, 0xFB, 0xED, 0x4D]))
    m.set_memory_block(0x8000, image)
    m.pc, m.sp = 0x807F, 0x7F00

    st = {'base': 0, 'set': 0, 'pending': False, 'mask': 0}

    def now():
        return st['base'] + st['set'] - m.ticks_to_stop

    vlog, olog, events = [], [], []

    def on_write(a, v):
        vlog.append((now(), a - 0x3C00, v))

    def on_out(p, v):
        p &= 0xFF
        olog.append((now(), p, v))
        if p == 0xE0:
            st['mask'] = v

    def on_in(p):
        p &= 0xFF
        if p == 0xE0:  # interrupt status, active low; bit 2 = RTC
            return 0xFF & ~(4 if st['pending'] else 0)
        if p == 0xEC:  # reading EC acknowledges the RTC interrupt
            st['pending'] = False
        return 0xFF

    m.set_write_callback(on_write)
    m.mark_addrs(0x3C00, 0x400, m.WRITE_MARK)
    m.set_read_callback(lambda a: 0)          # keyboard: nothing pressed
    m.mark_addrs(0x3800, 0x400, m.READ_MARK)
    m.set_output_callback(on_out)
    m.set_input_callback(on_in)
    m.set_get_int_vector_callback(lambda: 0xFF)
    bps = {0xA614: 'step', 0xA635: 'note'}
    for a in bps:
        m.set_breakpoint(a)

    def run_to(t):
        while now() < t:
            st['base'] = now()
            st['set'] = t - st['base']
            m.ticks_to_stop = st['set']
            ev = m.run()
            if ev & m._BREAKPOINT_HIT:
                kind = bps.get(m.pc)
                if kind:
                    events.append((now(), kind, m.memory[m.hl]))
                st['base'] = now()
                st['set'] = t - st['base']
                m.ticks_to_stop = st['set']
                m.step_over_breakpoint()

    ints, next_rtc, limit = [], RTC, int(seconds * CLK)
    while now() < limit:
        run_to(next_rtc)
        st['pending'] = True
        next_rtc += RTC
        for _ in range(2000):
            if not (st['pending'] and st['mask'] & 4):
                break
            if m.iff1 and m.on_handle_active_int():
                ints.append(now())
                break
            st['base'] = now()
            st['set'] = 4
            m.ticks_to_stop = 4
            m.run()
    return vlog, olog, events, ints


def reconstruct(vlog, t0):
    """Rebuild what the beam displayed: one 28x60 bitmap per 60 Hz frame."""
    i, n = 0, len(vlog)
    while i < n and vlog[i][0] < t0 + FRAME_PHASE:
        i += 1
    frames = []
    fi = 0
    while i < n:
        fstart = t0 + FRAME_PHASE + fi * FRAME
        fend = fstart + FRAME
        wr = collections.defaultdict(list)
        while i < n and vlog[i][0] < fend:
            wr[vlog[i][1]].append(vlog[i][2])
            i += 1
        six = [a for a, l in wr.items() if len(l) >= 6]
        if len(six) < 100:
            frames.append((fstart, None, None))
            fi += 1
            continue
        r0 = min(a // 64 for a in six)
        c0 = min(a % 64 for a in six)
        rows = [[0] * 28 for _ in range(60)]
        for r in range(WIN_R):
            for c in range(WIN_C):
                ws = wr.get((r0 + r) * 64 + c0 + c)
                if not ws:
                    continue
                for k in range(6):
                    val = ws[k] if len(ws) >= 6 else ws[-1]
                    if val >= 128:
                        br = k // 2  # semigraphic block row shown on sub-row k
                        rows[r * 6 + k][c * 2] = (val >> (2 * br)) & 1
                        rows[r * 6 + k][c * 2 + 1] = (val >> (2 * br + 1)) & 1
        bitmap = '\n'.join(''.join('#' if x else '.' for x in row) for row in rows)
        frames.append((fstart, bitmap, (c0, r0)))
        fi += 1
    return frames


def main():
    image = open(sys.argv[1], 'rb').read()
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 50
    vlog, olog, events, ints = run(image, seconds)
    frames = reconstruct(vlog, ints[0])
    lib, ids = [], {}
    seq = []
    for t, bm, org in frames:
        if bm is None:
            seq.append([round(t / CLK, 6), -1, None, None])
            continue
        if bm not in ids:
            ids[bm] = len(lib)
            lib.append(bm)
        seq.append([round(t / CLK, 6), ids[bm], org[0], org[1]])
    out = {
        'source': 'George Phillips, Doubled Dancing Demon (art by Leo Christopherson)',
        'clock_hz': CLK,
        'frame_s': FRAME / CLK,
        'sprites': lib,
        'frames': seq,  # [time_s, sprite_id (-1 none), window_col, window_row]
        'events': [[round(t / CLK, 6), k, chr(v) if v else ''] for t, k, v in events],
        'sound_out_count': sum(1 for _, p, _ in olog if p == 0xFF),
    }
    json.dump(out, open(sys.argv[2], 'w'))
    print('sprites', len(lib), 'frames', len(seq), 'events', len(events))


if __name__ == '__main__':
    main()
