import type { BedId } from "./types";

// All of the app's own sound — jingle chime, background music beds, recorded
// voice — goes through one AudioContext. Spotify is always paused while any of
// this plays, and the context is suspended again afterwards so Android hands
// audio back to Spotify cleanly when the next song block starts.

let ctx: AudioContext | null = null;
let master: GainNode;

export function audioCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  return ctx;
}

// Call from a tap so the browser allows sound later in the show.
export async function unlockAudio(): Promise<void> {
  const c = audioCtx();
  if (c.state !== "running") await c.resume().catch(() => {});
}

let busy = 0;
async function acquire(): Promise<AudioContext> {
  busy++;
  const c = audioCtx();
  if (c.state !== "running") await c.resume().catch(() => {});
  return c;
}
function release() {
  busy = Math.max(0, busy - 1);
  setTimeout(() => { if (busy === 0 && ctx?.state === "running" && !pausedByUser) ctx.suspend().catch(() => {}); }, 400);
}

let pausedByUser = false;
export async function pauseAll() { pausedByUser = true; await ctx?.suspend().catch(() => {}); }
export async function resumeAll() { pausedByUser = false; if (busy > 0) await ctx?.resume().catch(() => {}); }

// ---------- jingle chime (same three notes as the original app) ----------
export async function playChime(): Promise<void> {
  const c = await acquire();
  const notes: [number, number, number][] = [[523, 0, 0.2], [659, 0.2, 0.2], [784, 0.4, 0.4]];
  const t0 = c.currentTime + 0.05;
  for (const [f, at, len] of notes) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.3, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.01, t0 + at + len);
    o.connect(g).connect(master);
    o.start(t0 + at);
    o.stop(t0 + at + len + 0.05);
  }
  setTimeout(release, 1000);
}

// ---------- background music beds ----------
// Generated live with oscillators: nothing to download or license, loops
// forever, and starts instantly.
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

function tone(c: AudioContext, out: AudioNode, freq: number, t: number, len: number, type: OscillatorType, vol: number, cutoff = 4000) {
  const o = c.createOscillator();
  const f = c.createBiquadFilter();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  f.type = "lowpass";
  f.frequency.value = cutoff;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + Math.min(0.02, len / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(f).connect(g).connect(out);
  o.start(t);
  o.stop(t + len + 0.05);
}

function kick(c: AudioContext, out: AudioNode, t: number, vol: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.15);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.35);
}

let noiseBuf: AudioBuffer | null = null;
function noise(c: AudioContext, out: AudioNode, t: number, len: number, vol: number, hp: number) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 0.5, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource();
  const f = c.createBiquadFilter();
  const g = c.createGain();
  s.buffer = noiseBuf;
  f.type = "highpass";
  f.frequency.value = hp;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  s.connect(f).connect(g).connect(out);
  s.start(t);
  s.stop(t + len + 0.02);
}

interface BedDef { bpm: number; step(c: AudioContext, out: AudioNode, step: number, t: number, stepLen: number): void }

const BEDS: Record<BedId, BedDef> = {
  chill: {
    bpm: 78,
    step(c, out, s, t, L) {
      const chords = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]];
      const bar = Math.floor(s / 16) % 4;
      const i = s % 16;
      if (i === 0) for (const n of chords[bar]) tone(c, out, midi(n), t, L * 16, "triangle", 0.05, 1200);
      if (i % 8 === 0) kick(c, out, t, 0.35);
      if (i % 4 === 2) noise(c, out, t, 0.05, 0.05, 7000);
      if (i === 6 || i === 14) tone(c, out, midi(chords[bar][0] - 12), t, L * 4, "sine", 0.12);
    }
  },
  hype: {
    bpm: 118,
    step(c, out, s, t, L) {
      const roots = [45, 45, 41, 43];
      const bar = Math.floor(s / 16) % 4;
      const i = s % 16;
      if (i % 4 === 0) kick(c, out, t, 0.55);
      if (i === 4 || i === 12) noise(c, out, t, 0.15, 0.2, 1500);
      if (i % 2 === 1) noise(c, out, t, 0.03, 0.06, 8000);
      const pat = [0, 0, 12, 0, 7, 0, 12, 10];
      tone(c, out, midi(roots[bar] + pat[i % 8]), t, L * 0.9, "sawtooth", 0.06, 900);
      if (i === 0) tone(c, out, midi(roots[bar] + 24), t, L * 8, "square", 0.025, 2200);
    }
  },
  serious: {
    bpm: 100,
    step(c, out, s, t, L) {
      const i = s % 16;
      const bar = Math.floor(s / 16) % 2;
      if (i === 0) for (const n of bar === 0 ? [50, 57, 62] : [48, 55, 62]) tone(c, out, midi(n), t, L * 16, "sawtooth", 0.025, 700);
      tone(c, out, midi(86), t, 0.04, "sine", i % 4 === 0 ? 0.08 : 0.04);
      if (i === 0 || i === 10) kick(c, out, t, 0.3);
    }
  }
};

