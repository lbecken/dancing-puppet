// Application entry: loads the data, wires the master clock, renderers and
// comparison / editing tools, and runs the render loop. Every frame derives
// the pose from the clock's time (never from accumulated frame deltas).

import './style.css';
import { Choreography, type InterpMode } from './anim/choreography.ts';
import { MasterClock } from './audio/clock.ts';
import { drawSkeleton, drawSprite, parseSprite } from './render/overlay.ts';
import { PuppetRenderer } from './render/puppet.ts';
import {
  type BarState,
  cameraMatrix,
  drawBackground,
  drawCurtain,
  drawShadow,
  lookupLinear,
  makeCamera,
  Strings,
} from './render/stage.ts';
import { Skeleton } from './rig/skeleton.ts';
import type { ChoreographyData, RigDef, SampledPose, Vec2 } from './types.ts';
import { Editor, Inspector } from './ui/inspector.ts';
import { ReferencePanel } from './ui/reference.ts';
import { Timeline } from './ui/timeline.ts';

/** feet within this many sprite px of the floor count as touching it */
const CONTACT_DEADBAND = 1.2;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function main() {
  const [data, demonDef, puppetDef] = await Promise.all([
    getJSON<ChoreographyData>('data/choreography.json'),
    getJSON<RigDef>('data/rig-demon.json'),
    getJSON<RigDef>('data/rig-marionette.json'),
  ]);
  const demon = new Skeleton(demonDef);
  const puppet = new Skeleton(puppetDef);
  const choreo = new Choreography(data, demonDef.bones.map((b) => b.name));
  // motion scale demon -> puppet: ratio of hip heights (leg lengths)
  const S = (puppetDef.ground_y - puppetDef.rest_root[1]) / (demonDef.ground_y - demonDef.rest_root[1]);

  const clock = new MasterClock(data.duration);
  const renderer = new PuppetRenderer(puppet);
  const strings = new Strings(puppetDef.strings ?? []);
  const BAR_Y = -80; // control bar height in puppet units
  puppet.solve([0, 0], {});
  strings.calibrate(puppet, { x: 0, y: BAR_Y, tilt: 0 });

  // ---- DOM ------------------------------------------------------------------
  const stage = $<HTMLCanvasElement>('stage');
  const sctx = stage.getContext('2d')!;
  const timeline = new Timeline($<HTMLCanvasElement>('timeline'), choreo);
  const ref = new ReferencePanel($<HTMLVideoElement>('refVideo'), $<HTMLCanvasElement>('ghost'), choreo);
  const inspector = new Inspector($('inspector'), choreo);
  const editor = new Editor($('editor'), choreo);
  const restored = editor.loadLocal();

  const view = {
    skeleton: false,
    labels: false,
    strings: true,
    ghost: false,
    curtain: true,
    edit: false,
  };

  // ---- audio ----------------------------------------------------------------
  const loading = $('loading');
  loading.textContent = 'Loading music…';
  clock
    .load(data.media.audio)
    .then(() => (loading.textContent = restored ? `Ready · ${restored} locally edited pose(s) restored` : 'Ready'))
    .catch((e) => (loading.textContent = `Audio unavailable (${e.message}); playing silently`))
    .finally(() => setTimeout(() => loading.classList.add('hidden'), 1800));

  // ---- controls ---------------------------------------------------------------
  const btnPlay = $<HTMLButtonElement>('btnPlay');
  const setPlayLabel = () => (btnPlay.textContent = clock.playing ? 'Pause' : 'Play');
  const togglePlay = async () => {
    if (clock.playing) clock.pause();
    else await clock.play();
    setPlayLabel();
  };
  clock.onEnded = setPlayLabel;
  const seek = (t: number) => {
    clock.seek(t);
    if (!view.edit) editor.keyIndex = -1;
  };
  const stepBy = (dt: number) => {
    if (clock.playing) clock.pause();
    seek(clock.time + dt);
    setPlayLabel();
  };
  const toKey = (dir: 1 | -1) => {
    if (clock.playing) clock.pause();
    const i = choreo.keyframeIndexAt(clock.time + 1e-4) + dir;
    const k = choreo.keyframes[Math.max(0, Math.min(choreo.keyframes.length - 1, i))];
    seek(k.t + 0.0005);
    setPlayLabel();
  };
  btnPlay.addEventListener('click', togglePlay);
  $('btnRestart').addEventListener('click', () => {
    seek(0);
    setPlayLabel();
  });
  $('btnDance').addEventListener('click', () => seek(data.events.danceStart - 0.6));
  $('btnPrevKey').addEventListener('click', () => toKey(-1));
  $('btnNextKey').addEventListener('click', () => toKey(1));
  $('btnBackF').addEventListener('click', () => stepBy(-1 / 60));
  $('btnFwdF').addEventListener('click', () => stepBy(1 / 60));
  $<HTMLSelectElement>('rate').addEventListener('change', (e) => clock.setRate(Number((e.target as HTMLSelectElement).value)));
  $<HTMLInputElement>('volume').addEventListener('input', (e) => (clock.volume = Number((e.target as HTMLInputElement).value)));

  const bindCheck = (id: string, key: keyof typeof view, after?: () => void) => {
    const c = $<HTMLInputElement>(id);
    c.checked = view[key];
    c.addEventListener('change', () => {
      view[key] = c.checked;
      after?.();
    });
  };
  bindCheck('optSkeleton', 'skeleton');
  bindCheck('optLabels', 'labels');
  bindCheck('optStrings', 'strings');
  bindCheck('optGhost', 'ghost');
  bindCheck('optCurtain', 'curtain');
  bindCheck('optEdit', 'edit', () => {
    timeline.editMode = view.edit;
    document.body.classList.toggle('editing', view.edit);
    if (view.edit) {
      if (clock.playing) clock.pause();
      setPlayLabel();
      editor.select(choreo.keyframeIndexAt(clock.time + 1e-4));
    }
  });
  const optRefSkel = $<HTMLInputElement>('optRefSkeleton');
  optRefSkel.addEventListener('change', () => (ref.showSkeleton = optRefSkel.checked));
  const optRefSprite = $<HTMLInputElement>('optRefSprite');
  optRefSprite.addEventListener('change', () => (ref.showSprite = optRefSprite.checked));

  const interpMode = $<HTMLSelectElement>('interpMode');
  interpMode.value = choreo.opts.mode;
  interpMode.addEventListener('change', () => choreo.setOptions({ mode: interpMode.value as InterpMode }));
  const bindRange = (id: string, out: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
    const r = $<HTMLInputElement>(id);
    const o = $(out);
    r.value = String(get());
    o.textContent = fmt(get());
    r.addEventListener('input', () => {
      set(Number(r.value));
      o.textContent = fmt(Number(r.value));
    });
  };
  bindRange('phase', 'phaseOut', () => choreo.opts.phase, (v) => choreo.setOptions({ phase: v }), (v) => v.toFixed(2));
  bindRange('maxTrans', 'maxTransOut', () => choreo.opts.maxTransition * 1000, (v) => choreo.setOptions({ maxTransition: v / 1000 }), (v) => `${v.toFixed(0)} ms`);
  bindRange('avOffset', 'avOffsetOut', () => clock.avOffset * 1000, (v) => (clock.avOffset = v / 1000), (v) => `${v.toFixed(0)} ms`);
  bindRange('refOffset', 'refOffsetOut', () => ref.offset * 1000, (v) => (ref.offset = v / 1000), (v) => `${v.toFixed(0)} ms`);
  const latency = $<HTMLInputElement>('optLatency');
  latency.checked = clock.latencyCompensation;
  latency.addEventListener('change', () => (clock.latencyCompensation = latency.checked));

  timeline.onSeek = (t) => seek(t);
  timeline.onSelectKey = (i) => {
    editor.select(i);
    if (view.edit) seek(choreo.keyframes[i].t + 0.0005);
  };
  timeline.onRetime = (i, t) => {
    const nt = choreo.moveKeyframe(i, t);
    editor.changed();
    seek(nt + 0.0005);
  };
  editor.onSeek = (t) => seek(t);
  editor.onChange = () => editor.render();

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      void togglePlay();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      if (e.shiftKey) toKey(-1);
      else stepBy(-1 / 60);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      if (e.shiftKey) toKey(1);
      else stepBy(1 / 60);
    } else if (e.key === ',') stepBy(-1 / data.media.videoFps);
    else if (e.key === '.') stepBy(1 / data.media.videoFps);
    else if (e.code === 'Home') seek(0);
    else if (e.key === 's') $<HTMLInputElement>('optSkeleton').click();
    else if (e.key === 'g') $<HTMLInputElement>('optGhost').click();
    else if (e.key === 'e') $<HTMLInputElement>('optEdit').click();
  });

  // ---- direct manipulation on the stage (edit mode) ---------------------------
  let camera = makeCamera(1, 1, puppetDef.height, puppetDef.ground_y);
  let camM = cameraMatrix(camera);
  let dragBone = -1;
  const pointer = (e: PointerEvent): Vec2 => {
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
  };
  const scr = (p: Vec2): Vec2 => {
    const q = camM.transformPoint(new DOMPoint(p[0], p[1]));
    return [q.x, q.y];
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!view.edit || editor.keyIndex < 0) return;
    const p = pointer(e);
    let best = -1;
    let bd = 18 * (window.devicePixelRatio || 1);
    puppet.bones.forEach((_, i) => {
      if (i === 0) return;
      const tail = scr(puppet.tailWorld(i));
      const d = Math.hypot(tail[0] - p[0], tail[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best >= 0) {
      dragBone = best;
      stage.setPointerCapture(e.pointerId);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (dragBone < 0 || !editor.poseId) return;
    const p = pointer(e);
    const w = puppet.world[dragBone];
    const j = scr([w.x, w.y]);
    const tail = scr(puppet.tailWorld(dragBone));
    const delta = Math.atan2(p[1] - j[1], p[0] - j[0]) - Math.atan2(tail[1] - j[1], tail[0] - j[0]);
    const name = puppet.bones[dragBone].name;
    const cur = choreo.pose(editor.poseId).angles[name] ?? 0;
    let d = (delta * 180) / Math.PI;
    d = ((((d + 180) % 360) + 360) % 360) - 180;
    choreo.setPoseAngle(editor.poseId, name, cur + d);
    editor.changed();
  });
  stage.addEventListener('pointerup', () => (dragBone = -1));

  // ---- layout -------------------------------------------------------------------
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    stage.width = Math.round(stage.clientWidth * dpr);
    stage.height = Math.round(stage.clientHeight * dpr);
    camera = makeCamera(stage.width, stage.height, puppetDef.height, puppetDef.ground_y);
    camM = cameraMatrix(camera);
    timeline.resize();
    ref.resize();
  };
  new ResizeObserver(resize).observe(document.body);
  resize();

  // ---- evaluation -----------------------------------------------------------------
  const sampled: SampledPose = { root: [0, 0], angles: {}, channels: { headYaw: 0, headPitch: 0 } };
  const tmp: SampledPose = { root: [0, 0], angles: {}, channels: { headYaw: 0, headPitch: 0 } };
  const sprites = data.sprites.map(parseSprite);

  /** Pose the puppet for pose `p`; returns [rootX, rootY] in puppet units and clearance. */
  const placePuppet = (p: SampledPose): { root: Vec2; clearance: number } => {
    demon.solve(p.root, p.angles);
    const clearance = Math.max(0, demonDef.ground_y - demon.lowestContact() - CONTACT_DEADBAND);
    const rx = p.root[0] * S;
    puppet.solve([rx, 0], p.angles);
    const ry = puppetDef.ground_y - puppet.lowestContact() - clearance * S;
    puppet.solve([rx, ry], p.angles);
    return { root: [rx, ry], clearance };
  };

  let lastFrame = performance.now();
  let fps = 60;

  const frame = () => {
    const now = performance.now();
    fps = fps * 0.9 + (1000 / Math.max(1, now - lastFrame)) * 0.1;
    lastFrame = now;
    clock.tick();
    const t = clock.time;
    const editing = view.edit && !clock.playing && editor.keyIndex >= 0;
    if (!editing && view.edit && !clock.playing) editor.select(choreo.keyframeIndexAt(t + 1e-4));
    const pose = editing ? choreo.keyPose(editor.keyIndex, sampled) : choreo.sample(t, sampled);

    // control bar follows the puppet with a little lag (deterministic in t)
    let barX = 0;
    for (let k = 0; k < 6; k++) barX += choreo.sample(t - k * 0.06, tmp).root[0] * S;
    barX /= 6;

    const placed = placePuppet(pose);
    const pelvisAngle = (pose.angles.pelvis ?? 0) + (pose.angles.spine ?? 0) * 0.6;
    const bar: BarState = {
      x: barX,
      y: BAR_Y + placed.root[1] * 0.35,
      tilt: (pelvisAngle * Math.PI) / 180 * 0.35 + (placed.root[0] - barX) * 0.004,
    };

    // ---- draw stage ----------------------------------------------------------------
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    drawBackground(sctx, camera, camera.originX + camera.scale * placed.root[0]);
    drawShadow(sctx, camera, placed.root[0], placed.clearance * S);
    if (view.ghost) {
      const k = choreo.keyframes[choreo.keyframeIndexAt(t)];
      const sp = choreo.pose(k.pose).sprite;
      const u = puppetDef.height / 60;
      // one sprite px = u puppet units, sprite bottom on the floor
      sctx.save();
      sctx.setTransform(camM);
      sctx.translate(k.dx * S - 14 * u, puppetDef.ground_y - 60 * u + k.dy * u);
      sctx.scale(u, u);
      sctx.globalAlpha = 0.3;
      drawSprite(sctx, sprites[sp], 0, 0, '#2faa55');
      sctx.restore();
    }
    if (view.strings) strings.draw(sctx, camM, puppet, bar, camera.scale);
    renderer.draw(sctx, camM, pose.channels);
    if (view.curtain) drawCurtain(sctx, camera, lookupLinear(data.curtain, t), t);
    if (view.skeleton || view.edit) {
      drawSkeleton(sctx, camM, puppet, {
        bone: 'rgba(214, 40, 120, 0.85)',
        joint: 'rgba(255, 196, 0, 0.95)',
        hierarchy: 'rgba(40, 120, 220, 0.55)',
        lineWidth: 2 * (window.devicePixelRatio || 1),
        jointRadius: 3.5 * (window.devicePixelRatio || 1),
        labels: view.labels,
        highlight: dragBone >= 0 ? puppet.bones[dragBone].name : null,
      });
    }

    // ---- comparison panels -----------------------------------------------------------
    ref.sync(t, clock.playing, clock.rate);
    ref.drawGhost(t, demon);
    timeline.selectedKey = view.edit ? editor.keyIndex : -1;
    timeline.draw(t, clock.playing);
    const ki = choreo.keyframeIndexAt(t);
    $('timeReadout').textContent = `${t.toFixed(3)} s`;
    inspector.update({
      t,
      videoT: t + data.mediaStart + ref.offset,
      pose,
      puppetRoot: placed.root,
      clearance: placed.clearance,
      keyIndex: editing ? editor.keyIndex : ki,
      rigErrDemon: demon.segmentLengthError(),
      rigErrPuppet: puppet.segmentLengthError(),
      fps,
    });
    requestAnimationFrame(frame);
  };
  setPlayLabel();
  editor.render();
  requestAnimationFrame(frame);

  // expose for debugging / automated checks
  (window as unknown as Record<string, unknown>).dancingPuppet = { clock, choreo, puppet, demon, view, seek };
}

main().catch((e) => {
  const l = document.getElementById('loading');
  if (l) {
    l.textContent = `Failed to start: ${e instanceof Error ? e.message : String(e)}`;
    l.classList.add('error');
  }
  console.error(e);
});
