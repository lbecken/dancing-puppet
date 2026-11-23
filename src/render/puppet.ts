// Artwork of the wooden cat marionette.
//
// Every body part is a fixed shape authored in its bone's local rest frame
// (joint at the origin, bone pointing along +y for limbs, -y for the spine /
// neck / head). Parts are drawn with ctx.setTransform(bone world transform),
// so they only ever rotate and translate: no bending, stretching or skinning.
// Shading is cylindrical across each part, with the highlight placed according
// to a fixed world light so it stays coherent while parts rotate.

import type { Skeleton } from '../rig/skeleton.ts';
import type { PoseChannels } from '../types.ts';

export const PALETTE = {
  woodLight: '#F6DDB8',
  wood: '#E4B886',
  woodMid: '#D6A36D',
  woodDark: '#B27A47',
  woodDeep: '#93602F',
  joint: '#CF975C',
  outline: 'rgba(118, 74, 36, 0.55)',
  grain: 'rgba(150, 98, 50, 0.13)',
  face: '#6A4024',
  innerEar: '#D79A74',
};

// world direction *towards* the light (upper left)
const LIGHT: [number, number] = [-0.56, -0.83];

type Ctx = CanvasRenderingContext2D;

interface Frame {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Shading gradient across local x in [-w, w] for a part whose local x-axis is (cos, sin). */
function woodGradient(ctx: Ctx, w: number, cos: number, sin: number, y = 0, tone = 0): CanvasGradient {
  const k = cos * LIGHT[0] + sin * LIGHT[1]; // >0: light on +x side
  const g = ctx.createLinearGradient(-w, y, w, y);
  const h = 0.5 + 0.3 * k;
  const c = (x: number) => Math.min(1, Math.max(0, x));
  const dark = tone < 0 ? PALETTE.woodDeep : PALETTE.woodDark;
  g.addColorStop(0, k > 0 ? PALETTE.woodMid : dark);
  g.addColorStop(c(h - 0.3), PALETTE.wood);
  g.addColorStop(c(h), PALETTE.woodLight);
  g.addColorStop(c(h + 0.28), PALETTE.wood);
  g.addColorStop(1, k > 0 ? dark : PALETTE.woodMid);
  return g;
}

function ballGradient(ctx: Ctx, r: number): CanvasGradient {
  const g = ctx.createRadialGradient(LIGHT[0] * r * 0.45, LIGHT[1] * r * 0.45, r * 0.1, 0, 0, r);
  g.addColorStop(0, PALETTE.woodLight);
  g.addColorStop(0.55, PALETTE.joint);
  g.addColorStop(1, PALETTE.woodDeep);
  return g;
}

export class PuppetRenderer {
  outline = true;
  grain = true;
  private base: Frame = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  constructor(private skel: Skeleton) {}

  /** Set ctx transform to bone i's world frame (on top of the camera transform). */
  private enter(ctx: Ctx, i: number) {
    const w = this.skel.world[i];
    const B = this.base;
    // camera * translate(w.x,w.y) * rotate(w.angle)
    const ex = B.a * w.x + B.c * w.y + B.e;
    const fy = B.b * w.x + B.d * w.y + B.f;
    ctx.setTransform(
      B.a * w.cos + B.c * w.sin,
      B.b * w.cos + B.d * w.sin,
      -B.a * w.sin + B.c * w.cos,
      -B.b * w.sin + B.d * w.cos,
      ex,
      fy,
    );
  }

  private idx(name: string) {
    return this.skel.index.get(name)!;
  }

  private stroke(ctx: Ctx) {
    if (!this.outline) return;
    ctx.lineWidth = 0.32;
    ctx.strokeStyle = PALETTE.outline;
    ctx.stroke();
  }

  private ball(ctx: Ctx, bone: string, x: number, y: number, r: number) {
    this.enter(ctx, this.idx(bone));
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = ballGradient(ctx, r);
    ctx.fill();
    this.stroke(ctx);
  }

