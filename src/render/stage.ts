// Stage: background, floor + contact shadow, marionette control bar and
// strings, curtain. Everything here is a pure function of the solved skeleton
// and the playback time (no per-frame state), so seeking is exact.

import type { Skeleton } from '../rig/skeleton.ts';
import type { StringDef, Vec2 } from '../types.ts';

type Ctx = CanvasRenderingContext2D;

export const STAGE_COLORS = {
  bgTop: '#F8F0EA',
  bgBottom: '#EEDDD2',
  spot: 'rgba(255, 246, 236, 0.85)',
  floor: '#E6D0C3',
  floorLine: 'rgba(150, 110, 90, 0.18)',
  shadow: 'rgba(110, 70, 50, 0.22)',
  string: 'rgba(150, 112, 70, 0.75)',
  barLight: '#EFCB98',
  barDark: '#B98552',
  curtain: '#C2848F',
  curtainDark: '#9E6170',
  curtainLight: '#D9A3AB',
  fringe: '#D8B36E',
};

export interface Camera {
  /** device pixels per puppet unit */
  scale: number;
  /** device-pixel position of puppet point (0, groundY) */
  originX: number;
  groundY: number;
  /** puppet ground_y in rig units */
  rigGround: number;
  width: number;
  height: number;
}

export function makeCamera(width: number, height: number, rigHeight: number, rigGround: number): Camera {
  const scale = Math.min((height * 0.56) / rigHeight, (width * 0.42) / 60);
  return { scale, originX: width / 2, groundY: height * 0.87, rigGround, width, height };
}

export function cameraMatrix(c: Camera): DOMMatrix {
  // puppet (x, y) -> device (originX + s*x, groundY + s*(y - rigGround))
  return new DOMMatrix([c.scale, 0, 0, c.scale, c.originX, c.groundY - c.scale * c.rigGround]);
}

export function toScreen(c: Camera, p: Vec2): Vec2 {
  return [c.originX + c.scale * p[0], c.groundY + c.scale * (p[1] - c.rigGround)];
}

export function drawBackground(ctx: Ctx, c: Camera, focusX: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, STAGE_COLORS.bgTop);
  g.addColorStop(1, STAGE_COLORS.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  // soft spotlight following the puppet a little
  const sx = c.originX + (focusX - c.originX) * 0.5;
  const r = ctx.createRadialGradient(sx, c.groundY - c.height * 0.3, 10, sx, c.groundY - c.height * 0.3, c.height * 0.62);
  r.addColorStop(0, STAGE_COLORS.spot);
  r.addColorStop(1, 'rgba(255,246,236,0)');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, c.width, c.height);
  // floor
  const f = ctx.createLinearGradient(0, c.groundY - 2, 0, c.height);
  f.addColorStop(0, STAGE_COLORS.floor);
  f.addColorStop(1, '#E2C9BB');
  ctx.fillStyle = f;
  ctx.fillRect(0, c.groundY - c.scale * 1.2, c.width, c.height);
  ctx.fillStyle = STAGE_COLORS.floorLine;
  ctx.fillRect(0, c.groundY - c.scale * 1.2, c.width, Math.max(1, c.scale * 0.25));
}

/** Contact shadow under the feet; shrinks and fades as the puppet leaves the floor. */
export function drawShadow(ctx: Ctx, c: Camera, centerX: number, clearance: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const k = 1 / (1 + clearance / 18);
  const w = c.scale * 26 * (0.75 + 0.25 * k);
  const h = c.scale * 3.2 * (0.7 + 0.3 * k);
  const x = c.originX + c.scale * centerX;
  const y = c.groundY - c.scale * 0.6;
  const g = ctx.createRadialGradient(x, y, 1, x, y, w);
  g.addColorStop(0, `rgba(110,70,50,${0.26 * k})`);
  g.addColorStop(1, 'rgba(110,70,50,0)');
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, h / w);
  ctx.translate(-x, -y);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, w, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export interface BarState {
  /** bar centre in puppet units */
  x: number;
  y: number;
  /** tilt in radians */
  tilt: number;
}

const ANCHORS: Record<StringDef['anchor'], Vec2> = {
  center: [0, 0],
  barLeft: [-25, 0],
  barRight: [25, 0],
  crossFront: [-8.5, 4.2],
  crossBack: [8.5, -4.2],
};

function anchorWorld(bar: BarState, a: StringDef['anchor']): Vec2 {
  const [x, y] = ANCHORS[a];
  const cs = Math.cos(bar.tilt);
  const sn = Math.sin(bar.tilt);
  return [bar.x + cs * x - sn * y, bar.y + sn * x + cs * y];
}

