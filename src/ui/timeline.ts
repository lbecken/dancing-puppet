// Timeline: overview of the whole show + zoomable detail view with dance
// steps, tune notes, keyframes (with the original sprite as thumbnails) and
// detected audio onsets. Click / drag to seek; in edit mode drag a keyframe
// to retime it.

import type { Choreography } from '../anim/choreography.ts';
import { drawSprite, parseSprite } from '../render/overlay.ts';

type Ctx = CanvasRenderingContext2D;

const ROWS = {
  overview: [0, 22],
  ruler: [24, 40],
  steps: [42, 64],
  notes: [66, 84],
  keys: [86, 132],
  onsets: [134, 150],
} as const;
export const TIMELINE_HEIGHT = 152;

const SPRITE_COLORS = [
  '#c0564b', '#d0884a', '#c9a43c', '#8fa845', '#4e9a6a', '#3f9095', '#4a7fb0', '#6a69b8',
  '#9661b0', '#b85a94', '#a35f5f', '#b08050', '#8a8a40', '#5f8f50', '#3f8070', '#4f7090',
];

export class Timeline {
  readonly canvas: HTMLCanvasElement;
  private ctx: Ctx;
  private sprites: Uint8Array[][];
  /** visible span (s) of the detail view */
  span = 4;
  private viewStart = 0;
  follow = true;
  editMode = false;
  selectedKey = -1;
  onSeek: (t: number) => void = () => {};
  onSelectKey: (i: number) => void = () => {};
  onRetime: (i: number, t: number) => void = () => {};
  private drag: { mode: 'seek' | 'overview' | 'key'; key?: number } | null = null;

