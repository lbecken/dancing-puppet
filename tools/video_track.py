#!/usr/bin/env python3
"""Track the original Dancing Demon in the reference recording.

1. Decode the video with ffmpeg and sample the TRS-80 128x48 semigraphics grid
   (grid fitted to the edges in the recording: pitch 4.792 x 9.6 px,
   origin 1.5, 8.5).
2. For every frame, match every sprite recovered from the cassette (28x60,
   reduced to the original 28x30 by averaging row pairs) at every
   character-aligned position (x step 2 px, y step 3 px) -> best sprite,
   window position and Hamming distance.
3. Measure the curtain (stage rows covered by the curtain pattern).

Usage: video_track.py reference.mp4 phillips.json out.json
"""
import json
import subprocess
import sys

import numpy as np

W, H = 640, 480
PX, OX, PY, OY = 4.792, 1.5, 9.6, 8.5


def read_frames(path):
    cmd = ['ffmpeg', '-v', 'error', '-i', path, '-map', '0:0', '-f', 'rawvideo',
           '-pix_fmt', 'rgb24', '-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = W * H * 3
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, np.uint8).reshape(H, W, 3)


def frame_times(path):
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                                   '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path])
    return [float(x) for x in out.split()]


def cell_grid(frame):
    g = frame[:, :, 1].astype(np.float32) / 255.0
    cells = np.zeros((48, 128), np.float32)
    for r in range(48):
        y0 = OY + r * PY
        ys = slice(int(y0 + PY * 0.25), int(y0 + PY * 0.75) + 1)
        band = g[ys].mean(0)
        for c in range(128):
            x0 = OX + c * PX
            cells[r, c] = band[int(x0 + PX * 0.3):int(x0 + PX * 0.7) + 1].mean()
    return cells


def main():
    video, phil, out_path = sys.argv[1:4]
    P = json.load(open(phil))
    sprites = []
    for s in P['sprites']:
        a = np.array([[1.0 if ch == '#' else 0.0 for ch in row] for row in s.split('\n')])
        sprites.append((a[0::2] + a[1::2]) / 2)  # 30 x 28
    T = np.array([s.reshape(-1) for s in sprites])          # n x 840
    times = frame_times(video)
    xs = list(range(0, 128 - 28 + 1, 2))
    ys = list(range(0, 48 - 30 + 1, 3))
    track, curtain, cells_all = [], [], []
    for fi, fr in enumerate(read_frames(video)):
        cells = cell_grid(fr)
        cells_all.append((cells * 255).astype(np.uint8))
        b = (cells > 0.45).astype(np.float32)
        # curtain: lowest stage row (6..41) that is >70% lit across the stage
        lit = b[6:42, 8:120].mean(1)
        rows = np.nonzero(lit > 0.7)[0]
        curtain.append(int(rows.max()) + 1 if len(rows) else 0)
        # stage interior only (exclude borders) for sprite search
        best = (1e9, -1, 0, 0)
        if b[6:42, 6:122].sum() < 120:
            track.append([round(times[fi], 4), -1, 0, 0, 0.0])
            continue
        wins, pos = [], []
        for y in ys:
            for x in xs:
                if x < 4 or x + 28 > 124 or y < 0 or y + 30 > 42:
                    continue
                wins.append(b[y:y + 30, x:x + 28].reshape(-1))
                pos.append((x, y))
        Wm = np.array(wins)
        D = Wm.sum(1)[:, None] + T.sum(1)[None, :] - 2 * Wm @ T.T   # Hamming (soft)
        k = np.unravel_index(np.argmin(D), D.shape)
        best = (float(D[k]), int(k[1]), pos[k[0]][0], pos[k[0]][1])
        track.append([round(times[fi], 4), best[1], best[2], best[3], round(best[0], 1)])
    np.save(out_path.replace('.json', '_cells.npy'), np.array(cells_all))
    json.dump({'grid': {'px': PX, 'ox': OX, 'py': PY, 'oy': OY},
               'track': track,  # [t, sprite, win_x_px, win_y_px, distance]
               'curtain_rows': curtain}, open(out_path, 'w'))
    print('frames', len(track))


if __name__ == '__main__':
    main()
