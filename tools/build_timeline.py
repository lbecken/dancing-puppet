#!/usr/bin/env python3
"""Build the reference choreography timeline (in reference-video seconds).

Inputs : data/phillips.json        (emulated sprite sequence + step/note events)
         data/work/video_track.json (+ _cells.npy) from video_track.py
Output : data/reference_timeline.json

Method
  * Sprite-change runs of the emulated program and of the video are aligned
    with Needleman-Wunsch on sprite ids.
  * A monotone piecewise-linear time warp (knot every tune note, i.e. 1/3 s of
    emulated time) maps emulated time -> video time, fitted by regularised
    least squares to the matched sprite-change times. The original's tempo is
    not exactly proportional to Phillips' fixed 20-frames-per-note grid, so a
    single linear map leaves +-0.1 s drift; the warp removes it.
  * The dance (sprites, window motion, steps, notes) comes from the emulation,
    warped. The curtain call after the music, which Phillips' version does not
    contain, is read directly from the video (3 extra sprites, 28x30 original
    resolution, rows doubled to 28x60).
"""
import json
import sys

import numpy as np

PH_DEFAULT = (25, 2)      # Phillips' resting window (char col,row)
VID_DEFAULT = (48, 12)    # resting window in the recording (pixel x,y of 128x48)


def runs(seq):
    out = []
    for t, s, x, y in seq:
        if not out or out[-1][1] != s or out[-1][2] != x or out[-1][3] != y:
            out.append([t, s, x, y])
    return out


def needleman(a, b):
    n, m = len(a), len(b)
    G = -1.0
    sc = np.zeros((n + 1, m + 1))
    bt = np.zeros((n + 1, m + 1), np.int8)
    sc[:, 0] = np.arange(n + 1) * G
    sc[0, :] = np.arange(m + 1) * G
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            o = (sc[i - 1, j - 1] + (2 if a[i - 1] == b[j - 1] else -1), sc[i - 1, j] + G, sc[i, j - 1] + G)
            k = int(np.argmax(o))
            sc[i, j] = o[k]
            bt[i, j] = k
    i, j, pairs = n, m, []
    while i > 0 and j > 0:
        k = bt[i, j]
        if k == 0:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif k == 1:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


def fit_warp(px, vx, knots, lam=2.0):
    """Piecewise-linear f(knots)=values minimising sum (f(px)-vx)^2 + lam*sum(d2 f)^2."""
    K = len(knots)
    A = np.zeros((len(px), K))
    for r, p in enumerate(px):
        k = np.clip(np.searchsorted(knots, p) - 1, 0, K - 2)
        w = (p - knots[k]) / (knots[k + 1] - knots[k])
        A[r, k] += 1 - w
        A[r, k + 1] += w
    D = np.zeros((K - 2, K))
    for k in range(K - 2):
        D[k, k:k + 3] = [1, -2, 1]
    M = np.vstack([A, np.sqrt(lam) * D])
    rhs = np.concatenate([vx, np.zeros(K - 2)])
    vals = np.linalg.lstsq(M, rhs, rcond=None)[0]
    return vals


