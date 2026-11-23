#!/usr/bin/env python3
"""Render a review sheet: each sprite (grey), fitted proxy outline (orange),
skeleton (cyan joints / magenta bones). Usage: review_fits.py poses.json out.png [ids...]"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, 'tools')
import fit_poses as F  # noqa: E402

SC = 8


def draw(sid, bitmap, pose):
    t = np.array([[1 if c == '#' else 0 for c in r] for r in bitmap.split('\n')], np.uint8)
    im = Image.fromarray(t * 110 + 20).resize((28 * SC, 60 * SC), Image.NEAREST).convert('RGB')
    d = ImageDraw.Draw(im)
    p = {'root': tuple(pose['root']), **pose['angles']}
    world = F.fk(p)
    m = F.render_parts(world, F.ALL_PARTS)
    cov = F.coverage(m) > 0.5
    for y in range(60):
        for x in range(28):
            if cov[y, x] and not t[y, x]:
                d.rectangle([x * SC + 2, y * SC + 2, x * SC + SC - 3, y * SC + SC - 3], outline=(255, 80, 60))
            if t[y, x] and not cov[y, x]:
                d.rectangle([x * SC + 3, y * SC + 3, x * SC + SC - 4, y * SC + SC - 4], fill=(60, 200, 255))
    for b in F.BONES:
        R, tt = world[b['name']]
        tail = tt + R @ np.array(b['tail'], float)
        d.line([tuple(tt * SC), tuple(tail * SC)], fill=(255, 0, 200), width=3)
        d.ellipse([tt[0] * SC - 4, tt[1] * SC - 4, tt[0] * SC + 4, tt[1] * SC + 4], fill=(255, 230, 0))
    d.text((4, 4), 's%02d' % sid, fill=(255, 255, 255))
    return im


def main():
    poses = json.load(open(sys.argv[1]))['poses']
    sprites = json.load(open('data/reference_timeline.json'))['sprites']
    ids = [int(x) for x in sys.argv[3:]] or [v['sprite'] for v in poses.values()]
    ims = [draw(i, sprites[i], poses['s%02d' % i]) for i in ids if 's%02d' % i in poses]
    cols = min(8, len(ims))
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (28 * SC + 6), rows * (60 * SC + 6)), (0, 0, 0))
    for j, im in enumerate(ims):
        sheet.paste(im, ((j % cols) * (28 * SC + 6), (j // cols) * (60 * SC + 6)))
    sheet.save(sys.argv[2])


if __name__ == '__main__':
    main()