  /** Tapered rounded segment along +y (or -y when len < 0) in bone frame. */
  private segment(ctx: Ctx, bone: string, y0: number, y1: number, w0: number, w1: number, grainLines = 2) {
    const i = this.idx(bone);
    this.enter(ctx, i);
    const w = this.skel.world[i];
    const dir = Math.sign(y1 - y0) || 1;
    const r0 = w0 / 2;
    const r1 = w1 / 2;
    ctx.beginPath();
    // body with rounded caps: left side down, cap, right side up, cap
    ctx.moveTo(-r0, y0);
    ctx.bezierCurveTo(-r0 * 1.04, y0 + (y1 - y0) * 0.35, -r1 * 1.08, y0 + (y1 - y0) * 0.7, -r1, y1);
    ctx.arc(0, y1, r1, Math.PI, 0, dir > 0);
    ctx.bezierCurveTo(r1 * 1.08, y0 + (y1 - y0) * 0.7, r0 * 1.04, y0 + (y1 - y0) * 0.35, r0, y0);
    ctx.arc(0, y0, r0, 0, Math.PI, dir > 0);
    ctx.closePath();
    ctx.fillStyle = woodGradient(ctx, Math.max(r0, r1), w.cos, w.sin);
    ctx.fill();
    if (this.grain && grainLines > 0) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = PALETTE.grain;
      ctx.lineWidth = 0.22;
      for (let g = 0; g < grainLines; g++) {
        const x = (g - (grainLines - 1) / 2) * (r0 * 0.7);
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.bezierCurveTo(x + 0.4, y0 + (y1 - y0) * 0.4, x - 0.4, y0 + (y1 - y0) * 0.6, x * 0.85, y1);
        ctx.stroke();
      }
      ctx.restore();
    }
    this.stroke(ctx);
  }

  private hand(ctx: Ctx, bone: string) {
    const i = this.idx(bone);
    this.enter(ctx, i);
    const w = this.skel.world[i];
    // flat oval paddle, slightly wider towards the fingers
    ctx.beginPath();
    ctx.moveTo(-1.7, 1.2);
    ctx.bezierCurveTo(-3.9, 2.8, -3.8, 8.6, -1.2, 9.6);
    ctx.bezierCurveTo(0.2, 10.1, 1.6, 10.0, 2.6, 9.0);
    ctx.bezierCurveTo(4.4, 7.0, 3.6, 2.6, 1.7, 1.2);
    ctx.closePath();
    ctx.fillStyle = woodGradient(ctx, 3.6, w.cos, w.sin, 0);
    ctx.fill();
    this.stroke(ctx);
  }

  private foot(ctx: Ctx, bone: string, side: number) {
    const i = this.idx(bone);
    this.enter(ctx, i);
    const w = this.skel.world[i];
    // rounded clog pointing outwards (side = -1 screen left, +1 right)
    ctx.save();
    ctx.scale(side, 1);
    ctx.beginPath();
    ctx.moveTo(-2.4, 1.0);
    ctx.bezierCurveTo(-1.0, -0.6, 4.6, 0.2, 7.6, 1.6);
    ctx.bezierCurveTo(9.6, 2.5, 9.6, 4.6, 7.4, 4.8);
    ctx.lineTo(-1.2, 4.9);
    ctx.bezierCurveTo(-3.2, 4.9, -3.6, 2.4, -2.4, 1.0);
    ctx.closePath();
    ctx.restore();
    ctx.fillStyle = woodGradient(ctx, 4.5, w.cos, w.sin, 0);
    ctx.fill();
    this.stroke(ctx);
  }

  private pelvis(ctx: Ctx) {
    const i = this.idx('pelvis');
    this.enter(ctx, i);
    const w = this.skel.world[i];
    ctx.beginPath();
    ctx.moveTo(-6.6, -4.2);
    ctx.quadraticCurveTo(0, -5.4, 6.6, -4.2);
    ctx.bezierCurveTo(8.4, -2.6, 9.2, 3.0, 8.4, 6.4);
    ctx.quadraticCurveTo(4.6, 7.6, 1.2, 6.4);
    ctx.quadraticCurveTo(0, 5.4, -1.2, 6.4);
    ctx.quadraticCurveTo(-4.6, 7.6, -8.4, 6.4);
    ctx.bezierCurveTo(-9.2, 3.0, -8.4, -2.6, -6.6, -4.2);
    ctx.closePath();
    ctx.fillStyle = woodGradient(ctx, 9, w.cos, w.sin);
    ctx.fill();
    this.stroke(ctx);
  }

