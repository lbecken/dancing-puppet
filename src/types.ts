// Shared data types. Everything here mirrors the JSON files in public/data so
// that the same data can drive another renderer (e.g. a Rust/WASM one).

export type Vec2 = [number, number];

export interface BoneDef {
  name: string;
  parent: string | null;
  /** joint position in the parent's rest frame */
  offset: Vec2;
  /** bone vector in its own rest frame (joint -> tail) */
  tail: Vec2;
}

export interface StringDef {
  bone: string;
  point: Vec2;
  anchor: 'center' | 'barLeft' | 'barRight' | 'crossFront' | 'crossBack';
}

export interface RigDef {
  name: string;
  units: string;
  rest_root: Vec2;
  ground_y: number;
  height: number;
  bones: BoneDef[];
  /** sole points per foot bone (local), used for ground contact */
  contact: Record<string, Vec2[]>;
  strings?: StringDef[];
}

/** Non-skeletal pose channels (cannot be expressed as joint rotations). */
export interface PoseChannels {
  /** degrees; 0 = facing the audience, -90 = profile towards screen left, +-180 = back */
  headYaw: number;
  /** 0..1, looking down / nodding */
  headPitch: number;
}

export interface PoseDef {
  sprite: number;
  /** root offset relative to rest, in demon-sprite units */
  root: Vec2;
  angles: Record<string, number>;
  channels: PoseChannels;
  fit?: { cost: number; pixelErrors: number };
  source?: string;
  note?: string;
}

export interface Keyframe {
  /** media time (s) at which the original starts showing this pose */
  t: number;
  pose: string;
  /** window (whole-sprite) motion in demon-sprite units */
  dx: number;
  dy: number;
  src: 'emulation' | 'video' | string;
}

export interface TimedLetter {
  t: number;
  letter: string;
}

export interface ChoreographyData {
  version: number;
  title: string;
  timeBase: string;
  mediaStart: number;
  duration: number;
  spriteSize: Vec2;
  sprites: string[];
  poses: Record<string, PoseDef>;
  keyframes: Keyframe[];
  steps: TimedLetter[];
  notes: TimedLetter[];
  audioOnsets: { tone: number[]; tap: number[] };
  curtain: [number, number][];
  events: {
    curtainRiseStart: number;
    danceStart: number;
    musicEnd: number;
    curtainFallStart: number | null;
  };
  media: { audio: string; video: string[]; videoFps: number };
  alignment: Record<string, unknown>;
}

/** A fully evaluated pose at one instant (demon-sprite units for root). */
export interface SampledPose {
  root: Vec2;
  angles: Record<string, number>;
  channels: PoseChannels;
}
