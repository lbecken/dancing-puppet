// Hierarchical 2D skeleton with forward kinematics.
//
// Each bone is a rigid frame: world = parent.world * T(offset) * R(angle).
// Bones never scale, so the distance between a joint and its tail is
// constant by construction; `segmentLengthError` verifies that at runtime.

import type { BoneDef, RigDef, Vec2 } from '../types.ts';

export interface BoneWorld {
  /** joint (pivot) position */
  x: number;
  y: number;
  /** world rotation in radians (clockwise on screen, y down) */
  angle: number;
  cos: number;
  sin: number;
}

export class Skeleton {
  readonly def: RigDef;
  readonly bones: BoneDef[];
  readonly index: Map<string, number>;
  readonly parentIndex: number[];
  /** rest length of every bone (|tail|) */
  readonly restLength: number[];
  readonly world: BoneWorld[];

  constructor(def: RigDef) {
    this.def = def;
    this.bones = def.bones;
    this.index = new Map(def.bones.map((b, i) => [b.name, i]));
    this.parentIndex = def.bones.map((b) => {
      if (b.parent === null) return -1;
      const p = this.index.get(b.parent);
      if (p === undefined) throw new Error(`bone ${b.name}: unknown parent ${b.parent}`);
      return p;
    });
    this.parentIndex.forEach((p, i) => {
      if (p >= i) throw new Error(`bones must be listed parent-first (${def.bones[i].name})`);
    });
    this.restLength = def.bones.map((b) => Math.hypot(b.tail[0], b.tail[1]));
    this.world = def.bones.map(() => ({ x: 0, y: 0, angle: 0, cos: 1, sin: 0 }));
  }

  /** Forward kinematics. `root` is the offset of the root bone from rest_root. */
  solve(root: Vec2, angles: Record<string, number>): BoneWorld[] {
    const DEG = Math.PI / 180;
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      const w = this.world[i];
      const local = (angles[b.name] ?? 0) * DEG;
      const p = this.parentIndex[i];
      if (p < 0) {
        w.x = this.def.rest_root[0] + root[0] + b.offset[0];
        w.y = this.def.rest_root[1] + root[1] + b.offset[1];
        w.angle = local;
      } else {
        const pw = this.world[p];
        w.x = pw.x + pw.cos * b.offset[0] - pw.sin * b.offset[1];
        w.y = pw.y + pw.sin * b.offset[0] + pw.cos * b.offset[1];
        w.angle = pw.angle + local;
      }
      w.cos = Math.cos(w.angle);
      w.sin = Math.sin(w.angle);
    }
    return this.world;
  }

  /** Transform a point given in a bone's local (rest) frame to world space. */
  toWorld(bone: string | number, p: Vec2): Vec2 {
    const i = typeof bone === 'number' ? bone : this.index.get(bone)!;
    const w = this.world[i];
    return [w.x + w.cos * p[0] - w.sin * p[1], w.y + w.sin * p[0] + w.cos * p[1]];
  }

  tailWorld(i: number): Vec2 {
    return this.toWorld(i, this.bones[i].tail);
  }

  /** Lowest (largest y) contact point of the feet in world space. */
  lowestContact(): number {
    let maxY = -Infinity;
    for (const [bone, pts] of Object.entries(this.def.contact ?? {})) {
      for (const p of pts) maxY = Math.max(maxY, this.toWorld(bone, p)[1]);
    }
    return maxY;
  }

  /**
   * Rig-integrity check: max |distance(joint, child joint) - rest distance|
   * over all parent/child pairs, plus tail lengths. Should be ~1e-12.
   */
  segmentLengthError(): number {
    let err = 0;
    for (let i = 0; i < this.bones.length; i++) {
      const w = this.world[i];
      const t = this.tailWorld(i);
      err = Math.max(err, Math.abs(Math.hypot(t[0] - w.x, t[1] - w.y) - this.restLength[i]));
      const p = this.parentIndex[i];
      if (p >= 0) {
        const pw = this.world[p];
        const off = this.bones[i].offset;
        err = Math.max(err, Math.abs(Math.hypot(w.x - pw.x, w.y - pw.y) - Math.hypot(off[0], off[1])));
      }
    }
    return err;
  }
}

export async function loadRig(url: string): Promise<RigDef> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to load ${url}`);
  return (await r.json()) as RigDef;
}
