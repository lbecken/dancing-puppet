// Reference panel: the original recording, slaved to the master clock, and a
// "ghost" canvas with the recovered original sprite at the same instant plus
// the fitted skeleton (demon proportions) driven by the same pose stream as
// the marionette.

import type { Choreography } from '../anim/choreography.ts';
import { drawSkeleton, drawSprite, parseSprite } from '../render/overlay.ts';
import type { Skeleton } from '../rig/skeleton.ts';

const GREEN = '#33ff66';
// original stage region shown in the ghost canvas (in sprite units: x = orig px,
// y = 2 * orig px). Sprite window rests at x = 48, y = 12 * 2.
const STAGE_X0 = 0;
const STAGE_W = 128;
const STAGE_Y0 = 12; // orig row 6
const STAGE_H = 72; // orig rows 6..41
const SPRITE_X = 48;
const SPRITE_Y = 24;

export class ReferencePanel {
  readonly video: HTMLVideoElement;
  private ghost: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private sprites: Uint8Array[][];
  /** offset (s) added to media time when positioning the video */
  offset = 0;
  showSkeleton = true;
  showSprite = true;
  private lastSeek = -1;

  constructor(video: HTMLVideoElement, ghost: HTMLCanvasElement, private choreo: Choreography) {
    this.video = video;
    this.ghost = ghost;
    this.gctx = ghost.getContext('2d')!;
    this.sprites = choreo.data.sprites.map(parseSprite);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
  }

  /** Keep the video on the master clock. */
  sync(t: number, playing: boolean, rate: number) {
    const v = this.video;
    if (v.readyState < 1) return;
    const target = Math.min(Math.max(0, t + this.offset), (v.duration || 1e9) - 0.001);
    if (playing) {
      if (v.paused) void v.play().catch(() => {});
      const drift = v.currentTime - target;
      if (Math.abs(drift) > 0.25) {
        // large jump (seek / stall): hard resync
        v.currentTime = target;
        v.playbackRate = rate;
      } else {
        // small drift: nudge the rate (seeking every frame would stutter)
        const corr = Math.abs(drift) < 0.012 ? 0 : Math.max(-0.08, Math.min(0.08, -drift * 0.8));
        const want = rate * (1 + corr);
        if (Math.abs(v.playbackRate - want) > 1e-3) v.playbackRate = want;
      }
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(target - this.lastSeek) > 1e-4 && Math.abs(v.currentTime - target) > 0.004) {
        v.currentTime = target;
        this.lastSeek = target;
      }
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.ghost.width = Math.round(this.ghost.clientWidth * dpr);
    this.ghost.height = Math.round(this.ghost.clientHeight * dpr);
  }

  /** Draw the ghost: original sprite (exact, flip-book) + fitted skeleton (sampled). */
  drawGhost(t: number, demon: Skeleton) {
    const c = this.gctx;
    const W = this.ghost.width;
    const H = this.ghost.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#0b120c';
    c.fillRect(0, 0, W, H);
    const s = Math.min(W / STAGE_W, H / STAGE_H);
    const ox = (W - STAGE_W * s) / 2 - STAGE_X0 * s;
    const oy = (H - STAGE_H * s) / 2 - STAGE_Y0 * s;
    const k = this.choreo.keyframes[this.choreo.keyframeIndexAt(t)];
    const pose = this.choreo.pose(k.pose);
    c.setTransform(s, 0, 0, s, ox, oy);
    // stage floor line like the original border
    c.fillStyle = 'rgba(51,255,102,0.25)';
    c.fillRect(0, STAGE_Y0 + STAGE_H - 0.5, STAGE_W, 0.5);
    if (this.showSprite) drawSprite(c, this.sprites[pose.sprite], SPRITE_X + k.dx, SPRITE_Y + k.dy, GREEN);
    if (this.showSkeleton) {
      // demon rig coordinates: rest root (14, 40.5) inside the sprite box
      const cam = new DOMMatrix([s, 0, 0, s, ox + SPRITE_X * s, oy + SPRITE_Y * s]);
      drawSkeleton(c, cam, demon, {
        bone: 'rgba(255, 70, 170, 0.95)',
        joint: 'rgba(255, 220, 0, 0.95)',
        hierarchy: 'rgba(80, 170, 255, 0.0)',
        lineWidth: Math.max(1.5, s * 0.35),
        jointRadius: Math.max(2, s * 0.45),
        labels: false,
      });
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.font = `${Math.round(11 * (window.devicePixelRatio || 1))}px ui-monospace, monospace`;
    c.fillStyle = 'rgba(51,255,102,0.8)';
    c.fillText(`sprite ${pose.sprite}  key ${this.choreo.keyframeIndexAt(t)}`, 8, H - 8);
  }
}