  constructor(canvas: HTMLCanvasElement, private choreo: Choreography) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.sprites = choreo.data.sprites.map(parseSprite);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', () => (this.drag = null));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = Math.exp(e.deltaY * 0.0015);
        this.span = Math.min(30, Math.max(0.6, this.span * k));
      },
      { passive: false },
    );
  }

  private get W() {
    return this.canvas.clientWidth;
  }

  private xOf(t: number) {
    return ((t - this.viewStart) / this.span) * this.W;
  }

  private tOf(x: number) {
    return this.viewStart + (x / this.W) * this.span;
  }

  private local(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private down(e: PointerEvent) {
    const [x, y] = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    const D = this.choreo.data.duration;
    if (y < ROWS.overview[1]) {
      this.drag = { mode: 'overview' };
      this.onSeek((x / this.W) * D);
      return;
    }
    if (y >= ROWS.keys[0] && y < ROWS.keys[1]) {
      // nearest keyframe
      const t = this.tOf(x);
      const K = this.choreo.keyframes;
      let best = -1;
      let bd = 1e9;
      for (let i = 0; i < K.length; i++) {
        const d = Math.abs(this.xOf(K[i].t) - x);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (best >= 0 && bd < 8) {
        this.selectedKey = best;
        this.onSelectKey(best);
        if (this.editMode) {
          this.drag = { mode: 'key', key: best };
          return;
        }
        this.onSeek(K[best].t + 0.001);
        return;
      }
      this.onSeek(t);
      this.drag = { mode: 'seek' };
      return;
    }
    this.drag = { mode: 'seek' };
    this.onSeek(this.tOf(x));
  }

  private move(e: PointerEvent) {
    if (!this.drag) return;
    const [x] = this.local(e);
    if (this.drag.mode === 'overview') this.onSeek((Math.max(0, x) / this.W) * this.choreo.data.duration);
    else if (this.drag.mode === 'seek') this.onSeek(this.tOf(x));
    else if (this.drag.mode === 'key' && this.drag.key !== undefined) this.onRetime(this.drag.key, this.tOf(x));
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(TIMELINE_HEIGHT * dpr);
  }

  draw(t: number, playing: boolean) {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = this.W;
    const D = this.choreo.data;
    if (this.follow || !playing) {
      // keep the playhead at 30% of the view while playing; recenter when out of view
      const want = t - this.span * 0.3;
      if (playing || t < this.viewStart || t > this.viewStart + this.span) this.viewStart = want;
    }
    this.viewStart = Math.max(-0.2, Math.min(D.duration - this.span + 0.2, this.viewStart));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, TIMELINE_HEIGHT);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    // ---- overview -------------------------------------------------------
    const ox = (s: number) => (s / D.duration) * W;
    ctx.fillStyle = '#efe6df';
    ctx.fillRect(0, ROWS.overview[0], W, ROWS.overview[1]);
    const ev = D.events;
    const seg = (a: number, b: number, c: string, label: string) => {
      ctx.fillStyle = c;
      ctx.fillRect(ox(a), 2, ox(b) - ox(a), 18);
      ctx.fillStyle = 'rgba(60,40,30,0.75)';
      if (ox(b) - ox(a) > 60) ctx.fillText(label, ox(a) + 4, 11);
    };
    seg(0, ev.danceStart, '#e2cfd6', 'curtain');
    seg(ev.danceStart, ev.musicEnd, '#e8d2b5', 'dance + music');
    seg(ev.musicEnd, ev.curtainFallStart ?? D.duration, '#d7dcc8', 'curtain call (silent)');
    seg(ev.curtainFallStart ?? D.duration, D.duration, '#e2cfd6', 'curtain');
    // visible window
    ctx.strokeStyle = 'rgba(80,60,50,0.6)';
    ctx.strokeRect(ox(this.viewStart), 1.5, ox(this.viewStart + this.span) - ox(this.viewStart), 19);
    ctx.fillStyle = '#b0304a';
    ctx.fillRect(ox(t) - 1, 0, 2, 22);

    // ---- ruler ------------------------------------------------------------
    const t0 = this.viewStart;
    const t1 = this.viewStart + this.span;
    const tick = this.span > 12 ? 1 : this.span > 5 ? 0.5 : this.span > 2 ? 0.25 : 0.1;
    ctx.fillStyle = 'rgba(60,40,30,0.7)';
    ctx.strokeStyle = 'rgba(60,40,30,0.25)';
    for (let s = Math.ceil(t0 / tick) * tick; s <= t1; s += tick) {
      const x = this.xOf(s);
      const major = Math.abs(s / (tick * 4) - Math.round(s / (tick * 4))) < 1e-6;
      ctx.beginPath();
      ctx.moveTo(x, ROWS.ruler[1] - (major ? 10 : 5));
      ctx.lineTo(x, ROWS.ruler[1]);
      ctx.stroke();
      if (major) ctx.fillText(s.toFixed(tick < 0.5 ? 2 : 1), x + 3, ROWS.ruler[0] + 6);
    }

    // ---- steps ------------------------------------------------------------
    const label = (txt: string, x: number, row: readonly [number, number], color: string) => {
      ctx.fillStyle = color;
      ctx.fillText(txt, x + 3, (row[0] + row[1]) / 2);
    };
    const steps = D.steps;
    for (let i = 0; i < steps.length; i++) {
      const a = steps[i].t;
      const b = i + 1 < steps.length ? steps[i + 1].t : ev.musicEnd;
      if (b < t0 || a > t1) continue;
      ctx.fillStyle = i % 2 ? '#e7d3c2' : '#f0e2d6';
      ctx.fillRect(this.xOf(a), ROWS.steps[0], this.xOf(b) - this.xOf(a) - 1, ROWS.steps[1] - ROWS.steps[0]);
      label(steps[i].letter, this.xOf(a), ROWS.steps, '#6b3d2a');
    }
    ctx.fillStyle = 'rgba(60,40,30,0.45)';
    ctx.fillText('step', 2, ROWS.steps[0] - 1 + 0);
    // ---- notes ------------------------------------------------------------
    const notes = D.notes;
    for (let i = 0; i < notes.length; i++) {
      const a = notes[i].t;
      const b = i + 1 < notes.length ? notes[i + 1].t : ev.musicEnd;
      if (b < t0 || a > t1) continue;
      const rest = notes[i].letter === 'Z';
      ctx.fillStyle = rest ? '#f5efea' : i % 2 ? '#d9dfe9' : '#e5e9f0';
      ctx.fillRect(this.xOf(a), ROWS.notes[0], this.xOf(b) - this.xOf(a) - 1, ROWS.notes[1] - ROWS.notes[0]);
      label(rest ? '·' : notes[i].letter, this.xOf(a), ROWS.notes, '#36456b');
    }
    // ---- keyframes --------------------------------------------------------
    const K = D.keyframes;
    const pxPerKey = (K.length / D.duration) * (W / this.span);
    const thumbs = pxPerKey > 9;
    for (let i = 0; i < K.length; i++) {
      const a = K[i].t;
      const b = i + 1 < K.length ? K[i + 1].t : D.duration;
      if (b < t0 || a > t1) continue;
      const pose = D.poses[K[i].pose];
      const x = this.xOf(a);
      const xb = this.xOf(b);
      ctx.fillStyle = SPRITE_COLORS[pose.sprite % SPRITE_COLORS.length] + '33';
      ctx.fillRect(x, ROWS.keys[0], xb - x, ROWS.keys[1] - ROWS.keys[0]);
      ctx.fillStyle = SPRITE_COLORS[pose.sprite % SPRITE_COLORS.length];
      ctx.fillRect(x, ROWS.keys[0], 1.5, ROWS.keys[1] - ROWS.keys[0]);
      if (thumbs && xb - x > 8) {
        const sc = Math.min(0.62, (xb - x - 2) / 28);
        ctx.save();
        ctx.translate(x + 2, ROWS.keys[0] + 3);
        ctx.scale(sc, sc);
        drawSprite(ctx, this.sprites[pose.sprite], 0, 0, '#2f7d3a');
        ctx.restore();
      }
      if (i === this.selectedKey) {
        ctx.strokeStyle = '#00a0e0';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, ROWS.keys[0] + 1, Math.max(3, xb - x), ROWS.keys[1] - ROWS.keys[0] - 2);
        ctx.lineWidth = 1;
      }
    }
    // ---- onsets -------------------------------------------------------------
    ctx.fillStyle = 'rgba(54,69,107,0.8)';
    for (const o of D.audioOnsets.tone) {
      if (o < t0 || o > t1) continue;
      ctx.fillRect(this.xOf(o) - 1, ROWS.onsets[0], 2, 7);
    }
    ctx.fillStyle = 'rgba(176,48,74,0.8)';
    for (const o of D.audioOnsets.tap) {
      if (o < t0 || o > t1) continue;
      ctx.fillRect(this.xOf(o) - 0.75, ROWS.onsets[0] + 8, 1.5, 7);
    }
    // ---- playhead -----------------------------------------------------------
    const px = this.xOf(t);
    ctx.fillStyle = '#b0304a';
    ctx.fillRect(px - 1, ROWS.ruler[0], 2, TIMELINE_HEIGHT - ROWS.ruler[0]);
  }
}
