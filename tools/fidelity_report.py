#!/usr/bin/env python3
"""Measure how closely the reconstructed timeline reproduces the reference.

Compares public/data/choreography.json (what the app performs) against the
independent per-frame tracking of the recording (data/work/video_track.json):

  * choreography: sprite shown by the app vs sprite seen in each video frame
  * position: window offset (stage travel / jump) in each video frame
  * rhythm: distance between pose flips and tonal onsets in the soundtrack
  * pose fit: pixel disagreement between fitted skeleton proxy and sprite
Writes docs/fidelity.json and prints a Markdown summary.
"""
import bisect
import json

import numpy as np

C = json.load(open('public/data/choreography.json'))
V = json.load(open('data/work/video_track.json'))
T = json.load(open('data/reference_timeline.json'))
M0 = C['mediaStart']
K = C['keyframes']
kt = [k['t'] for k in K]
ev = C['events']


def shown(t):
    i = max(0, bisect.bisect_right(kt, t) - 1)
    return K[i], i


res = {}
cells = np.load('data/work/video_track_cells.npy')
small = []
for bm in C['sprites']:
    a = np.array([[1.0 if ch == '#' else 0.0 for ch in r] for r in bm.split('\n')])
    small.append((a[0::2] + a[1::2]) / 2)


def explain(fi, k):
    """Hamming distance between video frame fi and keyframe k's sprite at k's position."""
    x = 48 + k['dx']
    y = 12 + k['dy'] // 2
    b = (cells[fi][y:y + 30, x:x + 28] > 115).astype(float)
    if b.shape != (30, 28):
        return 1e9
    sp = small[C['poses'][k['pose']]['sprite']]
    return float(np.abs(b - sp).sum())


# --- per video frame agreement during the dance -------------------------------
rows = []
for fi, (t_v, s, x, y, d) in enumerate(V['track']):
    t = t_v - M0
    if not (ev['danceStart'] + 0.05 < t < ev['musicEnd'] - 0.05) or s < 0:
        continue
    k, i = shown(t)
    sp = C['poses'][k['pose']]['sprite']
    # allow +-1 video frame (the capture samples a 60 Hz display at 29.97 fps)
    cand = [shown(t + dt)[0] for dt in (-1 / 29.97, 0, 1 / 29.97)]
    near = {C['poses'][c['pose']]['sprite'] for c in cand}
    # consistent: the app's sprite at the app's position explains the frame as
    # well as the tracker's best (sprite, position), within 12 of 840 pixels
    consistent = min(explain(fi, c) for c in cand) <= d + 12
    rows.append((sp == s, s in near, (k['dx'], k['dy'] // 2) == (x - 48, y - 12), consistent))
a = np.array(rows)
res['frames_compared'] = int(len(a))
res['sprite_match_exact'] = round(float(a[:, 0].mean()), 4)
res['sprite_match_within_1_video_frame'] = round(float(a[:, 1].mean()), 4)
res['stage_position_match'] = round(float(a[:, 2].mean()), 4)
res['frame_explained_as_well_as_best_sprite'] = round(float(a[:, 3].mean()), 4)

# --- curtain call (video-derived, check against video itself for completeness) ----
cc = []
for t_v, s, x, y, d in V['track']:
    t = t_v - M0
    if ev['musicEnd'] + 0.1 < t < ev['curtainFallStart']:
        k, _ = shown(t)
        cc.append(k['pose'])
res['curtain_call_frames'] = len(cc)

# --- rhythm: flips vs tonal onsets ---------------------------------------------------
flips = np.array([k['t'] for k in K if ev['danceStart'] <= k['t'] <= ev['musicEnd']])
tones = np.array([t for t in C['audioOnsets']['tone'] if ev['danceStart'] <= t <= ev['musicEnd']])
dist = np.array([np.min(np.abs(flips - t)) for t in tones])
signed = np.array([t - flips[np.argmin(np.abs(flips - t))] for t in tones])
res['tone_onsets'] = int(len(tones))
# fraction of onsets within 8 ms of a flip as a function of a time shift of the
# animation: the peak should sit near 0 if music and motion are in sync
scan = []
for lag in range(-60, 61, 4):
    dd = np.array([np.min(np.abs(flips + lag / 1000 - t)) for t in tones])
    scan.append((lag, round(float((dd < 0.008).mean()), 3)))
res['onset_flip_lag_scan'] = scan
res['onset_flip_best_lag_ms'] = max(scan, key=lambda x: x[1])[0]
res['onset_to_nearest_flip_median_ms'] = round(float(np.median(dist) * 1000), 1)

# --- alignment of the emulated timeline to the video ----------------------------------
res['alignment'] = C['alignment']
res['tempo_ratio_original_vs_phillips'] = round(1 / C['alignment']['linear_fit']['scale'], 4)

# --- pose fit -----------------------------------------------------------------------------
errs = {pid: p['fit']['pixelErrors'] for pid, p in C['poses'].items()}
pix = {pid: C['sprites'][p['sprite']].count('#') for pid, p in C['poses'].items()}
rel = {pid: errs[pid] / pix[pid] for pid in errs}
res['pose_fit_pixel_error_mean'] = round(float(np.mean(list(errs.values()))), 1)
res['pose_fit_relative_error_mean'] = round(float(np.mean(list(rel.values()))), 3)
res['pose_fit_worst'] = sorted(((round(v, 3), k) for k, v in rel.items()), reverse=True)[:5]
res['poses_with_manual_overrides'] = sorted(pid for pid, p in C['poses'].items() if p['source'] != 'fit')

json.dump(res, open('docs/fidelity.json', 'w'), indent=1)
print(json.dumps(res, indent=1))
