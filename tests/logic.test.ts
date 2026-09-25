import { describe, expect, it } from "vitest";
import { assignSongs, autoSongsUsed } from "../src/songs";
import { judgeRun, newRunState, type Snapshot } from "../src/runWatch";
import type { Block, Track } from "../src/types";

const t = (n: number): Track => ({ uri: `spotify:track:${n}`, name: `Song ${n}`, artist: "A", durationMs: 180000 });
const pool = [1, 2, 3, 4, 5, 6, 7].map(t);

describe("assignSongs", () => {
  it("fills songs blocks in show order from the playlist", () => {
    const blocks: Block[] = [
      { id: "a", type: "songs", count: 3 },
      { id: "j", type: "jingle", mode: "quiet", duration: 3 },
      { id: "b", type: "songs", count: 2 }
    ];
    const m = assignSongs(blocks, pool, 0);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(m.get("b")!.map(x => x.name)).toEqual(["Song 4", "Song 5"]);
  });

  it("starts at the offset and wraps around the playlist", () => {
    const m = assignSongs([{ id: "a", type: "songs", count: 3 }], pool, 6);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 7", "Song 1", "Song 2"]);
  });

  it("keeps hand-picked songs and never uses a song twice in one show", () => {
    const blocks: Block[] = [
      { id: "a", type: "songs", count: 2, manual: [null, t(1)] },
      { id: "b", type: "songs", count: 2 }
    ];
    const m = assignSongs(blocks, pool, 0);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 2", "Song 1"]);
    expect(m.get("b")!.map(x => x.name)).toEqual(["Song 3", "Song 4"]);
  });

  it("gives fewer songs rather than repeating when the playlist is too short", () => {
    const m = assignSongs([{ id: "a", type: "songs", count: 5 }], pool.slice(0, 2), 0);
    expect(m.get("a")!.length).toBe(2);
  });

  it("never picks the talk-over song for a songs block", () => {
    const m = assignSongs([{ id: "a", type: "songs", count: 2 }], pool, 0, [t(1).uri]);
    expect(m.get("a")!.map(x => x.name)).toEqual(["Song 2", "Song 3"]);
  });

  it("counts how many playlist songs a show uses", () => {
    expect(autoSongsUsed([{ id: "a", type: "songs", count: 3, manual: [t(9)] }, { id: "b", type: "songs", count: 2 }])).toBe(4);
  });
});

const snap = (p: Partial<Snapshot>): Snapshot => ({
  ok: true, noContent: false, isPlaying: true, itemUri: null, progressMs: 0, durationMs: 180000, ...p
});

describe("judgeRun", () => {
  const run = ["spotify:track:1", "spotify:track:2", "spotify:track:3"];

  it("waits until our first track is actually playing", () => {
    const st = newRunState();
    expect(judgeRun(run, snap({ itemUri: "spotify:track:99" }), st).kind).toBe("waiting");
    expect(judgeRun(run, snap({ itemUri: run[0], isPlaying: false }), st).kind).toBe("waiting");
    expect(judgeRun(run, snap({ itemUri: run[0] }), st)).toEqual({ kind: "playing", index: 0 });
  });

  it("follows the run through its songs", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[0] }), st);
    expect(judgeRun(run, snap({ itemUri: run[1] }), st)).toEqual({ kind: "playing", index: 1 });
    expect(judgeRun(run, snap({ itemUri: run[2] }), st)).toEqual({ kind: "playing", index: 2 });
  });

  it("ends when Spotify stops after the last track", () => {
    for (const end of [snap({ itemUri: run[2], isPlaying: false, progressMs: 0 }), snap({ itemUri: run[2], isPlaying: false, progressMs: 179000 }), snap({ noContent: true, itemUri: null }), snap({ itemUri: run[0], isPlaying: false, progressMs: 0 })]) {
      const st = newRunState();
      judgeRun(run, snap({ itemUri: run[0] }), st);
      judgeRun(run, snap({ itemUri: run[2] }), st);
      expect(judgeRun(run, end, st).kind).toBe("ended");
    }
  });

  it("flags a spill into a song that isn't ours", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[2] }), st);
    expect(judgeRun(run, snap({ itemUri: "spotify:track:autoplay" }), st).kind).toBe("spilled");
  });

  it("flags Spotify looping back to the top of the list (the old repeat bug)", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[0] }), st);
    judgeRun(run, snap({ itemUri: run[2] }), st);
    expect(judgeRun(run, snap({ itemUri: run[0], isPlaying: true }), st).kind).toBe("spilled");
  });

  it("treats a mid-song pause as paused, not finished", () => {
    const st = newRunState();
    judgeRun(run, snap({ itemUri: run[1] }), st);
    expect(judgeRun(run, snap({ itemUri: run[1], isPlaying: false, progressMs: 60000 }), st)).toEqual({ kind: "paused", index: 1 });
  });

  it("a one-song run ends cleanly and doesn't repeat", () => {
    const one = ["spotify:track:1"];
    const st = newRunState();
    judgeRun(one, snap({ itemUri: one[0], progressMs: 1000 }), st);
    expect(judgeRun(one, snap({ itemUri: one[0], isPlaying: false, progressMs: 0 }), st).kind).toBe("ended");
  });

  it("ignores failed reads", () => {
    expect(judgeRun(run, snap({ ok: false }), newRunState()).kind).toBe("unknown");
  });
});
