#!/usr/bin/env python3
"""Fit the skeleton (public/data/rig-demon.json) to every recovered sprite.

For each 28x60 sprite we search joint angles + root offset that make a simple
rigid proxy of the demon (polygons for head/torso/pelvis, capsules for limbs)
cover the sprite's pixels. Objective: L1 between rendered coverage (3x3
supersampled) and the sprite, plus a weak prior towards the rest pose.
Limbs are found with exhaustive 2D grid searches (so poses are not stuck in
local minima), then everything is refined by coordinate descent.

Manual corrections and non-skeletal channels (head yaw / facing / pitch,
which cannot be read from a silhouette) live in data/pose_overrides.json and
are applied last, so the fit is reproducible and edits are explicit.

Outputs: public/data/poses.json, data/work/fit_review.png
"""
import json
import math
import sys

import numpy as np
from PIL import Image, ImageDraw

RIG = json.load(open('public/data/rig-demon.json'))
BONES = RIG['bones']
NAMES = [b['name'] for b in BONES]
IDX = {n: i for i, n in enumerate(NAMES)}
REST_ROOT = np.array(RIG['rest_root'], float)
SS = 2
YY, XX = np.mgrid[0:60 * SS, 0:28 * SS]
PX = (XX + 0.5) / SS
PY = (YY + 0.5) / SS

# proxy shapes in bone-local rest frames ------------------------------------
HEAD_POLY = [(-9, -17.5), (9, -17.5), (10, -16.5), (11, -15), (12, -13), (12, -6), (11, -5.5),
             (5, 0.5), (-5, 0.5), (-11, -5.5), (-12, -6), (-12, -13), (-11, -15), (-10, -16.5)]
TORSO_POLY = [(-3, -14.5), (3, -14.5), (6.5, -11.5), (5.2, -9), (5.2, -2.5), (4, 0.5), (-4, 0.5),
              (-5.2, -2.5), (-5.2, -9), (-6.5, -11.5)]
PELVIS_POLY = [(-4, -1.5), (4, -1.5), (3.5, 1.5), (-3.5, 1.5)]
CAPS = {  # bone: (start, end, radius) in bone frame
    'neck': ((0, 0), (0, -2.5), 2.6),
    'upperArmR': ((0, 0), (0, 6.3), 1.2), 'upperArmL': ((0, 0), (0, 6.3), 1.2),
    'forearmR': ((0, 0), (0, 5.2), 1.0), 'forearmL': ((0, 0), (0, 5.2), 1.0),
    'handR': ((0, 1.6), (0, 6.2), 2.2), 'handL': ((0, 1.6), (0, 6.2), 2.2),
    'thighR': ((0, 0), (0, 7.0), 1.05), 'thighL': ((0, 0), (0, 7.0), 1.05),
    'shinR': ((0, 0), (0, 7.5), 1.05), 'shinL': ((0, 0), (0, 7.5), 1.05),
    'footR': ((0, 0), (-6.5, 3.5), 1.5), 'footL': ((0, 0), (6.5, 3.5), 1.5),
}
ANTENNAE = [((-8, -17.5), (-10, -21), 1.3), ((8, -17.5), (10, -21), 1.3)]
LIMBS = {
    'armR': ['upperArmR', 'forearmR', 'handR'], 'armL': ['upperArmL', 'forearmL', 'handL'],
    'legR': ['thighR', 'shinR', 'footR'], 'legL': ['thighL', 'shinL', 'footL'],
}
CORE = ['pelvis', 'spine', 'neck', 'head']


def rot(a):
    r = math.radians(a)
    return np.array([[math.cos(r), -math.sin(r)], [math.sin(r), math.cos(r)]])


def fk(params):
    """params: dict with 'root' (dx,dy) and angle per bone -> world (R, t) per bone."""
    world = {}
    for b in BONES:
        R_local = rot(params.get(b['name'], 0.0))
        if b['parent'] is None:
            t = REST_ROOT + np.array(params['root'])
            world[b['name']] = (R_local, t)
        else:
            Rp, tp = world[b['parent']]
            t = tp + Rp @ np.array(b['offset'], float)
            world[b['name']] = (Rp @ R_local, t)
    return world


