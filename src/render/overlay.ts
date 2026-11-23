// Debug overlays: skeleton (bones, joints, hierarchy), joint labels and the
// original sprite drawn as a ghost.

import type { Skeleton } from '../rig/skeleton.ts';

type Ctx = CanvasRenderingContext2D;

export interface SkeletonStyle {
  bone: string;
  joint: string;
  hierarchy: string;
  lineWidth: number; // in device px
  jointRadius: number; // in device px
  labels: boolean;
  highlight?: string | null;
}

export const DEFAULT_SKELETON_STYLE: SkeletonStyle = {
  bone: 'rgba(214, 40, 120, 0.9)',
  joint: 'rgba(255, 200, 0, 0.95)',
  hierarchy: 'rgba(40, 120, 220, 0.6)',
  lineWidth: 2,
  jointRadius: 3.2,
  labels: false,
  highlight: null,
};

export function drawSkeleton(ctx: Ctx, camera: DOMMatrix, skel: Skeleton, style: SkeletonStyle = DEFAULT_SKELETON_STYLE) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const P = (x: number, y: number): [number, number] => {
    const p = camera.transformPoint(new DOMPoint(x, y));
    return [p.x, p.y];
  };
  ctx.lineCap = 'round';
  // hierarchy links (parent joint -> child joint)
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = style.hierarchy;
  ctx.lineWidth = 1;
  skel.bones.forEach((_, i) => {
    const p = skel.parentIndex[i];
    if (p < 0) return;
    const a = P(skel.world[p].x, skel.world[p].y);
    const b = P(skel.world[i].x, skel.world[i].y);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  // bones (joint -> tail)
  skel.bones.forEach((b, i) => {
    const w = skel.world[i];
    const t = skel.tailWorld(i);
    const a = P(w.x, w.y);
    const e = P(t[0], t[1]);
    ctx.strokeStyle = style.highlight === b.name ? '#00C2FF' : style.bone;
    ctx.lineWidth = style.highlight === b.name ? style.lineWidth * 2 : style.lineWidth;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(e[0], e[1]);
    ctx.stroke();
  });
  // joints
  skel.bones.forEach((b, i) => {
    const w = skel.world[i];
    const a = P(w.x, w.y);
    ctx.fillStyle = style.highlight === b.name ? '#00C2FF' : style.joint;
    ctx.beginPath();
    ctx.arc(a[0], a[1], style.jointRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (style.labels) {
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(20,20,30,0.85)';
      ctx.fillText(b.name, a[0] + 5, a[1] - 4);
    }
  });
  ctx.restore();
}

/** Parse a '#'/'.' sprite string into rows of 0/1. */
export function parseSprite(s: string): Uint8Array[] {
  return s.split('\n').map((row) => Uint8Array.from(row, (ch) => (ch === '#' ? 1 : 0)));
}

/**
 * Draw a sprite with its top-left at (x, y) in the current transform, one unit
 * per sprite pixel.
 */
export function drawSprite(ctx: Ctx, rows: Uint8Array[], x: number, y: number, color: string) {
  ctx.fillStyle = color;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      let e = c;
      while (e < row.length && row[e]) e++;
      ctx.fillRect(x + c, y + r, e - c, 1.02);
      c = e;
    }
  }
}
