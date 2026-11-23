// Pose inspector (live read-out) and pose / timing editor.
//
// Poses are shared by every keyframe that shows the same original sprite, so
// editing a pose corrects it everywhere it is used, exactly like correcting a
// sprite in the original program. Edits are kept in memory, autosaved to this
// browser (localStorage), and can be exported as a full choreography.json or
// as entries for data/pose_overrides.json (consumed by tools/build_data.py).

import type { Choreography } from '../anim/choreography.ts';
import type { SampledPose } from '../types.ts';

const LS_KEY = 'dancing-puppet.edits.v1';

const BONE_LABEL: Record<string, string> = {
  pelvis: 'pelvis (root rot.)', spine: 'waist', neck: 'neck', head: 'head',
  upperArmR: 'R shoulder', forearmR: 'R elbow', handR: 'R wrist',
  upperArmL: 'L shoulder', forearmL: 'L elbow', handL: 'L wrist',
  thighR: 'R hip', shinR: 'R knee', footR: 'R ankle',
  thighL: 'L hip', shinL: 'L knee', footL: 'L ankle',
};

export interface InspectorInfo {
  t: number;
  videoT: number;
  pose: SampledPose;
  puppetRoot: [number, number];
  clearance: number;
  keyIndex: number;
  rigErrDemon: number;
  rigErrPuppet: number;
  fps: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

export class Inspector {
  private lastUpdate = 0;
  constructor(private root: HTMLElement, private choreo: Choreography) {}

  update(info: InspectorInfo, force = false) {
    const now = performance.now();
    if (!force && now - this.lastUpdate < 120) return;
    this.lastUpdate = now;
    const C = this.choreo;
    const D = C.data;
    const k = D.keyframes[info.keyIndex];
    const next = D.keyframes[info.keyIndex + 1];
    const pose = C.pose(k.pose);
    const si = C.stepIndexAt(info.t);
    const ni = C.noteIndexAt(info.t);
    const step = si >= 0 && info.t < D.events.musicEnd ? `${D.steps[si].letter}  (${si + 1}/${D.steps.length})` : '—';
    const note = ni >= 0 && info.t < D.events.musicEnd ? `${D.notes[ni].letter === 'Z' ? 'rest' : D.notes[ni].letter}  (${ni + 1}/${D.notes.length})` : '—';
    const rows: [string, string][] = [
      ['media time', `${info.t.toFixed(3)} s`],
      ['reference video time', `${info.videoT.toFixed(3)} s`],
      ['dance step', step],
      ['tune note', note],
      ['keyframe', `#${info.keyIndex}  pose ${k.pose}  (sprite ${pose.sprite}, ${k.src})`],
      ['shown by original', `${k.t.toFixed(3)} → ${(next?.t ?? D.duration).toFixed(3)} s  (${(((next?.t ?? D.duration) - k.t) * 1000).toFixed(0)} ms)`],
      ['window offset (sprite px)', `${k.dx}, ${k.dy}`],
      ['root (sprite units)', `${info.pose.root[0].toFixed(2)}, ${info.pose.root[1].toFixed(2)}`],
      ['root (puppet units)', `${info.puppetRoot[0].toFixed(2)}, ${info.puppetRoot[1].toFixed(2)}`],
      ['feet clearance (sprite px)', info.clearance.toFixed(2)],
      ['head yaw / pitch', `${info.pose.channels.headYaw.toFixed(1)}°  /  ${info.pose.channels.headPitch.toFixed(2)}`],
      ['rig integrity (max length error)', `demon ${info.rigErrDemon.toExponential(1)} · puppet ${info.rigErrPuppet.toExponential(1)}`],
      ['render rate', `${info.fps.toFixed(0)} fps`],
    ];
    const table = el('table', { class: 'kv' });
    for (const [a, b] of rows) {
      const tr = el('tr');
      tr.append(el('th', {}, a), el('td', {}, b));
      table.append(tr);
    }
    const jt = el('table', { class: 'joints' });
    const head = el('tr');
    head.append(el('th', {}, 'joint'), el('th', {}, 'now'), el('th', {}, `pose ${k.pose}`));
    jt.append(head);
    for (const b of C.bones) {
      const tr = el('tr');
      tr.append(
        el('td', {}, BONE_LABEL[b] ?? b),
        el('td', {}, `${wrap(info.pose.angles[b]).toFixed(1)}°`),
        el('td', {}, `${(pose.angles[b] ?? 0).toFixed(1)}°`),
      );
      jt.append(tr);
    }
    this.root.replaceChildren(table, el('h4', {}, 'Joint angles (local, ° clockwise)'), jt);
  }
}

const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export class Editor {
  poseId: string | null = null;
  keyIndex = -1;
  private original: Record<string, string> = {};
  onChange: () => void = () => {};
  onSeek: (t: number) => void = () => {};

  constructor(private root: HTMLElement, private choreo: Choreography) {
    for (const [id, p] of Object.entries(choreo.data.poses)) this.original[id] = JSON.stringify(p);
    this.originalKeyT = choreo.data.keyframes.map((k) => k.t);
  }
  private originalKeyT: number[];

  /** Restore edits saved in this browser. Returns number of edited poses. */
  loadLocal(): number {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return 0;
      const saved = JSON.parse(raw) as { poses: Record<string, unknown>; keyT?: Record<string, number> };
      let n = 0;
      for (const [id, p] of Object.entries(saved.poses ?? {})) {
        if (this.choreo.data.poses[id]) {
          this.choreo.data.poses[id] = p as never;
          n++;
        }
      }
      for (const [i, t] of Object.entries(saved.keyT ?? {})) {
        const k = this.choreo.data.keyframes[Number(i)];
        if (k) k.t = t;
      }
      this.choreo.rebuild();
      return n;
    } catch {
      return 0;
    }
  }