export const BED_NAMES: Record<BedId, string> = { chill: "😎 Chill", hype: "⚡ Hype", serious: "🕵️ Serious" };

export class BedPlayer {
  private out: GainNode | null = null;
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;

  async start(id: BedId, volume = 0.7): Promise<void> {
    this.stop(0);
    const c = await acquire();
    const def = BEDS[id];
    const stepLen = 60 / def.bpm / 4;
    this.out = c.createGain();
    this.out.gain.setValueAtTime(0.0001, c.currentTime);
    this.out.gain.linearRampToValueAtTime(volume, c.currentTime + 0.6);
    this.out.connect(master);
    this.step = 0;
    this.nextTime = c.currentTime + 0.05;
    const out = this.out;
    const tick = () => {
      while (this.nextTime < c.currentTime + 0.15) {
        def.step(c, out, this.step, this.nextTime, stepLen);
        this.step++;
        this.nextTime += stepLen;
      }
    };
    tick();
    this.timer = window.setInterval(tick, 40);
  }

  stop(fadeMs = 1200): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    const out = this.out;
    this.out = null;
    if (!out || !ctx) return;
    const c = ctx;
    out.gain.cancelScheduledValues(c.currentTime);
    out.gain.setValueAtTime(out.gain.value, c.currentTime);
    out.gain.linearRampToValueAtTime(0.0001, c.currentTime + fadeMs / 1000);
    setTimeout(() => { out.disconnect(); release(); }, fadeMs + 100);
  }

  get playing(): boolean { return this.out !== null; }
}

// ---------- recorded voice playback ----------
// Decoded into memory rather than an <audio> element: exact length (recorder
// WebM files often report an unknown duration), and pausing is just suspending
// the context.
export class ClipPlayer {
  private src: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  duration = 0;

  async play(blob: Blob, onEnded: () => void): Promise<boolean> {
    const c = await acquire();
    let buf: AudioBuffer;
    try {
      buf = await c.decodeAudioData(await blob.arrayBuffer());
    } catch {
      release();
      return false;
    }
    this.duration = buf.duration;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(master);
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      release();
      onEnded();
    };
    this.src = src;
    this.startedAt = c.currentTime;
    src.start();
    return true;
  }

  get position(): number {
    return this.src && ctx ? Math.min(this.duration, ctx.currentTime - this.startedAt) : 0;
  }

  stop(): void {
    const s = this.src;
    this.src = null;
    if (s) { try { s.stop(); } catch { /* already stopped */ } release(); }
  }
}

// ---------- microphone recording ----------
export class Recorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];

  async start(): Promise<void> {
    // The browser's call-style voice processing (echo cancellation, noise
    // suppression, auto gain) can briefly mute a pause in speech — that was the
    // "silent gap" in the original app. We're not on a call, so switch it off.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
  }

  stop(): Promise<Blob | null> {
    return new Promise(resolve => {
      const rec = this.rec;
      if (!rec || rec.state === "inactive") { this.cleanup(); resolve(null); return; }
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
        this.cleanup();
        resolve(blob);
      };
      rec.stop();
    });
  }

  get recording(): boolean { return this.rec?.state === "recording"; }

  private cleanup() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.rec = null;
  }
}
