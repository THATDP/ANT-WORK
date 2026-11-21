/**
 * Áudio 100% sintetizado (sem arquivos): vento, grilos noturnos, passos, coleta,
 * construção e alarmes. Tudo em WebAudio, criado no primeiro gesto do usuário.
 */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambientGain = null;
    this.started = false;
    this.night = false;
    this.lastStep = 0;
    this.enabled = true;
    this.volume = 0.45;
    this._cricketTimer = null;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(this.enabled ? v : 0, this.ctx.currentTime, 0.1);
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.08);
  }

  startAmbient() {
    const ctx = this.ensure();
    if (!ctx || this.started) return;
    this.started = true;

    // vento: ruído rosa filtrado com LFO lento
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const gain = ctx.createGain();
    gain.gain.value = 0.16;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 0.09;
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    lfo.start();
    this.ambientGain = gain;

    // drone grave de "subsolo"
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 52;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.03;
    osc.connect(oscGain).connect(this.master);
    osc.start();

    this.scheduleCrickets();
  }

  scheduleCrickets() {
    clearTimeout(this._cricketTimer);
    this._cricketTimer = setTimeout(() => {
      if (this.night && this.enabled) this.cricket();
      this.scheduleCrickets();
    }, 700 + Math.random() * 2200);
  }

  setNight(isNight) {
    this.night = !!isNight;
    if (this.ambientGain) {
      this.ambientGain.gain.setTargetAtTime(isNight ? 0.1 : 0.16, this.ctx.currentTime, 2);
    }
  }

  cricket() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = 3100 + Math.random() * 700;
      g.gain.value = 0;
      o.connect(g).connect(this.master);
      const at = t + i * 0.075;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.018, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      o.start(at); o.stop(at + 0.07);
    }
  }

  step() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const now = performance.now();
    if (now - this.lastStep < 260) return;
    this.lastStep = now;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 160 + Math.random() * 90;
    g.gain.value = 0.012;
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
  }

  tone(freq, dur = 0.16, type = 'sine', vol = 0.05, slide = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  gather() { this.tone(520, 0.12, 'triangle', 0.05, 180); setTimeout(() => this.tone(780, 0.1, 'sine', 0.035), 55); }
  deposit() { this.tone(380, 0.14, 'sine', 0.05, -60); setTimeout(() => this.tone(300, 0.18, 'sine', 0.04), 60); }
  build() { this.tone(120, 0.22, 'sawtooth', 0.045, -40); }
  error() { this.tone(180, 0.14, 'square', 0.03, -40); }
  alert() { this.tone(660, 0.12, 'square', 0.035); setTimeout(() => this.tone(520, 0.16, 'square', 0.035), 130); }
  death() { this.tone(300, 0.5, 'sine', 0.06, -220); }
  levelUp() { [440, 554, 660].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'triangle', 0.04), i * 90)); }
  attack() { this.tone(90, 0.1, 'sawtooth', 0.05, 40); }
}

export const audio = new AudioEngine();
