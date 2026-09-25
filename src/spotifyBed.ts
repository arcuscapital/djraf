import * as sp from "./spotify";
import type { Track } from "./types";

// A Spotify song used as background music for talk-over: played quietly and on
// repeat for as long as he's talking, then stopped and the volume put back.
// Safe to use repeat here — every songs block turns repeat off and plays its
// own exact track list, so nothing carries over into the next songs.
export class SpotifyBed {
  private volumeBefore: number | null = null;
  private active = false;

  constructor(private deviceId: string, private track: Track) {}

  async start(volumePercent = 30): Promise<void> {
    this.active = true;
    try {
      const d = (await sp.getDevices()).find(x => x.id === this.deviceId);
      this.volumeBefore = typeof d?.volume_percent === "number" ? d.volume_percent : null;
    } catch { /* keep null — we just won't restore */ }
    await sp.setVolume(this.deviceId, volumePercent);
    await sp.setRepeat(this.deviceId, "track");
    await sp.playUris(this.deviceId, [this.track.uri]);
  }

  pause() { return sp.pause(this.deviceId); }
  resume() { return sp.resume(this.deviceId); }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await sp.pause(this.deviceId);
    await sp.setRepeat(this.deviceId, "off");
    if (this.volumeBefore !== null) await sp.setVolume(this.deviceId, this.volumeBefore);
  }
}
