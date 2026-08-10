/**
 * The `open` entry point (CC-32), driven with fakes for the hub, the browser and
 * the output so no real hub is woken and no real browser is spawned. `runOpen`
 * is imported from the package barrel on purpose: R5 is that the wake/list/open
 * capability is reachable as an export a future client imports, not only through
 * the CLI.
 */
import { describe, expect, it } from "vitest";
import type { HubRoom } from "./hub.ts";
import { runOpen } from "./index.ts";

interface Recorder {
  out: string[];
  err: string[];
  opened: string[];
  acquires: number;
}

interface Fakes {
  rec: Recorder;
  deps: {
    acquire: () => Promise<{ url: string }>;
    listRooms: (hubUrl: string) => Promise<HubRoom[]>;
    open: (url: string) => Promise<boolean>;
    io: { out: (line: string) => void; err: (line: string) => void };
  };
}

/** A world of fakes: a hub at `url` holding `rooms`, and an opener that reports `opens`. */
function fakes(config: {
  url?: string;
  rooms?: HubRoom[];
  opens?: boolean;
  acquireError?: Error;
}): Fakes {
  const rec: Recorder = { out: [], err: [], opened: [], acquires: 0 };
  const url = config.url ?? "http://127.0.0.1:4321";
  const rooms = config.rooms ?? [];
  const opens = config.opens ?? true;

  return {
    rec,
    deps: {
      acquire: async () => {
        rec.acquires += 1;
        if (config.acquireError !== undefined) throw config.acquireError;
        return { url };
      },
      listRooms: async () => rooms,
      open: async (target) => {
        rec.opened.push(target);
        return opens;
      },
      io: {
        out: (line) => rec.out.push(line),
        err: (line) => rec.err.push(line),
      },
    },
  };
}

describe("runOpen", () => {
  it("wakes the hub and launches the browser on the overview when given no slug (R1)", async () => {
    const { rec, deps } = fakes({ url: "http://127.0.0.1:4321" });

    await runOpen(deps);

    expect(rec.acquires).toBe(1);
    expect(rec.opened).toEqual(["http://127.0.0.1:4321"]);
  });

  it("prints the overview URL and every room with its peer count (R2)", async () => {
    const { rec, deps } = fakes({
      url: "http://127.0.0.1:4321",
      rooms: [
        { slug: "alpha", peers: 2 },
        { slug: "beta", peers: 1 },
      ],
    });

    await runOpen(deps);

    const stdout = rec.out.join("\n");
    expect(stdout).toContain("http://127.0.0.1:4321");
    expect(stdout).toContain("alpha");
    expect(stdout).toContain("(2 connected)");
    expect(stdout).toContain("beta");
    expect(stdout).toContain("(1 connected)");
  });

  it("opens the board URL when the slug names a room the hub holds (R3)", async () => {
    const { rec, deps } = fakes({
      url: "http://127.0.0.1:4321",
      rooms: [{ slug: "alpha", peers: 0 }],
    });

    await runOpen({ ...deps, slug: "alpha" });

    expect(rec.opened).toEqual(["http://127.0.0.1:4321/room/alpha"]);
  });

  it("reports an unknown slug and opens no board, still listing the rooms (R3)", async () => {
    const { rec, deps } = fakes({
      url: "http://127.0.0.1:4321",
      rooms: [{ slug: "alpha", peers: 0 }],
    });

    await runOpen({ ...deps, slug: "ghost" });

    // A slug the hub does not hold must not open a dead board.
    expect(rec.opened).toEqual([]);
    expect(rec.err.join("\n")).toContain("ghost");
    expect(rec.err.join("\n").toLowerCase()).toContain("no room");
    // The rooms it does hold are still on stdout, so the user sees what is there.
    expect(rec.out.join("\n")).toContain("alpha");
  });

  it("still resolves and prints the URL when the browser will not launch (R4)", async () => {
    const { rec, deps } = fakes({ url: "http://127.0.0.1:4321", opens: false });

    await expect(runOpen(deps)).resolves.toBeUndefined();

    expect(rec.out.join("\n")).toContain("http://127.0.0.1:4321");
  });

  it("rejects when the hub cannot be woken or reached (R4)", async () => {
    const { deps } = fakes({
      acquireError: new Error("no co-canvas hub is available on port 4321"),
    });

    await expect(runOpen(deps)).rejects.toThrow(/hub/i);
  });

  it("is exported from the package and callable directly, with no argv (R5)", async () => {
    expect(typeof runOpen).toBe("function");
    const { rec, deps } = fakes({
      url: "http://127.0.0.1:4321",
      rooms: [{ slug: "solo", peers: 0 }],
    });

    await runOpen(deps);

    expect(rec.out.join("\n")).toContain("http://127.0.0.1:4321");
    expect(rec.out.join("\n")).toContain("solo");
  });
});
