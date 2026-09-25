import type { Block, Track } from "./types";

// Works out exactly which songs every songs block will play, in show order.
// Songs he picked himself stay put; every other slot takes the next song from
// the playlist, never repeating a song already used earlier in the same show.
export function assignSongs(blocks: Block[], pool: Track[], offset: number): Map<string, Track[]> {
  const result = new Map<string, Track[]>();
  const used = new Set<string>();
  for (const b of blocks) {
    if (b.type !== "songs") continue;
    for (const t of b.manual ?? []) if (t) used.add(t.uri);
  }

  let cursor = pool.length ? ((offset % pool.length) + pool.length) % pool.length : 0;
  let scanned = 0;
  const nextFromPool = (): Track | null => {
    while (pool.length && scanned < pool.length) {
      const t = pool[cursor];
      cursor = (cursor + 1) % pool.length;
      scanned++;
      if (!used.has(t.uri)) {
        used.add(t.uri);
        return t;
      }
    }
    return null;
  };

  for (const b of blocks) {
    if (b.type !== "songs") continue;
    const count = Math.max(1, b.count ?? 1);
    const list: Track[] = [];
    for (let i = 0; i < count; i++) {
      const picked = b.manual?.[i] ?? null;
      const t = picked ?? nextFromPool();
      if (t) list.push(t);
    }
    result.set(b.id, list);
  }
  return result;
}

// How many songs from the pool a show consumes, so the next show can start after them.
export function autoSongsUsed(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type !== "songs") continue;
    const count = Math.max(1, b.count ?? 1);
    for (let i = 0; i < count; i++) if (!b.manual?.[i]) n++;
  }
  return n;
}