function woodBar(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, w: number) {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  ctx.save();
  ctx.translate(x0, y0);
  ctx.rotate(ang);
  const g = ctx.createLinearGradient(0, -w / 2, 0, w / 2);
  g.addColorStop(0, STAGE_COLORS.barLight);
  g.addColorStop(0.55, '#DDAE76');
  g.addColorStop(1, STAGE_COLORS.barDark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(0, -w / 2, len, w, w / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(118,74,36,0.45)';
  ctx.lineWidth = 0.3;
  ctx.stroke();
  ctx.restore();
}

export class Strings {
  private restLen: number[] = [];
  constructor(private defs: StringDef[]) {}

  /** Record rest lengths (call once with the skeleton in rest pose). */
  calibrate(skel: Skeleton, bar: BarState) {
    this.restLen = this.defs.map((d) => {
      const p = skel.toWorld(d.bone, d.point);
      const a = anchorWorld(bar, d.anchor);
      return Math.hypot(p[0] - a[0], p[1] - a[1]);
    });
  }

  draw(ctx: Ctx, camera: DOMMatrix, skel: Skeleton, bar: BarState, scale: number) {
    ctx.save();
    ctx.setTransform(camera);
    // strings first (behind the bar)
    ctx.strokeStyle = STAGE_COLORS.string;
    ctx.lineWidth = Math.max(0.9, scale * 0.12) / scale;
    this.defs.forEach((d, i) => {
      const p = skel.toWorld(d.bone, d.point);
      const a = anchorWorld(bar, d.anchor);
      const dist = Math.hypot(p[0] - a[0], p[1] - a[1]);
      const slack = Math.max(0, (this.restLen[i] ?? dist) - dist);
      const sag = Math.min(slack, 18) * 0.5;
      const mx = (p[0] + a[0]) / 2 + sag * 0.25;
      const my = (p[1] + a[1]) / 2 + sag;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(mx, my, p[0], p[1]);
      ctx.stroke();
      // tiny screw eye at the attachment
      ctx.beginPath();
      ctx.arc(p[0], p[1], 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#C79A55';
      ctx.fill();
    });
    // control bar: long main bar + crossbar seen in perspective
    const l = anchorWorld(bar, 'barLeft');
    const r = anchorWorld(bar, 'barRight');
    const cf = anchorWorld(bar, 'crossFront');
    const cb = anchorWorld(bar, 'crossBack');
    const ext = (p: Vec2, q: Vec2, k: number): Vec2 => [p[0] + (p[0] - q[0]) * k, p[1] + (p[1] - q[1]) * k];
    const cb2 = ext(cb, cf, 0.12);
    const cf2 = ext(cf, cb, 0.12);
    woodBar(ctx, cb2[0], cb2[1], cf2[0], cf2[1], 2.2);
    const l2 = ext(l, r, 0.04);
    const r2 = ext(r, l, 0.04);
    woodBar(ctx, l2[0], l2[1], r2[0], r2[1], 2.6);
    ctx.restore();
  }
}

/** Curtain closing from the top: cover 0 = open, 1 = fully closed. */
export function drawCurtain(ctx: Ctx, c: Camera, cover: number, t: number) {
  if (cover <= 0.001) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const bottom = cover * (c.groundY + c.scale * 2);
  const folds = 14;
  const fw = c.width / folds;
  const g = ctx.createLinearGradient(0, 0, fw, 0);
  g.addColorStop(0, STAGE_COLORS.curtainDark);
  g.addColorStop(0.35, STAGE_COLORS.curtainLight);
  g.addColorStop(0.6, STAGE_COLORS.curtain);
  g.addColorStop(1, STAGE_COLORS.curtainDark);
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(c.width, 0);
  ctx.lineTo(c.width, bottom);
  // scalloped hem, swaying very slightly while moving
  for (let i = folds; i > 0; i--) {
    const x0 = i * fw;
    const x1 = (i - 1) * fw;
    const sway = Math.sin(t * 3 + i) * c.scale * 0.4;
    ctx.quadraticCurveTo((x0 + x1) / 2 + sway, bottom + fw * 0.22, x1, bottom);
  }
  ctx.closePath();
  // repeat the fold gradient across the width
  for (let i = 0; i < folds; i++) {
    ctx.save();
    ctx.clip();
    ctx.translate(i * fw, 0);
    ctx.fillRect(0, 0, fw + 1, bottom + fw);
    ctx.restore();
  }
  // fringe
  ctx.strokeStyle = STAGE_COLORS.fringe;
  ctx.lineWidth = Math.max(2, c.scale * 0.9);
  ctx.beginPath();
  ctx.moveTo(c.width, bottom);
  for (let i = folds; i > 0; i--) {
    const x0 = i * fw;
    const x1 = (i - 1) * fw;
    const sway = Math.sin(t * 3 + i) * c.scale * 0.4;
    ctx.quadraticCurveTo((x0 + x1) / 2 + sway, bottom + fw * 0.22, x1, bottom);
  }
  ctx.stroke();
  ctx.restore();
}

/** Piecewise-linear lookup in [[t, v], ...]. */
export function lookupLinear(pts: [number, number][], t: number): number {
  if (!pts.length) return 0;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t < pts[i][0]) {
      const [t0, v0] = pts[i - 1];
      const [t1, v1] = pts[i];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return pts[pts.length - 1][1];
}