def cap_mask(p0, p1, r):
    d = p1 - p0
    L2 = d @ d + 1e-9
    u = np.clip(((PX - p0[0]) * d[0] + (PY - p0[1]) * d[1]) / L2, 0, 1)
    qx = p0[0] + u * d[0] - PX
    qy = p0[1] + u * d[1] - PY
    return qx * qx + qy * qy <= r * r


def poly_mask(pts):
    pts = np.asarray(pts)
    inside = np.zeros(PX.shape, bool)
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        cond = (y1 > PY) != (y2 > PY)
        xin = (x2 - x1) * (PY - y1) / (y2 - y1 + 1e-12) + x1
        inside ^= cond & (PX < xin)
    return inside


def tf(world, bone, pts):
    R, t = world[bone]
    return [t + R @ np.array(p, float) for p in pts]


def render_parts(world, parts):
    m = np.zeros(PX.shape, bool)
    for part in parts:
        if part == 'head':
            m |= poly_mask(tf(world, 'head', HEAD_POLY))
            for a, b, r in ANTENNAE:
                p0, p1 = tf(world, 'head', [a, b])
                m |= cap_mask(p0, p1, r)
        elif part == 'spine':
            m |= poly_mask(tf(world, 'spine', TORSO_POLY))
        elif part == 'pelvis':
            m |= poly_mask(tf(world, 'pelvis', PELVIS_POLY))
        else:
            a, b, r = CAPS[part]
            p0, p1 = tf(world, part, [a, b])
            m |= cap_mask(p0, p1, r)
    return m


ALL_PARTS = NAMES


def coverage(mask):
    return mask.reshape(60, SS, 28, SS).mean((1, 3))


# anatomical bounds (degrees, local angles); outside -> large penalty
BOUNDS = {
    'upperArmR': (-35, 195), 'upperArmL': (-195, 35),
    'forearmR': (-165, 165), 'forearmL': (-165, 165),
    'handR': (-120, 120), 'handL': (-120, 120),
    'thighR': (-110, 110), 'thighL': (-110, 110),
    'shinR': (-150, 150), 'shinL': (-150, 150),
    'footR': (-80, 80), 'footL': (-80, 80),
    'spine': (-45, 45), 'neck': (-40, 40), 'head': (-40, 40), 'pelvis': (-45, 45),
}
CORE_PARTS = ['pelvis', 'spine', 'neck', 'head']
LIMB_PARTS = [p for p in NAMES if p not in CORE_PARTS]
HIDE_W = 0.35


def prior(params):
    s = 0.0
    for n, (lo, hi) in BOUNDS.items():
        a = params.get(n, 0.0)
        if a < lo:
            s += 50 + (lo - a)
        elif a > hi:
            s += 50 + (a - hi)
    for n in NAMES:
        a = params.get(n, 0.0)
        w = 0.02 if n in ('pelvis', 'spine', 'neck', 'head') else 0.004
        s += w * (a / 30.0) ** 2
    return s


