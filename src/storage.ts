import type { BedChoice, Block, SongSource, Track } from "./types";

// This app shares a web address (arcuscapital.github.io) with the original
// Krom FM, so browser storage is shared too — everything here uses its own
// "djraf" names so neither app can touch the other's show or recordings.

const KEYS = { blocks: "djraf_blocks", source: "djraf_source", bed: "djraf_bed", bedTrack: "djraf_bed_track", loop: "djraf_loop" };

export function defaultBlocks(): Block[] {
  return [
    { id: "b1", type: "jingle", mode: "quiet" },
    { id: "b2", type: "songs", count: 3 },
    { id: "b3", type: "talk", mode: "quiet" },
    { id: "b4", type: "songs", count: 3 },
    { id: "b5", type: "bed", mode: "background" },
    { id: "b6", type: "commercial", mode: "quiet" },
    { id: "b7", type: "songs", count: 2 },
    { id: "b8", type: "jingle", mode: "quiet" }
  ];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

export const loadBlocks = () => read<Block[]>(KEYS.blocks, defaultBlocks());
export const saveBlocks = (b: Block[]) => write(KEYS.blocks, b);
export const loadSource = () => read<SongSource | null>(KEYS.source, null);
export const saveSource = (s: SongSource | null) => write(KEYS.source, s);
export const loadBed = () => read<BedChoice>(KEYS.bed, "spotify"); // default: talk over a Spotify song (Bumblebee)
export const saveBed = (b: BedChoice) => write(KEYS.bed, b);
export const loadBedTrack = () => read<Track | null>(KEYS.bedTrack, null);
export const saveBedTrack = (t: Track | null) => write(KEYS.bedTrack, t);
export const loadLoop = () => read<boolean>(KEYS.loop, false);
export const saveLoop = (v: boolean) => write(KEYS.loop, v);

// ---------- recordings (IndexedDB) ----------
const DB = "djraf-db";
const STORE = "recordings";
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result as T);
    t.onerror = () => reject(t.error);
  });
}

// A background music file picked from this device. Stays on this device only
// (the site is public, so music files are never put into the app itself).
const BED_FILE_KEY = "__bed_file__";
export async function saveBedFile(blob: Blob, name: string) {
  await saveRecording(BED_FILE_KEY, blob);
  write("djraf_bed_file_name", name);
}
export const loadBedFile = () => loadRecording(BED_FILE_KEY);
export const bedFileName = () => read<string | null>("djraf_bed_file_name", null);

export const saveRecording = (id: string, blob: Blob) => tx<void>("readwrite", s => s.put(blob, id));
export const loadRecording = (id: string) => tx<Blob | undefined>("readonly", s => s.get(id)).then(b => b ?? null);
export const deleteRecording = (id: string) => tx<void>("readwrite", s => s.delete(id));
