import * as sp from "./spotify";
import type { SongSource, Track } from "./types";

// Where the show's songs come from. Default: whatever is playing on Spotify
// right now (open Spotify, start any playlist) — no links, no settings.

export type SourceResult = { ok: true; source: SongSource } | { ok: false; message: string };

function dedupe(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter(t => (seen.has(t.uri) ? false : (seen.add(t.uri), true)));
}

export async function fromNowPlaying(): Promise<SourceResult> {
  let now: sp.NowPlaying | null;
  try {
    now = await sp.getNowPlaying();
  } catch {
    return { ok: false, message: "Couldn't reach Spotify." };
  }
  if (!now || (!now.track && !now.contextUri)) {
    return { ok: false, message: "Nothing is playing on Spotify. Open Spotify, play any playlist, then tap “Use what's playing”." };
  }

  const playlistId = now.contextType === "playlist" && now.contextUri ? now.contextUri.split(":").pop()! : null;
  const name = (playlistId && (await sp.getPlaylistName(playlistId))) || (now.track ? `After “${now.track.name}”` : "Spotify");

  // Best: his own playlist's full track list, starting after the current song.
  if (playlistId) {
    try {
      const all = await sp.getPlaylistTracks(playlistId);
      if (all.length) {
        const at = now.track ? all.findIndex(t => t.uri === now!.track!.uri) : -1;
        const pool = dedupe([...all.slice(at + 1), ...all.slice(0, at + 1)]);
        return { ok: true, source: { name, playlistId, pool, offset: 0 } };
      }
    } catch { /* not his playlist (Spotify only lets apps read your own) — fall back to the queue */ }
  }

  // Otherwise: Spotify's own "up next" list for whatever is playing.
  try {
    const queue = dedupe(await sp.getQueue()).filter(t => t.uri !== now!.track?.uri);
    if (queue.length) return { ok: true, source: { name, playlistId: null, pool: queue, offset: 0 } };
  } catch { /* fall through */ }

  return { ok: false, message: "Couldn't read the songs coming up. Try “Choose playlist” instead." };
}

export async function fromPlaylist(id: string, name: string): Promise<SourceResult> {
  try {
    const pool = dedupe(await sp.getPlaylistTracks(id));
    if (!pool.length) return { ok: false, message: "That playlist has no songs the app can play." };
    return { ok: true, source: { name, playlistId: id, pool, offset: 0 } };
  } catch {
    return { ok: false, message: "Spotify won't share that playlist's songs. Pick one you made yourself." };
  }
}
