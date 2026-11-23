#!/usr/bin/env python3
"""Assemble public/data/choreography.json for the web app.

Inputs : data/reference_timeline.json  (build_timeline.py)
         data/work/poses_fit.json       (fit_poses.py)
         data/pose_overrides.json       (manual corrections)
         public/audio/music.wav         (for onset markers)
All times are converted to *media time*: seconds from MEDIA_START in the
reference recording, which is where public/audio/music.wav and
public/ref/reference.(webm|mp4) begin (frame 600 at 29.97 fps).
"""
import json
import wave

import numpy as np

MEDIA_START = 600 * 1001 / 30000   # 20.02002 s, exact video frame time


def onsets(path):
    w = wave.open(path)
    sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    hop, win = int(sr * 0.004), 1024
    n = (len(x) - win) // hop
    f = np.fft.rfftfreq(win, 1 / sr)
    tone = (f > 300) & (f < 1700)
    high = (f > 3500) & (f < 12000)
    et, eh = np.zeros(n), np.zeros(n)
    han = np.hanning(win)
    for i in range(n):
        sp = np.abs(np.fft.rfft(x[i * hop:i * hop + win] * han))
        et[i] = sp[tone].max()
        eh[i] = sp[high].sum()
    t = (np.arange(n) * hop + win / 2) / sr

    def pick(e, thr_k, min_gap):
        d = np.maximum(0, np.diff(np.log(e + 1e-3), prepend=np.log(e[0] + 1e-3)))
        thr = np.median(d) + thr_k * d.std()
        out = []
        for i in range(1, n - 1):
            if d[i] > thr and d[i] >= d[i - 1] and d[i] >= d[i + 1] and e[i] > np.percentile(e, 60):
                if not out or t[i] - out[-1] > min_gap:
                    out.append(float(t[i]))
        return out
    return pick(et, 3.0, 0.08), pick(eh, 3.0, 0.035)


def main():
    T = json.load(open('data/reference_timeline.json'))
    fit = json.load(open('data/work/poses_fit.json'))['poses']
    ovr = json.load(open('data/pose_overrides.json'))
    poses = {}
    for key, p in sorted(fit.items()):
        o = ovr.get(key, {})
        angles = dict(p['angles'])
        angles.update(o.get('angles', {}))
        ch = {'headYaw': 0.0, 'headPitch': 0.0}
        ch.update(o.get('channels', {}))
        poses[key] = {
            'sprite': p['sprite'],
            'root': o.get('root', p['root']),
            'angles': angles,
            'channels': ch,
            'fit': {'cost': p['fit_cost'], 'pixelErrors': p['fit_pixel_errors']},
            'source': 'fit+override' if o else 'fit',
            'note': o.get('_why', ''),
        }

    def mt(t):
        return round(t - MEDIA_START, 4)

    keys = []
    for k in T['keyframes']:
        t = max(0.0, k['t'] - MEDIA_START)
        if keys and t <= keys[-1]['t']:
            keys[-1] = {**keys[-1]}
        keys.append({
            't': round(t, 4), 'pose': 's%02d' % k['sprite'],
            # window motion in sprite units (1 orig px = 1 unit across, 2 units down)
            'dx': k['dx'], 'dy': k['dy'] * 2, 'src': k['src'],
        })
    # de-duplicate the t=0 entry
    keys = [k for i, k in enumerate(keys) if i == 0 or k['t'] > keys[i - 1]['t']]

    # curtain: 1 = closed. rise and fall, sanitised to be monotone
    cur = [(t - MEDIA_START, r / 36.0) for t, r in T['curtain_rows'] if 20 <= t <= 77]
    rise = [(t, c) for t, c in cur if t < 30]
    fall = [(t, c) for t, c in cur if t > 50 and c > 0]
    curtain = [[0.0, 1.0]]
    lvl = 1.0
    for t, c in rise:
        if c < lvl:
            curtain.append([round(t, 3), round(c, 3)])
            lvl = c
    curtain.append([round(rise[-1][0], 3), 0.0]) if lvl > 0 else None
    lvl = 0.0
    fall_start = None
    for t, c in fall:
        if c > lvl:
            if fall_start is None:
                fall_start = t - 0.2
                curtain.append([round(fall_start, 3), 0.0])
            curtain.append([round(t, 3), round(c, 3)])
            lvl = c

    tone_on, tap_on = onsets('public/audio/music.wav')
    music_end = T['music_end'] - MEDIA_START
    tone_on = [round(t, 3) for t in tone_on if 2 < t < music_end + 0.4]
    tap_on = [round(t, 3) for t in tap_on if 2 < t < music_end + 0.4]

    out = {
        'version': 1,
        'title': 'Dancing Demon choreography (reconstructed)',
        'timeBase': 'seconds of media time; media time 0 = %.5f s of data/source/reference.mp4' % MEDIA_START,
        'mediaStart': MEDIA_START,
        'duration': 58.85,
        'rig': 'data/rig-demon.json',
        'spriteSize': T['sprite_size'],
        'sprites': T['sprites'],
        'poses': poses,
        'keyframes': keys,
        'steps': [{'t': mt(s['t']), 'letter': s['letter']} for s in T['steps']],
        'notes': [{'t': mt(s['t']), 'letter': s['letter']} for s in T['notes']],
        'audioOnsets': {'tone': tone_on, 'tap': tap_on},
        'curtain': curtain,
        'events': {
            'curtainRiseStart': curtain[1][0],
            'danceStart': mt(T['dance_start']),
            'musicEnd': round(music_end, 4),
            'curtainFallStart': round(fall_start, 3) if fall_start else None,
        },
        'media': {'audio': 'audio/music.wav', 'video': ['ref/reference.webm', 'ref/reference.mp4'],
                  'videoFps': 30000 / 1001},
        'alignment': T['stats'],
    }
    json.dump(out, open('public/data/choreography.json', 'w'), separators=(',', ':'))
    print('poses', len(poses), 'keyframes', len(keys), 'tone onsets', len(tone_on), 'taps', len(tap_on))
    print('events', out['events'])
    print('curtain', curtain)


if __name__ == '__main__':
    main()
