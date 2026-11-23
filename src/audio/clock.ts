// The single authoritative playback clock.
//
// Animation, reference video and timeline all read `clock.time` every frame;
// nothing accumulates per-frame increments, so there is no drift. While audio
// is playing the clock is derived from AudioContext.currentTime (the sample
// clock of the sound actually being played). Without audio (not loaded yet,
// muted start, or failed decode) it falls back to performance.now().

export class MasterClock {
  readonly ctx: AudioContext;
  private gain: GainNode;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private anchorMedia = 0; // media time at anchor
  private anchorCtx = 0; // ctx time at anchor
  private anchorPerf = 0; // performance.now() at anchor (fallback)
  private _playing = false;
  private _rate = 1;
  private pausedAt = 0;
  duration: number;
  /** compensate the audio output latency so visuals match what is heard */
  latencyCompensation = true;
  /** extra user offset (s) added to the visual time (positive = visuals later) */
  avOffset = 0;
  onEnded: (() => void) | null = null;

  constructor(duration: number) {
    this.duration = duration;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  async load(url: string): Promise<void> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`audio ${url}: ${r.status}`);
    const bytes = await r.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(bytes);
  }

  get hasAudio() {
    return this.buffer !== null;
  }

  get playing() {
    return this._playing;
  }

  get rate() {
    return this._rate;
  }

  set volume(v: number) {
    this.gain.gain.value = v;
  }

  /** Media time of the sound currently being produced. */
  get audioTime(): number {
    if (!this._playing) return this.pausedAt;
    if (this.source) return this.anchorMedia + (this.ctx.currentTime - this.anchorCtx) * this._rate;
    return this.anchorMedia + ((performance.now() - this.anchorPerf) / 1000) * this._rate;
  }

  /** Media time the visuals should show now. */
  get time(): number {
    let t = this.audioTime;
    if (this._playing && this.source && this.latencyCompensation) {
      const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
      t -= lat * this._rate;
    }
    if (this._playing) t -= this.avOffset;
    return Math.min(Math.max(t, 0), this.duration);
  }

  async play() {
    if (this._playing) return;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* no audio device: performance.now fallback */
      }
    }
    if (this.pausedAt >= this.duration - 0.01) this.pausedAt = 0;
    this.startAt(this.pausedAt);
  }

  pause() {
    if (!this._playing) return;
    this.pausedAt = Math.min(this.audioTime, this.duration);
    this.stopSource();
    this._playing = false;
  }

  seek(t: number) {
    t = Math.min(Math.max(t, 0), this.duration);
    if (this._playing) {
      this.stopSource();
      this.startAt(t);
    } else {
      this.pausedAt = t;
    }
  }

  setRate(r: number) {
    const t = this.audioTime;
    this._rate = r;
    if (this._playing) {
      this.stopSource();
      this.startAt(t);
    }
  }

  private startAt(t: number) {
    this._playing = true;
    this.anchorMedia = t;
    this.anchorPerf = performance.now();
    this.source = null;
    if (this.buffer && this.ctx.state === 'running') {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this._rate;
      src.connect(this.gain);
      // schedule slightly ahead so anchor and actual start coincide exactly
      const when = this.ctx.currentTime + 0.02;
      src.start(when, t);
      this.anchorCtx = when;
      src.onended = () => {
        if (this.source === src) {
          this.pausedAt = this.duration;
          this._playing = false;
          this.source = null;
          this.onEnded?.();
        }
      };
      this.source = src;
    }
  }

  private stopSource() {
    if (this.source) {
      const s = this.source;
      this.source = null;
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
  }

  /** call every frame: handles end of media in fallback mode */
  tick() {
    if (this._playing && !this.source && this.audioTime >= this.duration) {
      this.pausedAt = this.duration;
      this._playing = false;
      this.onEnded?.();
    }
  }
}