  private chest(ctx: Ctx) {
    const i = this.idx('spine');
    this.enter(ctx, i);
    const w = this.skel.world[i];
    ctx.beginPath();
    ctx.moveTo(-5.4, -5.2);
    ctx.bezierCurveTo(-7.2, -10.0, -10.6, -15.5, -10.0, -19.6);
    ctx.bezierCurveTo(-9.6, -22.2, -7.4, -23.2, -4.0, -23.2);
    ctx.lineTo(4.0, -23.2);
    ctx.bezierCurveTo(7.4, -23.2, 9.6, -22.2, 10.0, -19.6);
    ctx.bezierCurveTo(10.6, -15.5, 7.2, -10.0, 5.4, -5.2);
    ctx.quadraticCurveTo(0, -3.8, -5.4, -5.2);
    ctx.closePath();
    ctx.fillStyle = woodGradient(ctx, 10.5, w.cos, w.sin, -14);
    ctx.fill();
    if (this.grain) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = PALETTE.grain;
      ctx.lineWidth = 0.25;
      for (const x of [-4.5, -1.2, 2.2, 5.4]) {
        ctx.beginPath();
        ctx.moveTo(x * 1.3, -23);
        ctx.bezierCurveTo(x * 1.1, -16, x * 0.8 + 0.6, -10, x * 0.55, -4);
        ctx.stroke();
      }
      ctx.restore();
    }
    this.stroke(ctx);
  }

  private head(ctx: Ctx, ch: PoseChannels) {
    const i = this.idx('head');
    this.enter(ctx, i);
    const w = this.skel.world[i];
    const yaw = (ch.headYaw * Math.PI) / 180;
    const back = Math.cos(yaw) < 0;
    const cx = 0;
    const cy = -11;
    // ears: rigid triangles that rotate around the head's vertical axis
    for (const s of [-1, 1]) {
      const a = yaw + s * 0.72;
      const ex = cx + Math.sin(a) * 9.6;
      const depth = Math.cos(a);
      ctx.save();
      ctx.translate(ex, cy - 7.5);
      ctx.rotate(s * 0.2 + Math.sin(yaw) * 0.15);
      const wEar = 4.4 * (0.75 + 0.25 * Math.abs(depth));
      ctx.beginPath();
      ctx.moveTo(-wEar, 2.6);
      ctx.quadraticCurveTo(-wEar * 0.55, -4.5, -0.2, -9.6);
      ctx.quadraticCurveTo(0.6, -9.9, 0.9, -9.2);
      ctx.quadraticCurveTo(wEar * 0.7, -4.0, wEar, 2.6);
      ctx.closePath();
      ctx.fillStyle = woodGradient(ctx, wEar, w.cos, w.sin);
      ctx.fill();
      this.stroke(ctx);
      if (!back && depth > 0.15) {
        ctx.beginPath();
        ctx.moveTo(-wEar * 0.5, 1.6);
        ctx.quadraticCurveTo(-wEar * 0.3, -3.6, 0.05, -7.2);
        ctx.quadraticCurveTo(wEar * 0.35, -3.2, wEar * 0.5, 1.6);
        ctx.closePath();
        ctx.fillStyle = PALETTE.innerEar;
        ctx.globalAlpha = 0.55 * Math.min(1, depth * 1.5);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    // head: soft rounded cat head, a little wider at the cheeks
    ctx.beginPath();
    ctx.moveTo(cx, cy - 10.6);
    ctx.bezierCurveTo(cx + 8.2, cy - 10.8, cx + 12.6, cy - 6.2, cx + 12.6, cy - 0.6);
    ctx.bezierCurveTo(cx + 12.6, cy + 6.2, cx + 7.4, cy + 10.2, cx, cy + 10.2);
    ctx.bezierCurveTo(cx - 7.4, cy + 10.2, cx - 12.6, cy + 6.2, cx - 12.6, cy - 0.6);
    ctx.bezierCurveTo(cx - 12.6, cy - 6.2, cx - 8.2, cy - 10.8, cx, cy - 10.6);
    ctx.closePath();
    const g = ctx.createRadialGradient(cx - 4.2, cy - 5.2, 1, cx, cy, 14.5);
    g.addColorStop(0, PALETTE.woodLight);
    g.addColorStop(0.55, PALETTE.wood);
    g.addColorStop(0.85, PALETTE.woodMid);
    g.addColorStop(1, PALETTE.woodDark);
    ctx.fillStyle = g;
    ctx.fill();
    this.stroke(ctx);

    if (back) {
      // back of the head: a faint grain whorl instead of the face
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = PALETTE.grain;
      ctx.lineWidth = 0.3;
      for (let r = 2; r < 9; r += 2.2) {
        ctx.beginPath();
        ctx.ellipse(cx + Math.sin(yaw) * 2, cy + 1, r * 1.2, r, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    // face: two closed, smiling eyes (arcs). They sit on the head's sphere and
    // move with yaw (turning) and pitch (nodding / looking down).
    const pitch = ch.headPitch;
    const eyeY = cy - 0.4 + pitch * 4.6;
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.face;
    for (const s of [-1, 1]) {
      const a = yaw + s * 0.5;
      const vis = Math.cos(a);
      if (vis < 0.12) continue;
      const ex = cx + Math.sin(a) * 10.4;
      const half = 2.3 * vis;
      const lift = 1.7 * (1 - 0.45 * pitch);
      ctx.lineWidth = 0.95;
      ctx.globalAlpha = Math.min(1, (vis - 0.12) * 3);
      ctx.beginPath();
      ctx.moveTo(ex - half, eyeY);
      ctx.quadraticCurveTo(ex, eyeY - lift * 1.6, ex + half, eyeY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Draw the puppet. `camera` is the canvas transform that maps puppet units
   * to device pixels; the skeleton must already be solved.
   */
  draw(ctx: Ctx, camera: DOMMatrix, ch: PoseChannels) {
    this.base = { a: camera.a, b: camera.b, c: camera.c, d: camera.d, e: camera.e, f: camera.f };
    ctx.save();
    ctx.lineJoin = 'round';
    // legs (far to near does not matter in a frontal view)
    for (const s of ['R', 'L']) {
      this.ball(ctx, `thigh${s}`, 0, 0, 3.6);
      this.segment(ctx, `thigh${s}`, 1.4, 18.0, 6.6, 5.2, 2);
      this.ball(ctx, `shin${s}`, 0, 0, 3.0);
      this.segment(ctx, `shin${s}`, 1.4, 18.6, 5.2, 3.9, 2);
      this.ball(ctx, `foot${s}`, 0, 0, 2.5);
      this.foot(ctx, `foot${s}`, s === 'R' ? -1 : 1);
    }
    this.pelvis(ctx);
    this.ball(ctx, 'spine', 0, -2.6, 4.1); // waist joint
    this.chest(ctx);
    this.ball(ctx, 'neck', 0, -0.6, 2.7);
    this.segment(ctx, 'neck', -0.2, -4.2, 3.7, 3.3, 0);
    for (const s of ['R', 'L']) {
      this.ball(ctx, `upperArm${s}`, 0, 0, 3.2);
      this.segment(ctx, `upperArm${s}`, 1.2, 12.4, 5.0, 4.0, 2);
      this.ball(ctx, `forearm${s}`, 0, 0, 2.6);
      this.segment(ctx, `forearm${s}`, 1.0, 11.6, 4.1, 3.2, 1);
      this.ball(ctx, `hand${s}`, 0, 0, 2.0);
      this.hand(ctx, `hand${s}`);
    }
    this.head(ctx, ch);
    ctx.restore();
  }
}
