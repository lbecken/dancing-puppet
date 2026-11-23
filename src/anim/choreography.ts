// Data-driven choreography: keyframes (pose ids on the reference timeline)
// -> per-channel animation tracks -> pose at any time t.
//
// The original is a flip-book: pose i is displayed from t_i until t_{i+1}.
// To move smoothly without losing that timing we place a transition window
// around every flip (centred by `phase`, at most `maxTransition` long, never
// longer than the neighbouring display intervals). Inside long display
// intervals the pose is held; in fast passages consecutive windows touch and
// the motion flows through every pose. Values between keys are interpolated
// with a monotone cubic (PCHIP), which never overshoots a pose and eases at
// direction reversals. 'snap' reproduces the original flip-book exactly.

import type { ChoreographyData, Keyframe, PoseDef, SampledPose, TimedLetter } from '../types.ts';

export type InterpMode = 'snap' | 'linear' | 'smooth';

export interface InterpOptions {
  mode: InterpMode;
  /** 0 = pose reached exactly at the flip, 1 = transition starts at the flip */
  phase: number;
  /** maximum transition duration (s) */
  maxTransition: number;
}

export const DEFAULT_INTERP: InterpOptions = { mode: 'smooth', phase: 0.35, maxTransition: 0.11 };

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

function upperBound(arr: ArrayLike<number>, t: number): number {
  // index of first element > t
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Choreography {
  data: ChoreographyData;
  readonly bones: string[];
  readonly channels: string[];
  opts: InterpOptions = { ...DEFAULT_INTERP };

  private keyT = new Float64Array(0);
  /** per keyframe channel values (angles unwrapped along the sequence) */
  private keyV: Float64Array[] = [];
  private sT = new Float64Array(0);
  private sV: Float64Array[] = [];
  private sM: Float64Array[] = [];
  private stepT = new Float64Array(0);
  private noteT = new Float64Array(0);
  version = 0;

  constructor(data: ChoreographyData, boneNames: string[]) {
    this.data = data;
    this.bones = boneNames;
    this.channels = ['rootX', 'rootY', ...boneNames, 'headYaw', 'headPitch'];
    this.rebuild();
  }

  get keyframes(): Keyframe[] {
    return this.data.keyframes;
  }

  pose(id: string): PoseDef {
    return this.data.poses[id];
  }

  setOptions(o: Partial<InterpOptions>) {
    this.opts = { ...this.opts, ...o };
    this.rebuild();
  }

  /** Recompute tracks; call after any edit of poses or keyframe timing. */
  rebuild() {
    const K = this.data.keyframes;
    const C = this.channels.length;
    this.keyT = Float64Array.from(K.map((k) => k.t));
    this.keyV = K.map(() => new Float64Array(C));
    for (let i = 0; i < K.length; i++) {
      const k = K[i];
      const p = this.data.poses[k.pose];
      const v = this.keyV[i];
      v[0] = p.root[0] + k.dx;
      v[1] = p.root[1] + k.dy;
      this.bones.forEach((b, j) => (v[2 + j] = p.angles[b] ?? 0));
      v[C - 2] = p.channels?.headYaw ?? 0;
      v[C - 1] = p.channels?.headPitch ?? 0;
      if (i > 0) {
        // unwrap angles (bones + yaw) so we always take the short way round
        const pv = this.keyV[i - 1];
        for (let c = 2; c < C - 1; c++) v[c] = pv[c] + wrap180(v[c] - pv[c]);
      }
    }
    this.buildSamples();
    this.stepT = Float64Array.from(this.data.steps.map((s) => s.t));
    this.noteT = Float64Array.from(this.data.notes.map((s) => s.t));
    this.version++;
  }

  private buildSamples() {
    const { phase, maxTransition } = this.opts;
    const n = this.keyT.length;
    const T = this.keyT;
    const times: number[] = [];
    const vals: Float64Array[] = [];
    const dur = (i: number) => (i < n - 1 ? T[i + 1] - T[i] : 1.0);
    const win = (i: number) => (i <= 0 ? 0 : Math.min(maxTransition, dur(i - 1), dur(i)));
    for (let i = 0; i < n; i++) {
      const s = T[i] + phase * win(i);
      const e = i < n - 1 ? T[i + 1] - (1 - phase) * win(i + 1) : T[i] + 1;
      if (e - s > 1e-4) {
        times.push(s, e);
        vals.push(this.keyV[i], this.keyV[i]);
      } else {
        times.push((s + e) / 2);
        vals.push(this.keyV[i]);
      }
    }
    const m = times.length;
    const C = this.channels.length;
    this.sT = Float64Array.from(times);
    this.sV = [];
    this.sM = [];
    for (let c = 0; c < C; c++) {
      const y = new Float64Array(m);
      for (let k = 0; k < m; k++) y[k] = vals[k][c];
      this.sV.push(y);
      this.sM.push(pchipSlopes(this.sT, y));
    }
  }

  /** Index of the keyframe displayed by the original at time t. */
  keyframeIndexAt(t: number): number {
    return Math.max(0, upperBound(this.keyT, t) - 1);
  }

  stepIndexAt(t: number): number {
    return upperBound(this.stepT, t) - 1;
  }

  noteIndexAt(t: number): number {
    return upperBound(this.noteT, t) - 1;
  }

  letterAt(list: TimedLetter[], idx: number): TimedLetter | null {
    return idx >= 0 && idx < list.length ? list[idx] : null;
  }

  sample(t: number, out?: SampledPose): SampledPose {
    const C = this.channels.length;
    const res: SampledPose = out ?? { root: [0, 0], angles: {}, channels: { headYaw: 0, headPitch: 0 } };
    const vals = new Float64Array(C);
    if (this.opts.mode === 'snap') {
      const v = this.keyV[this.keyframeIndexAt(t)];
      vals.set(v);
    } else {
      const T = this.sT;
      const j = upperBound(T, t) - 1;
      if (j < 0) {
        for (let c = 0; c < C; c++) vals[c] = this.sV[c][0];
      } else if (j >= T.length - 1) {
        for (let c = 0; c < C; c++) vals[c] = this.sV[c][T.length - 1];
      } else {
        const h = T[j + 1] - T[j];
        const s = h > 0 ? (t - T[j]) / h : 0;
        if (this.opts.mode === 'linear') {
          for (let c = 0; c < C; c++) vals[c] = this.sV[c][j] + (this.sV[c][j + 1] - this.sV[c][j]) * s;
        } else {
          const s2 = s * s;
          const s3 = s2 * s;
          const h00 = 2 * s3 - 3 * s2 + 1;
          const h10 = s3 - 2 * s2 + s;
          const h01 = -2 * s3 + 3 * s2;
          const h11 = s3 - s2;
          for (let c = 0; c < C; c++) {
            const y = this.sV[c];
            const m = this.sM[c];
            vals[c] = h00 * y[j] + h10 * h * m[j] + h01 * y[j + 1] + h11 * h * m[j + 1];
          }
        }
      }
    }
    res.root[0] = vals[0];
    res.root[1] = vals[1];
    this.bones.forEach((b, j) => (res.angles[b] = vals[2 + j]));
    res.channels.headYaw = vals[C - 2];
    res.channels.headPitch = vals[C - 1];
    return res;
  }

  /** The exact pose of keyframe i (what the original shows), no interpolation. */
  keyPose(i: number, out?: SampledPose): SampledPose {
    const k = this.data.keyframes[i];
    const p = this.data.poses[k.pose];
    const res: SampledPose = out ?? { root: [0, 0], angles: {}, channels: { headYaw: 0, headPitch: 0 } };
    res.root[0] = p.root[0] + k.dx;
    res.root[1] = p.root[1] + k.dy;
    for (const b of this.bones) res.angles[b] = p.angles[b] ?? 0;
    res.channels.headYaw = p.channels?.headYaw ?? 0;
    res.channels.headPitch = p.channels?.headPitch ?? 0;
    return res;
  }

  // ---- editing ------------------------------------------------------------

  setPoseAngle(id: string, bone: string, deg: number) {
    this.data.poses[id].angles[bone] = Math.round(wrap180(deg) * 100) / 100;
    this.data.poses[id].source = 'edited';
    this.rebuild();
  }

  setPoseRoot(id: string, axis: 0 | 1, v: number) {
    this.data.poses[id].root[axis] = Math.round(v * 1000) / 1000;
    this.data.poses[id].source = 'edited';
    this.rebuild();
  }

  setPoseChannel(id: string, ch: 'headYaw' | 'headPitch', v: number) {
    this.data.poses[id].channels[ch] = v;
    this.data.poses[id].source = 'edited';
    this.rebuild();
  }

  /** Retime one keyframe, keeping order. Returns the new time. */
  moveKeyframe(i: number, t: number): number {
    const K = this.data.keyframes;
    const lo = i > 0 ? K[i - 1].t + 0.004 : 0;
    const hi = i < K.length - 1 ? K[i + 1].t - 0.004 : this.data.duration;
    K[i].t = Math.round(Math.min(hi, Math.max(lo, t)) * 10000) / 10000;
    this.rebuild();
    return K[i].t;
  }

  toJSON(): ChoreographyData {
    return this.data;
  }
}

/** Monotone piecewise-cubic Hermite slopes (Fritsch-Butland / PCHIP). */
export function pchipSlopes(x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const n = x.length;
  const m = new Float64Array(n);
  if (n < 2) return m;
  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    h[k] = x[k + 1] - x[k];
    d[k] = h[k] > 0 ? (y[k + 1] - y[k]) / h[k] : 0;
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] === 0 || d[k] === 0 || Math.sign(d[k - 1]) !== Math.sign(d[k])) {
      m[k] = 0;
    } else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  // end slopes: one-sided, limited to keep monotone
  for (const k of [0, n - 1]) {
    const dk = k === 0 ? d[0] : d[n - 2];
    if (Math.sign(m[k]) !== Math.sign(dk)) m[k] = 0;
  }
  return m;
}