def main():
    P = json.load(open('data/phillips.json'))
    V = json.load(open('data/work/video_track.json'))
    cells = np.load('data/work/video_track_cells.npy')
    vt = np.array([r[0] for r in V['track']])

    # ---- emulated sequence (dance only, until the '@' end marker) ----------
    notes = [(t, c) for t, k, c in P['events'] if k == 'note']
    steps = [(t, c) for t, k, c in P['events'] if k == 'step']
    end_t = next(t for t, c in steps if c == '@')
    pseq = [(t, s, x, y) for t, s, x, y in P['frames'] if s >= 0 and t <= end_t + 0.05]
    pr = runs(pseq)

    # ---- video sequence during the dance ---------------------------------
    vseq = [(t, s, x, y) for t, s, x, y, d in V['track'] if 24.5 < t < 62.5 and s >= 0]
    vr = runs(vseq)
    pairs = needleman([r[1] for r in pr], [r[1] for r in vr])
    match = [(pr[i][0], vr[j][0]) for i, j in pairs if pr[i][1] == vr[j][1]]
    px = np.array([m[0] for m in match])
    vx = np.array([m[1] for m in match])
    # robust linear first, drop outliers
    k, c = np.polyfit(px, vx, 1)
    ok = np.abs(vx - (k * px + c)) < 0.3
    knots = np.arange(notes[0][0] - 1 / 3, end_t + 2 / 3, 1 / 3)
    vals = fit_warp(px[ok], vx[ok], knots)
    for _ in range(3):  # re-weight away outliers
        pred = np.interp(px, knots, vals)
        ok = np.abs(vx - pred) < 0.09
        vals = fit_warp(px[ok], vx[ok], knots)
    assert np.all(np.diff(vals) > 0), 'warp not monotone'
    pred = np.interp(px, knots, vals)
    res = vx - pred
    # The video samples at 29.97 fps, so a detected change lags the true change
    # by U(0, 1/29.97): remove the mean lag (half a video frame).
    half = 0.5 / 29.97
    vals = vals - half
    warp = lambda t: float(np.interp(t, knots, vals))
    stats = {
        'linear_fit': {'scale': round(float(k), 6), 'offset': round(float(c), 4)},
        'matched_changes': int(len(match)), 'emulated_changes': len(pr), 'video_changes': len(vr),
        'warp_inliers': int(ok.sum()),
        'residual_std_s': round(float(res[ok].std()), 4),
        'residual_abs_max_s': round(float(np.abs(res[ok]).max()), 4),
    }

    sprites = list(P['sprites'])

    # ---- curtain call (video only) ----------------------------------------
    def crop(i):
        b = (cells[i][VID_DEFAULT[1]:VID_DEFAULT[1] + 30, VID_DEFAULT[0]:VID_DEFAULT[0] + 28] > 115)
        return b.astype(np.uint8)

    def to_sprite(b):
        rows = []
        for row in b:
            s = ''.join('#' if v else '.' for v in row)
            rows += [s, s]
        return '\n'.join(rows)

    named = {'akimbo': 62.9 + 1.0, 'bow': 62.9, 'akimbo_tilt': 71.0}
    extra = {}
    for name, t in named.items():
        i = int(np.argmin(np.abs(vt - t)))
        extra[name] = len(sprites)
        sprites.append(to_sprite(crop(i)))

    # classify curtain-call frames against standing + the extra sprites
    lib = {0: None, extra['akimbo']: None, extra['bow']: None, extra['akimbo_tilt']: None}
    for sid in lib:
        rows = sprites[sid].split('\n')[0::2]
        lib[sid] = np.array([[1 if ch == '#' else 0 for ch in r] for r in rows], np.uint8)
    dance_end_v = warp(end_t)
    cc = []
    for i in np.nonzero((vt > dance_end_v + 0.05) & (vt < 73.12))[0]:
        b = crop(i)
        best = min(lib, key=lambda s: int(np.abs(lib[s].astype(int) - b).sum()))
        d = int(np.abs(lib[best].astype(int) - b).sum())
        cc.append([float(vt[i]), best, d])
    # drop single torn frames (progressive redraw caught mid-way)
    clean = []
    for j, (t, s, d) in enumerate(cc):
        prev_s = cc[j - 1][1] if j else s
        next_s = cc[j + 1][1] if j + 1 < len(cc) else s
        if s != prev_s and s != next_s:
            continue
        clean.append((t, s))

    # ---- keyframes (sprite display intervals) ------------------------------
    keys = []

    def add(t, s, dx, dy, src):
        if keys and keys[-1]['sprite'] == s and keys[-1]['dx'] == dx and keys[-1]['dy'] == dy:
            return
        keys.append({'t': round(t, 4), 'sprite': s, 'dx': dx, 'dy': dy, 'src': src})

    add(0.0, 0, 0, 0, 'video')
    for t, s, x, y in pr:
        dx = (x - PH_DEFAULT[0]) * 2          # original pixels (28 px wide sprite)
        dy = (y - PH_DEFAULT[1]) * 3          # original pixels (30 px tall sprite)
        add(warp(t), s, dx, dy, 'emulation')
    for t, s in clean:
        add(t - half, s, 0, 0, 'video')
    add(73.12, 0, 0, 0, 'video')

    # cross-check the emulated window motion against the video track
    mism = 0
    for kf in keys:
        if kf['src'] != 'emulation':
            continue
        i = int(np.argmin(np.abs(vt - (kf['t'] + 0.04))))
        t_, s_, x_, y_, d_ = V['track'][i]
        if s_ == kf['sprite'] and (x_ - VID_DEFAULT[0] != kf['dx'] or y_ - VID_DEFAULT[1] != kf['dy']):
            mism += 1
    stats['window_motion_mismatches'] = mism

    curtain = V['curtain_rows']
    cur = [[round(float(vt[i]), 3), int(curtain[i])] for i in range(len(vt))
           if i == 0 or curtain[i] != curtain[i - 1]]

    out = {
        'time_base': 'seconds of data/source/reference.mp4',
        'sprite_size': [28, 60],
        'sprite_pixel_aspect': 'square (doubled vertical resolution); original is 28x30 of 1:2 pixels',
        'sprites': sprites,
        'extra_sprites': extra,
        'keyframes': keys,
        'steps': [{'t': round(warp(t), 4), 'letter': c} for t, c in steps if t <= end_t],
        'notes': [{'t': round(warp(t), 4), 'letter': c} for t, c in notes if t < end_t],
        'curtain_rows': cur,
        'dance_start': keys[1]['t'],
        'music_end': round(warp(end_t), 4),
        'stats': stats,
    }
    json.dump(out, open('data/reference_timeline.json', 'w'), indent=1)
    print(json.dumps(stats, indent=1))
    print('keyframes', len(keys), 'curtain-call keys', len(clean))


if __name__ == '__main__':
    main()
