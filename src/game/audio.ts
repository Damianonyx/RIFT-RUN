/** Procedural SFX via Web Audio. Unlock on the first user gesture. */

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private drone: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;
  muted = false;

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "interactive" });
      this.master = this.ctx.createGain();
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = 0.7;
      this.sfx.connect(this.master);
      this.master.connect(this.ctx.destination);
      this.master.gain.value = this.muted ? 0 : 0.85;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.03);
    }
  }

  resume() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  jump() {
    this.blip(420, 180, 0.09, "square", 0.07);
  }

  lane() {
    this.blip(220, 140, 0.06, "triangle", 0.04);
  }

  coin(combo: number) {
    const bump = Math.min(combo, 6) * 40;
    this.blip(660 + bump, 990 + bump, 0.11, "sine", 0.09);
    this.blip(880 + bump, 1320 + bump, 0.08, "triangle", 0.04);
  }

  crash() {
    const ctx = this.ctx;
    const sfx = this.sfx;
    if (!ctx || !sfx) return;
    const dur = 0.28;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      data[i] = (Math.random() * 2 - 1) * (1 - t) * (1 - t);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.55, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(sfx);
    src.start();
    src.stop(ctx.currentTime + dur + 0.02);
    this.blip(140, 50, 0.22, "sawtooth", 0.08);
  }

  startDrone() {
    this.stopDrone();
    const ctx = this.ctx;
    const sfx = this.sfx;
    if (!ctx || !sfx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 72;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.035, ctx.currentTime + 0.6);
    osc.connect(g);
    g.connect(sfx);
    osc.start();
    this.drone = osc;
    this.droneGain = g;
  }

  stopDrone() {
    if (!this.drone || !this.ctx || !this.droneGain) return;
    const osc = this.drone;
    const g = this.droneGain;
    g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.08);
    osc.stop(this.ctx.currentTime + 0.4);
    this.drone = null;
    this.droneGain = null;
  }

  dispose() {
    this.stopDrone();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.sfx = null;
  }

  private blip(from: number, to: number, dur: number, type: OscillatorType, vol: number) {
    const ctx = this.ctx;
    const sfx = this.sfx;
    if (!ctx || !sfx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(g);
    g.connect(sfx);
    osc.start();
    osc.stop(ctx.currentTime + dur + 0.03);
  }
}