  private saveLocal() {
    try {
      const poses: Record<string, unknown> = {};
      for (const [id, p] of Object.entries(this.choreo.data.poses)) {
        if (JSON.stringify(p) !== this.original[id]) poses[id] = p;
      }
      const keyT: Record<string, number> = {};
      this.choreo.data.keyframes.forEach((k, i) => {
        if (k.t !== this.originalKeyT[i]) keyT[i] = k.t;
      });
      localStorage.setItem(LS_KEY, JSON.stringify({ poses, keyT }));
    } catch {
      /* storage unavailable: edits stay in memory */
    }
  }

  editedPoseIds(): string[] {
    return Object.keys(this.choreo.data.poses).filter((id) => JSON.stringify(this.choreo.data.poses[id]) !== this.original[id]);
  }

  /** Select which keyframe / pose the editor works on. */
  select(keyIndex: number) {
    const k = this.choreo.data.keyframes[keyIndex];
    if (!k) return;
    if (keyIndex === this.keyIndex && k.pose === this.poseId) return;
    this.keyIndex = keyIndex;
    this.poseId = k.pose;
    this.render();
  }

  changed() {
    this.saveLocal();
    this.onChange();
  }

  render() {
    const C = this.choreo;
    const id = this.poseId;
    if (!id) {
      this.root.replaceChildren(el('p', { class: 'hint' }, 'Pause and pick a keyframe to edit.'));
      return;
    }
    const p = C.pose(id);
    const uses = C.data.keyframes.filter((k) => k.pose === id).length;
    const kf = C.data.keyframes[this.keyIndex];
    const head = el('div', { class: 'ed-head' });
    head.append(
      el('strong', {}, `Pose ${id}`),
      el('span', {}, ` · sprite ${p.sprite} · used by ${uses} keyframes · ${p.source ?? ''}`),
    );
    const note = p.note ? el('p', { class: 'hint' }, p.note) : el('span');
    const fit = p.fit ? el('p', { class: 'hint' }, `automatic fit: ${p.fit.pixelErrors} px differ from the sprite (of 1680)`) : el('span');

    const grid = el('div', { class: 'sliders' });
    const slider = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void) => {
      const row = el('label', { class: 'slider' });
      const name = el('span', { class: 'name' }, label);
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
      const num = el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(+value.toFixed(3)) }) as HTMLInputElement;
      input.addEventListener('input', () => {
        num.value = input.value;
        set(Number(input.value));
        this.changed();
      });
      num.addEventListener('change', () => {
        input.value = num.value;
        set(Number(num.value));
        this.changed();
      });
      row.append(name, input, num);
      grid.append(row);
    };
    for (const b of C.bones) {
      slider(BONE_LABEL[b] ?? b, wrap(p.angles[b] ?? 0), -180, 180, 0.5, (v) => C.setPoseAngle(id, b, v));
    }
    slider('root x', p.root[0], -20, 20, 0.125, (v) => C.setPoseRoot(id, 0, v));
    slider('root y', p.root[1], -20, 20, 0.125, (v) => C.setPoseRoot(id, 1, v));
    slider('head yaw', p.channels.headYaw, -180, 180, 1, (v) => C.setPoseChannel(id, 'headYaw', v));
    slider('head pitch', p.channels.headPitch, 0, 1, 0.01, (v) => C.setPoseChannel(id, 'headPitch', v));

    const timing = el('div', { class: 'ed-row' });
    const kt = el('span', { class: 'mono' }, kf ? `key #${this.keyIndex} at ${kf.t.toFixed(4)} s` : '');
    const nudge = (d: number, label: string) => {
      const b = el('button', { type: 'button' }, label);
      b.addEventListener('click', () => {
        if (this.keyIndex < 0) return;
        const t = C.moveKeyframe(this.keyIndex, C.data.keyframes[this.keyIndex].t + d);
        kt.textContent = `key #${this.keyIndex} at ${t.toFixed(4)} s`;
        this.changed();
        this.onSeek(t + 0.0005);
      });
      return b;
    };
    timing.append(el('span', {}, 'Timing: '), nudge(-1 / 60, '−1/60 s'), nudge(-0.005, '−5 ms'), nudge(0.005, '+5 ms'), nudge(1 / 60, '+1/60 s'), kt);

    const actions = el('div', { class: 'ed-row' });
    const btn = (label: string, fn: () => void) => {
      const b = el('button', { type: 'button' }, label);
      b.addEventListener('click', fn);
      actions.append(b);
    };
    btn('Revert pose', () => {
      C.data.poses[id] = JSON.parse(this.original[id]);
      C.rebuild();
      this.changed();
      this.render();
    });
    btn('Download choreography.json', () => download('choreography.json', JSON.stringify(C.toJSON())));
    btn('Copy overrides JSON', () => {
      const out: Record<string, unknown> = {};
      for (const pid of this.editedPoseIds()) {
        const q = C.pose(pid);
        out[pid] = { angles: q.angles, root: q.root, channels: q.channels, _why: 'edited in the app' };
      }
      void navigator.clipboard?.writeText(JSON.stringify(out, null, 1));
    });
    const file = el('input', { type: 'file', accept: 'application/json' }) as HTMLInputElement;
    file.style.display = 'none';
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      const data = JSON.parse(await f.text());
      if (data.poses) Object.assign(C.data.poses, data.poses);
      if (Array.isArray(data.keyframes) && data.keyframes.length === C.data.keyframes.length) {
        data.keyframes.forEach((k: { t: number }, i: number) => (C.data.keyframes[i].t = k.t));
      }
      C.rebuild();
      this.changed();
      this.render();
    });
    btn('Import JSON…', () => file.click());
    btn('Discard all edits', () => {
      for (const pid of Object.keys(this.original)) C.data.poses[pid] = JSON.parse(this.original[pid]);
      C.data.keyframes.forEach((k, i) => (k.t = this.originalKeyT[i]));
      C.rebuild();
      try {
        localStorage.removeItem(LS_KEY);
      } catch {
        /* ignore */
      }
      this.onChange();
      this.render();
    });
    actions.append(file);
    const edited = this.editedPoseIds();
    const status = el('p', { class: 'hint' }, edited.length ? `Edited poses: ${edited.join(', ')}` : 'No edits yet. Tip: in edit mode drag the bone ends on the stage.');
    this.root.replaceChildren(head, note, fit, grid, timing, actions, status);
  }
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
