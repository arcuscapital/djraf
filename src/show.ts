import { BedPlayer, ClipPlayer, pauseAll, playChime, resumeAll } from "./audio";
import { SongRun } from "./songRun";
import * as sp from "./spotify";
import { SpotifyBed } from "./spotifyBed";
import { loadRecording } from "./storage";
import type { BedChoice, Block, Track } from "./types";

export interface BedSetting { choice: BedChoice; track: Track | null }

// Background music under talk: either a built-in bed played by the app, or a
// Spotify song he picked, played quietly on Spotify.
interface Bed { start(): Promise<void>; pause(): Promise<unknown> | void; resume(): Promise<unknown> | void; stop(): Promise<void> | void }
function makeBed(choice: BedChoice, track: Track | null | undefined, deviceId: string | null, volume: number): Bed {
  if (choice === "spotify" && track && deviceId) {
    const b = new SpotifyBed(deviceId, track);
    return { start: () => b.start(Math.round(volume * 100)), pause: () => b.pause(), resume: () => b.resume(), stop: () => b.stop() };
  }
  const b = new BedPlayer();
  const id = choice === "spotify" ? "chill" : choice;
  return { start: () => b.start(id, volume), pause: () => pauseAll(), resume: () => resumeAll(), stop: () => b.stop(1200) };
}

export const TYPE_LABELS: Record<Block["type"], string> = {
  songs: "Songs",
  jingle: "Jingle",
  talk: "Weather, Traffic, News",
  bed: "DJ Talk",
  commercial: "Commercial Break"
};

const QUIET_COPY: Partial<Record<Block["type"], [string, string]>> = {
  jingle: ["🎶 Jingle time!", "Sing your jingle! Press green when you're done."],
  talk: ["🎙️ You're on air, DJ!", "Tell us the weather, news & traffic! Press green when you're done."],
  commercial: ["📢 Your ad, DJ!", "Tell everyone about your product! Press green when you're done."]
};

export interface ShowUI {
  status(label: string, main: string, sub: string): void;
  progress(elapsedSec: number, durationSec: number | null): void;
  buttons(kind: "songs" | "talk" | "clip"): void;
  current(index: number): void;
  trouble(message: string | null): void;
  songList(tracks: Track[] | null, playingIndex: number): void; // this block's songs, or null to hide
  finished(): void;
}

interface Segment {
  pause(): Promise<unknown> | void;
  resume(): Promise<unknown> | void;
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
    private bed: () => BedSetting,
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
    if (b.type !== "songs") this.ui.songList(null, -1);
    if (b.type === "songs") this.seg = this.songs(b, next);
    else if (b.mode === "record") this.seg = this.clip(b, next, token);
    else this.seg = this.talk(b, next);
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
    this.ui.songList(list, 0);
    this.ui.status("Now Playing", `Song 1 of ${list.length}`, "Starting…");
    this.ui.progress(0, list[0].durationMs / 1000);
    const run = new SongRun(this.deviceId, list, {
      onTrack: (idx, t) => {
        this.ui.trouble(null);
        this.ui.songList(list, idx);
        this.ui.status("Now Playing", `Song ${idx + 1} of ${list.length}`, `${t.name} – ${t.artist}`);
      },
      onProgress: (ms, dur) => this.ui.progress(ms / 1000, dur / 1000),
      onEnd: next,
      onTrouble: msg => this.ui.trouble(msg)
    });
    void run.start();
    return { pause: () => run.pause(), resume: () => run.resume(), stop: () => run.stop(), skip: () => run.skip() };
  }

  // ---------- he talks (quietly, or over background music) ----------
  // No timer: it waits for the green "I'm finished" button, so he's never cut
  // off mid-sentence. Background music loops for as long as he talks.
  private talk(b: Block, next: () => void): Segment {
    const setting = this.bed();
    const bed = b.mode === "background" ? makeBed(setting.choice, setting.track, this.deviceId, setting.choice === "spotify" ? 0.3 : 0.7) : null;
    const label = TYPE_LABELS[b.type];
    if (bed) {
      void bed.start();
      const what = setting.choice === "spotify" && setting.track ? `🎵 ${setting.track.name}` : "🎶 Background music playing";
      this.ui.status(label, what, "Talk over it! Press green when you're done.");
    } else {
      const [main, sub] = QUIET_COPY[b.type] ?? ["🎤 Your turn, DJ!", "Speak to your listeners! Press green when you're done."];
      this.ui.status(label, main, sub);
      if (b.type === "jingle") void playChime();
    }
    this.ui.buttons("talk");
    let elapsed = 0;
    this.ui.progress(0, null);
    let timer: number | null = null;
    const tick = () => { elapsed++; this.ui.progress(elapsed, null); timer = window.setTimeout(tick, 1000); };
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      void Promise.resolve(bed?.stop()).then(next);
    };
    timer = window.setTimeout(tick, 1000);
    return {
      pause: () => { if (timer !== null) { clearTimeout(timer); timer = null; } return bed ? bed.pause() : pauseAll(); },
      resume: () => { if (timer === null) timer = window.setTimeout(tick, 1000); return bed ? bed.resume() : resumeAll(); },
      stop: () => { over = true; if (timer !== null) clearTimeout(timer); timer = null; void bed?.stop(); },
      done: finish
    };
  }

  // ---------- recorded voice, optionally over background music ----------
  private clip(b: Block, next: () => void, token: number): Segment {
    const label = TYPE_LABELS[b.type];
    const clip = new ClipPlayer();
    const bed = b.bed ? makeBed(b.bed, b.bedTrack, this.deviceId, b.bed === "spotify" ? 0.25 : 0.35) : null;
    let progressTimer: number | null = null;
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      if (progressTimer !== null) clearInterval(progressTimer);
      clip.stop();
      if (bed) void Promise.resolve(bed.stop()).then(() => setTimeout(next, b.bed === "spotify" ? 0 : 900));
      else next();
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
      if (bed) { await bed.start(); await sp.sleep(700); }
      if (token !== this.token || over) return;
      const ok = await clip.play(blob, finish);
      if (!ok) { setTimeout(finish, 1500); return; }
      progressTimer = window.setInterval(() => this.ui.progress(clip.position, clip.duration), 250);
    })();
    return {
      pause: () => { void bed?.pause(); return pauseAll(); },
      resume: () => { void bed?.resume(); return resumeAll(); },
      stop: () => { over = true; if (progressTimer !== null) clearInterval(progressTimer); clip.stop(); void bed?.stop(); },
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
