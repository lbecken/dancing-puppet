// Rig integrity and choreography sampling checks.
// Run: npm test   (node --experimental-strip-types tests/rig.test.ts)

import { readFileSync } from 'node:fs';
import { Choreography } from '../src/anim/choreography.ts';
import { Skeleton } from '../src/rig/skeleton.ts';
import type { ChoreographyData, RigDef, SampledPose } from '../src/types.ts';

const load = <T>(p: string) => JSON.parse(readFileSync(new URL(`../public/data/${p}`, import.meta.url), 'utf8')) as T;
const data = load<ChoreographyData>('choreography.json');
const demonDef = load<RigDef>('rig-demon.json');
const puppetDef = load<RigDef>('rig-marionette.json');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// --- rig definitions ---------------------------------------------------------
const demon = new Skeleton(demonDef);
const puppet = new Skeleton(puppetDef);
const names = (r: RigDef) => r.bones.map((b) => `${b.name}<${b.parent}`).join(',');
check('demon and marionette rigs share topology', names(demonDef) === names(puppetDef));
const required = ['pelvis', 'spine', 'neck', 'head', 'upperArmR', 'forearmR', 'handR', 'upperArmL', 'forearmL', 'handL', 'thighR', 'shinR', 'footR', 'thighL', 'shinL', 'footL'];
check('all required joints present', required.every((b) => puppet.index.has(b)));

// --- data consistency -----------------------------------------------------------
const K = data.keyframes;
check('keyframes strictly increasing', K.every((k, i) => i === 0 || k.t > K[i - 1].t));
check('every keyframe references a pose', K.every((k) => data.poses[k.pose] !== undefined));
check('every pose defines every joint', Object.values(data.poses).every((p) => required.every((b) => typeof p.angles[b] === 'number')));
check('every pose references a sprite', Object.values(data.poses).every((p) => p.sprite >= 0 && p.sprite < data.sprites.length));

// --- sampling over the whole show ---------------------------------------------------
const bones = demonDef.bones.map((b) => b.name);
for (const mode of ['smooth', 'linear', 'snap'] as const) {
  const ch = new Choreography(structuredClone(data), bones);
  ch.setOptions({ mode });
  let maxErr = 0;
  let finite = true;
  let maxJump = 0;
  let prev: SampledPose | null = null;
  const dt = 1 / 1000;
  for (let t = 0; t <= data.duration; t += dt) {
    const p = ch.sample(t);
    demon.solve(p.root, p.angles);
    puppet.solve([p.root[0] * 2.41, 0], p.angles);
    maxErr = Math.max(maxErr, demon.segmentLengthError(), puppet.segmentLengthError());
    for (const v of [...p.root, ...Object.values(p.angles)]) if (!Number.isFinite(v)) finite = false;
    if (prev && mode !== 'snap') {
      for (const b of bones) maxJump = Math.max(maxJump, Math.abs(p.angles[b] - prev.angles[b]));
    }
    prev = { root: [...p.root] as [number, number], angles: { ...p.angles }, channels: { ...p.channels } };
  }
  check(`[${mode}] all sampled values finite`, finite);
  check(`[${mode}] rigid segments keep their length (max error ${maxErr.toExponential(2)})`, maxErr < 1e-9);
  // continuity: the fastest flips of the original last one 60 Hz frame
  // (~15 ms), so ~10°/ms is legitimate; a real discontinuity (e.g. an
  // unwrapping bug) would show up as a jump of tens of degrees within 1 ms.
  if (mode !== 'snap') check(`[${mode}] continuous (peak ${(maxJump * 1000).toFixed(0)}°/s, max change per ms ${maxJump.toFixed(2)}°)`, maxJump < 20);
}

// --- snap mode reproduces the original flip-book exactly ----------------------------
{
  const ch = new Choreography(structuredClone(data), bones);
  ch.setOptions({ mode: 'snap' });
  let exact = true;
  for (let i = 0; i < K.length; i++) {
    const p = ch.sample(K[i].t + 1e-6);
    const q = ch.keyPose(i);
    for (const b of bones) if (Math.abs(((p.angles[b] - q.angles[b] + 540) % 360) - 180) > 1e-6) exact = false;
  }
  check('snap mode shows exactly the keyframe pose at every flip', exact);
}

// --- smooth mode passes through every held pose ---------------------------------------
{
  const ch = new Choreography(structuredClone(data), bones);
  let worst = 0;
  for (let i = 0; i + 1 < K.length; i++) {
    const d = K[i + 1].t - K[i].t;
    if (d < 0.3) continue; // long holds only
    const mid = ch.sample(K[i].t + d / 2);
    const q = ch.keyPose(i);
    for (const b of bones) worst = Math.max(worst, Math.abs(((mid.angles[b] - q.angles[b] + 540) % 360) - 180));
  }
  check(`smooth mode holds long poses exactly (worst ${worst.toExponential(1)}°)`, worst < 1e-6);
}

// --- determinism: pose depends only on time --------------------------------------------
{
  const ch = new Choreography(structuredClone(data), bones);
  const a = JSON.stringify(ch.sample(23.456));
  ch.sample(3.2);
  ch.sample(50.1);
  check('sampling is a pure function of time', JSON.stringify(ch.sample(23.456)) === a);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