def make_target(bitmap):
    t = np.array([[1.0 if c == '#' else 0.0 for c in row] for row in bitmap.split('\n')])
    # fill enclosed holes in the head region (eyes), not between arms and body
    h, w = t.shape
    seen = np.zeros_like(t, bool)
    for sy in range(h):
        for sx in range(w):
            if t[sy, sx] or seen[sy, sx]:
                continue
            comp, stack, border = [], [(sy, sx)], False
            seen[sy, sx] = True
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                if y in (0, h - 1) or x in (0, w - 1):
                    border = True
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and not t[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if not border and max(y for y, _ in comp) < 26 and len(comp) <= 30:
                for y, x in comp:
                    t[y, x] = 1.0
    return t


class Fitter:
    def __init__(self, target):
        self.target = target

    def cost(self, params, parts=ALL_PARTS, base=None, core=None):
        world = fk(params)
        if parts is ALL_PARTS:
            core = render_parts(world, CORE_PARTS)
            limbs = render_parts(world, LIMB_PARTS)
            m = core | limbs
        else:
            limbs = render_parts(world, parts)
            m = limbs if base is None else (limbs | base)
        hidden = 0.0
        if core is not None:
            hidden = HIDE_W * float((limbs & core).sum()) / (SS * SS)
        return float(np.abs(coverage(m) - self.target).sum()) + prior(params) + hidden

    def coord(self, params, keys, steps=(16, 8, 4, 2, 1), base=None, parts=ALL_PARTS, core=None):
        best = self.cost(params, parts, base, core)
        for st in steps:
            improved = True
            while improved:
                improved = False
                for k in keys:
                    for sgn in (1, -1):
                        trial = dict(params)
                        if k == 'rootx':
                            trial['root'] = (params['root'][0] + sgn * st / 8, params['root'][1])
                        elif k == 'rooty':
                            trial['root'] = (params['root'][0], params['root'][1] + sgn * st / 8)
                        else:
                            trial[k] = params.get(k, 0.0) + sgn * st
                        c = self.cost(trial, parts, base, core)
                        if c < best - 1e-6:
                            best, params, improved = c, trial, True
        return params, best

    def limb_search(self, params, limb):
        bones = LIMBS[limb]
        others = [p for p in ALL_PARTS if p not in bones]
        world = fk(params)
        base = render_parts(world, others)
        core = render_parts(world, CORE_PARTS)
        best = (self.cost(params, bones, base, core), params)
        a1s = range(-180, 180, 15)
        a2s = range(-150, 151, 15)
        for a3 in (-45, 0, 45):
            for a1 in a1s:
                for a2 in a2s:
                    trial = dict(params)
                    trial[bones[0]], trial[bones[1]], trial[bones[2]] = a1, a2, a3
                    c = self.cost(trial, bones, base, core)
                    if c < best[0]:
                        best = (c, trial)
        params = best[1]
        params, _ = self.coord(params, bones, steps=(8, 4, 2, 1), base=base, parts=bones, core=core)
        return params


def fit_sprite(bitmap, init):
    f = Fitter(make_target(bitmap))
    p = dict(init)
    core = ['rootx', 'rooty'] + CORE
    p, _ = f.coord(p, core)
    for _ in range(2):
        for limb in ('legR', 'legL', 'armR', 'armL'):
            p = f.limb_search(p, limb)
        p, _ = f.coord(p, core, steps=(8, 4, 2, 1))
    keys = ['rootx', 'rooty'] + NAMES
    p, c = f.coord(p, keys, steps=(4, 2, 1, 0.5))
    world = fk(p)
    m = render_parts(world, ALL_PARTS)
    err = int((np.abs((coverage(m) > 0.5).astype(float) - f.target)).sum())
    return p, c, err


def wrap(a):
    return (a + 180.0) % 360.0 - 180.0


def main():
    T = json.load(open('data/reference_timeline.json'))
    sprites = T['sprites']
    global sys_out
    sys_out = 'data/work/poses_fit.json'
    only = [int(x) for x in sys.argv[1:]] if len(sys.argv) > 1 else None
    try:
        prev = json.load(open(sys_out))['poses']
    except Exception:
        prev = {}
    rest = {'root': (0.0, 0.0)}
    results = {}
    stand_fit = fit_sprite(sprites[0], rest)
    stand = stand_fit[0]
    todo = [sid for sid in range(len(sprites))
            if only is None or sid in only or 's%02d' % sid not in prev]
    jobs = [(sprites[sid], stand) for sid in todo] + [(sprites[sid], rest) for sid in todo]
    from multiprocessing import Pool
    with Pool() as pool:
        out = pool.starmap(fit_sprite, jobs)
    best = {}
    for sid, r in zip(todo + todo, out):
        if sid not in best or r[1] < best[sid][1]:
            best[sid] = r
    for sid, bm in enumerate(sprites):
        key = 's%02d' % sid
        if sid not in best:
            results[key] = prev[key]
            continue
        p, c, err = best[sid]
        results[key] = {
            'sprite': sid,
            'root': [round(p['root'][0], 3), round(p['root'][1], 3)],
            'angles': {n: round(wrap(p.get(n, 0.0)), 2) for n in NAMES},
            'fit_cost': round(c, 2), 'fit_pixel_errors': err,
        }
        print(key, 'cost %.1f err %d' % (c, err), flush=True)
    json.dump({'poses': results}, open(sys_out, 'w'), indent=1)


if __name__ == '__main__':
    main()
