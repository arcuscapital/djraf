export type BlockType = "songs" | "jingle" | "talk" | "bed" | "commercial";
export type Mode = "quiet" | "record" | "background";
export type BedId = "chill" | "hype" | "serious";
// Background music for talk-over: a built-in bed, or a Spotify song he picked.
export type BedChoice = BedId | "spotify";

export interface Track {
  uri: string;
  name: string;
  artist: string;
  durationMs: number;
}

export interface Block {
  id: string;
  type: BlockType;
  // songs blocks
  count?: number;
  // per-slot songs he picked himself; null/missing slots are filled from the playlist
  manual?: (Track | null)[];
  // everything else
  mode?: Mode;
  duration?: number; // seconds, for quiet / background
  bed?: BedChoice | null; // record mode: background music played under the recording
  bedTrack?: Track; // when bed is "spotify": the song
}

export interface SongSource {
  name: string;
  playlistId: string | null;
  pool: Track[];
  offset: number; // where the next show starts in the pool, so shows don't reuse songs
  mode?: "nowPlaying" | "playlist"; // how it was picked
}
