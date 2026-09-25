import { judgeRun, newRunState, type RunState } from "./runWatch";
import * as sp from "./spotify";
import type { Track } from "./types";

export interface RunHooks {
  onTrack(index: number, track: Track): void;
  onProgress(ms: number, durationMs: number): void;
  onEnd(): void;
  onTrouble(message: string): void; // Spotify didn't start / went away
}

// Plays one songs block: hands Spotify exactly these tracks, then watches until
// Spotify stops by itself after the last one. No playlist, no repeat mode, no
// racing to pause at the right moment — nothing left to spill or repeat.
export class SongRun {
  private state: RunState = newRunState();
  private timer: number | null = null;
  private stopped = false;
  private pausedByUs = false;
  private startedAt = 0;
  private reissued = false;
  private index = -1;
  private uris: string[];

  constructor(private deviceId: string, private tracks: Track[], private hooks: RunHooks) {
    this.uris = tracks.map(t => t.uri);
  }

  async start(): Promise<void> {
    // Order must be exactly ours, and it must not loop.
    await sp.setShuffle(this.deviceId, false);
    await sp.setRepeat(this.deviceId, "off");
    if (!(await sp.playUris(this.deviceId, this.uris))) {
      await sp.transfer(this.deviceId);
      await sp.sleep(400);
      if (!(await sp.playUris(this.deviceId, this.uris))) {
        this.hooks.onTrouble("Spotify didn't start the songs");
      }
    }
    this.startedAt = Date.now();
    this.schedule(700);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.poll(), ms);
  }

  private async poll() {
    this.timer = null;
    if (this.stopped || this.pausedByUs) return;
    const s = await sp.snapshot();
    if (this.stopped || this.pausedByUs) return;
    const v = judgeRun(this.uris, s, this.state);

    switch (v.kind) {
      case "waiting": {
        const waited = Date.now() - this.startedAt;
        // Spotify sometimes accepts the play command and then doesn't act on it.
        if (waited > 5000 && !this.reissued) {
          this.reissued = true;
          await sp.playUris(this.deviceId, this.uris);
        } else if (waited > 15000) {
          this.hooks.onTrouble("Spotify isn't playing — is the Spotify app open?");
          this.reissued = false;
          this.startedAt = Date.now();
        }
        return this.schedule(1000);
      }
      case "playing":
      case "paused": {
        if (v.index !== this.index) {
          this.index = v.index;
          this.hooks.onTrack(v.index, this.tracks[v.index]);
        }
        this.hooks.onProgress(s.progressMs, s.durationMs);
        const onLast = v.index === this.uris.length - 1;
        const left = s.durationMs - s.progressMs;
        return this.schedule(onLast && left < 6000 ? 350 : 1000);
      }
      case "spilled":
        // Something that isn't ours started (Spotify autoplay, or a loop): stop it now.
        await sp.pauseVerified(this.deviceId);
        return this.finish();
      case "ended":
        return this.finish();
      default:
        return this.schedule(1000);
    }
  }

  private finish() {
    if (this.stopped) return;
    this.stop(false);
    this.hooks.onEnd();
  }

  async skip(): Promise<void> {
    if (this.stopped) return;
    if (this.index >= this.uris.length - 1 || this.index < 0) {
      await sp.pauseVerified(this.deviceId);
      this.finish();
      return;
    }
    await sp.next(this.deviceId);
    this.schedule(400);
  }

  async pause(): Promise<void> {
    this.pausedByUs = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await sp.pauseVerified(this.deviceId);
  }

  async resume(): Promise<void> {
    this.pausedByUs = false;
    await sp.resume(this.deviceId);
    this.schedule(700);
  }

  stop(pauseSpotify = true): void {
    this.stopped = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (pauseSpotify) void sp.pauseVerified(this.deviceId);
  }
}
