import { BedPlayer, ClipPlayer, pauseAll, playChime, resumeAll } from "./audio";
import { SongRun } from "./songRun";
import * as sp from "./spotify";
import { loadRecording } from "./storage";
import type { BedId, Block, Track } from "./types";

export const TYPE_LABELS: Record<Block["type"], string> = {
  songs: "Songs",
  jingle: "Jingle",
  talk: "Weather, Traffic, News",
  bed: "DJ Talk",
  commercial: "Commercial Break"
};

const QUIET_COPY: Partial<Record<Block["type"], [string, string]>> = {
  jingle: ["🎶 Jingle time!", "Listen to your jingle! Press green when it finishes."],
  talk: ["🎙️ You're on air, DJ!", "Tell us the weather, news & traffic! Press green when you're done."],
  commercial: ["📢 Your ad, DJ!", "Tell everyone about your product! Press green when you're done."]
};

export interface ShowUI {
  status(label: string, main: string, sub: string): void;
  progress(elapsedSec: number, durationSec: number | null): void;
  buttons(kind: "songs" | "talk" | "clip"): void;
  current(index: number): void;
  trouble(message: string | null): void;
  finished(): void;
}

interface Segment {
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  stop(): void;
  skip?(): Promise<void> | void; // "Skip this song"
  done?(): void; // "I'm finished talking"
}

export class Show {
  index = 0;
  paused = false;
  running = false;
  private seg: Segment | null = null;
  private token = 0; // guards against a stale segment finishing after we moved on

  constructor(
    private blocks: Block[],
    private tracks: Map<string, Track[]>,
    private deviceId: string | null,
    private bedId: () => BedId,
    private ui: ShowUI,
    private loop: () => Map<string, Track[]> | null // returns fresh songs to loop with, or null to finish
  ) {}

  async start(from = 0): Promise<void> {
    this.running = true;
    this.paused = false;
    if (this.deviceId) await sp.pause(this.deviceId); // stop whatever Spotify was already playing
    this.run(from);
  }

  private run(i: number): void {
    this.seg?.stop();
    this.seg = null;
    this.ui.trouble(null);
    if (!this.running) return;
    if (i >= this.blocks.length) {
      const again = this.loop();
      if (again) {
        this.tracks = again;
        return this.run(0);
      }
      this.running = false;
      this.ui.finished();
      return;
    }
    this.index = i;
    this.ui.current(i);
    const token = ++this.token;
    const next = () => { if (token === this.token && this.running) this.run(i + 1); };
    const b = this.blocks[i];
    if (b.type === "songs") this.seg = this.songs(b, next);
    else if (b.mode === "record") this.seg = this.clip(b, next, token);
    else this.seg = this.timed(b, next);
    if (this.paused) void this.seg?.pause();
  }

  // ---------- songs: exact track list handed to Spotify ----------
  private songs(b: Block, next: () => void): Segment | null {
    const list = this.tracks.get(b.id) ?? [];
    if (!list.length || !this.deviceId) {
      this.ui.status("Songs", "No songs to play", "Skipping…");
      const t = setTimeout(next, 1500);
      return { pause() {}, resume() {}, stop: () => clearTimeout(t) };
    }
    this.ui.buttons("songs");
    this.ui.status("Now Playing", `Song 1 of ${list.length}`, "Starting…");
    this.ui.progress(0, list[0].durationMs / 1000);
    const run = new SongRun(this.deviceId, list, {
      onTrack: (idx, t) => {
        this.ui.trouble(null);
        this.ui.status("Now Playing", `Song ${idx + 1} of ${list.length}`, `${t.name} – ${t.artist}`);
      },
      onProgress: (ms, dur) => this.ui.progress(ms / 1000, dur / 1000),
      onEnd: next,
      onTrouble: msg => this.ui.trouble(msg)
    });
    void run.start();
    return { pause: () => run.pause(), resume: () => run.resume(), stop: () => run.stop(), skip: () => run.skip() };
  }

  // ---------- quiet talk / talk over background music: counts down, green button ends early ----------
  private timed(b: Block, next: () => void): Segment {
    const total = Math.max(1, b.duration ?? 10);
    let left = total;
    const bed = b.mode === "background" ? new BedPlayer() : null;
    const label = TYPE_LABELS[b.type];
    if (bed) {
      void bed.start(this.bedId(), 0.7);
      this.ui.status(label, "🎶 Background music playing", "Talk over it! Press green when done");
    } else {
      const [main, sub] = QUIET_COPY[b.type] ?? ["🎤 Your turn, DJ!", "Speak to your listeners! Press green when you're done."];
      this.ui.status(label, main, sub);
      if (b.type === "jingle") void playChime();
    }
    this.ui.buttons("talk");
    this.ui.progress(0, total);
    let timer: number | null = null;
    const tick = () => {
      left -= 1;
      this.ui.progress(total - left, total);
      if (left <= 0) finish();
      else timer = window.setTimeout(tick, 1000);
    };
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      bed?.stop(1200);
      next();
    };
    timer = window.setTimeout(tick, 1000);
    return {
      pause: () => { if (timer !== null) { clearTimeout(timer); timer = null; } return pauseAll(); },
      resume: () => { if (timer === null) timer = window.setTimeout(tick, 1000); return resumeAll(); },
      stop: () => { if (timer !== null) clearTimeout(timer); timer = null; bed?.stop(300); },
      done: finish
    };
  }

  // ---------- recorded voice, optionally over background music ----------
  private clip(b: Block, next: () => void, token: number): Segment {
    const label = TYPE_LABELS[b.type];
    const clip = new ClipPlayer();
    const bed = b.bed ? new BedPlayer() : null;
    let progressTimer: number | null = null;
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      if (progressTimer !== null) clearInterval(progressTimer);
      clip.stop();
      if (bed) { bed.stop(1200); setTimeout(next, 900); } else next();
    };
    this.ui.buttons("clip");
    this.ui.status(label, "▶ Playing recording...", b.bed ? "Recording + background music" : "Listen up!");
    this.ui.progress(0, null);
    void (async () => {
      const blob = await loadRecording(b.id).catch(() => null);
      if (token !== this.token) return;
      if (!blob) {
        this.ui.status(label, "🤫 ...", "(no recording found)");
        setTimeout(finish, 2500);
        return;
      }
      if (bed) { await bed.start(b.bed!, 0.35); await sp.sleep(700); }
      if (token !== this.token || over) return;
      const ok = await clip.play(blob, finish);
      if (!ok) { setTimeout(finish, 1500); return; }
      progressTimer = window.setInterval(() => this.ui.progress(clip.position, clip.duration), 250);
    })();
    return {
      pause: () => pauseAll(),
      resume: () => resumeAll(),
      stop: () => { over = true; if (progressTimer !== null) clearInterval(progressTimer); clip.stop(); bed?.stop(300); },
      done: finish
    };
  }

  // ---------- controls ----------
  async togglePause(): Promise<void> {
    if (!this.seg) return;
    this.paused = !this.paused;
    await (this.paused ? this.seg.pause() : this.seg.resume());
  }

  skipSong(): void { void this.seg?.skip?.(); }
  finishedTalking(): void { this.seg?.done?.(); }

  stop(): void {
    this.running = false;
    this.token++;
    this.seg?.stop();
    this.seg = null;
    void resumeAll();
  }
}
