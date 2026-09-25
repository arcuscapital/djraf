import * as sp from "./spotify";
import type { Track } from "./types";

// A Spotify song used as background music for talk-over: played on repeat for
// as long as he's talking, then stopped. Safe to use repeat here — every songs
// block turns repeat off and plays its own exact track list.
//
// Turning it down is the tricky part. Spotify often refuses volume changes
// when the speaker is a phone (it worked on a desktop player but not on Raf's
// Android phone with the original app). So we only trust a volume change we can
// read back; if Spotify won't do it, `ducked` stays false and the show asks Raf
// to turn the phone down himself — what worked before, just made explicit.
export class SpotifyBed {
  private volumeBefore: number | null = null;
  private active = false;
  ducked = false;

  constructor(private deviceId: string, private track: Track) {}

  async start(volumePercent = 30): Promise<void> {
    this.active = true;
    this.ducked = await tryDuck(this.deviceId, volumePercent, v => { this.volumeBefore = v; });
    await sp.playUris(this.deviceId, [this.track.uri]);
    // Set after starting: starting new tracks can reset Spotify's repeat mode.
    await sp.setRepeat(this.deviceId, "track");
  }

  pause() { return sp.pause(this.deviceId); }
  resume() { return sp.resume(this.deviceId); }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await sp.pause(this.deviceId);
    await sp.setRepeat(this.deviceId, "off");
    if (this.ducked && this.volumeBefore !== null) await sp.setVolume(this.deviceId, this.volumeBefore);
  }
}

// Lowers the device volume and confirms it actually changed. Returns false if
// the device doesn't allow it (common for phones), without touching anything.
export async function tryDuck(deviceId: string, percent: number, remember: (before: number) => void): Promise<boolean> {
  try {
    const d = (await sp.getDevices()).find(x => x.id === deviceId);
    if (!d || d.supports_volume === false || typeof d.volume_percent !== "number") return false;
    if (d.volume_percent <= percent) { remember(d.volume_percent); return true; } // already quiet enough
    remember(d.volume_percent);
    if (!(await sp.setVolume(deviceId, percent))) return false;
    for (let i = 0; i < 3; i++) {
      await sp.sleep(400);
      const now = (await sp.getDevices()).find(x => x.id === deviceId)?.volume_percent;
      if (typeof now === "number" && Math.abs(now - percent) <= 5) return true;
    }
  } catch { /* treat as not supported */ }
  return false;
}
