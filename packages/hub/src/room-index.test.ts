import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index.ts";
import { createHub } from "./index.ts";
import {
  createClientPool,
  createDataDirPool,
  encodeLog,
  indexPath,
  liveRooms,
  logPath,
  readIndex,
  readLog,
  recordUpdates,
  roomDocBytes,
  settle,
  stopHubs,
  waitFor,
} from "./test-helpers.ts";

const CREATED_AT = 1_700_000_000_000;

describe("room index", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(dataDir: string): Hub {
    const created = createHub({ port: 0, dataDir });
    hubs.add(created);
    return created;
  }

  async function seedLog(dataDir: string, slug: string, createdAt = CREATED_AT): Promise<void> {
    await mkdir(join(dataDir, "rooms"), { recursive: true });
    const updates = recordUpdates([(doc) => doc.getMap("board").set("shape", "rect")]);
    await writeFile(logPath(dataDir, slug), encodeLog(createdAt, updates));
  }

  afterEach(async () => {
    clients.closeAll();
    try {
      await stopHubs(hubs);
    } finally {
      hubs.clear();
      // Unconditional: a scenario that failed with a hub mid-flush would
      // otherwise leave its directory behind in the OS temp dir forever.
      await dataDirs.removeAll();
    }
  });

  // Root ignores the bits this clears, so under uid 0 — a plain Docker CI
  // image, say — the scenario would pass without ever reaching the guard.
  // Skipped visibly rather than left silently vacuous.
  it.skipIf(process.getuid?.() === 0)(
    "starts, and keeps every other board, when one log cannot be read (R7)",
    async () => {
      const dataDir = await dataDirs.create();
      await seedLog(dataDir, "alpha");
      await seedLog(dataDir, "beta");
      await chmod(logPath(dataDir, "beta"), 0o000);

      const url = await hub(dataDir).start();

      // One unreadable file must not take the hub with it. Rebuilding the index
      // is a scan over every board, so an error that escapes it turns "one bad
      // log" into "no hub at all" — worse than the state the rebuild exists to
      // recover from.
      const listed = (await readIndex(dataDir)).map((entry) => entry.slug).sort();
      expect(listed).toEqual(["alpha", "beta"]);
      const reader = clients.open(url, "alpha");
      await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");
      expect(reader.doc.getMap("board").toJSON()).toEqual({ shape: "rect" });
    },
  );

  it("rebuilds an index that parses but has fallen behind the logs (R7)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha");
    await seedLog(dataDir, "beta");
    // Well-formed and stale, which is what a crash between creating a log and
    // publishing the index leaves. Trusting it because it parses would hide a
    // board that plainly exists, and nothing would ever bring it back.
    await writeFile(
      indexPath(dataDir),
      JSON.stringify({
        version: 1,
        rooms: [{ slug: "alpha", createdAt: CREATED_AT, updatedAt: CREATED_AT, bytes: 1 }],
      }),
    );

    await hub(dataDir).start();

    const entries = [...(await readIndex(dataDir))].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(entries.map((entry) => entry.slug)).toEqual(["alpha", "beta"]);
    // Not merely appended to: the entry the stale index did carry is rederived
    // from the log rather than believed.
    expect(entries[0]?.bytes).toBe((await stat(logPath(dataDir, "alpha"))).size);
  });

  it("lists every written room with its size and last write time (R7)", async () => {
    const dataDir = await dataDirs.create();
    const running = hub(dataDir);
    const url = await running.start();
    const before = Date.now();

    for (const slug of ["alpha", "beta"]) {
      const writer = clients.open(url, slug);
      await waitFor(() => writer.provider.synced);
      writer.doc.getMap("board").set("shape", slug);
      await waitFor(async () => (await roomDocBytes(url, slug)) > 2);
    }
    await waitFor(async () => (await readIndex(dataDir)).every((entry) => entry.bytes > 14));

    const entries = [...(await readIndex(dataDir))].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(entries.map((entry) => entry.slug)).toEqual(["alpha", "beta"]);
    for (const entry of entries) {
      const onDisk = await stat(logPath(dataDir, entry.slug));
      expect(entry.bytes).toBe(onDisk.size);
      expect(entry.updatedAt).toBeGreaterThanOrEqual(before);
    }
  });

  it("rebuilds a missing index from the logs without opening a room (R7)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha");
    await seedLog(dataDir, "beta");

    const url = await hub(dataDir).start();

    const entries = (await readIndex(dataDir)).map((entry) => entry.slug).sort();
    expect(entries).toEqual(["alpha", "beta"]);
    // Rebuilding reads each log's 14-byte header, never its frames: the boards
    // are listed without any of them being pulled into memory.
    expect(await liveRooms(url)).toEqual([]);
  });

  it("counts only logs, never quarantine or compaction artefacts (R7)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha");
    await writeFile(join(dataDir, "rooms", "alpha.log.corrupt.1700000000001"), "salvaged bytes");
    await writeFile(join(dataDir, "rooms", "alpha.log.tmp"), encodeLog(CREATED_AT, []));
    // Two more things that are not boards: a file with no log suffix at all,
    // and one whose suffix is right but whose name no client could ever address
    // — so each half of the filter has something of its own to catch.
    await writeFile(join(dataDir, "rooms", "notes"), "not a board");
    await writeFile(join(dataDir, "rooms", "Not_A_Slug.log"), encodeLog(CREATED_AT, []));

    await hub(dataDir).start();

    expect((await readIndex(dataDir)).map((entry) => entry.slug)).toEqual(["alpha"]);
  });

  it("rebuilds rather than failing when the index is not valid JSON (R7)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha");
    await writeFile(indexPath(dataDir), "{ this is not json");

    const url = await hub(dataDir).start();

    expect(url).toContain("http://");
    expect((await readIndex(dataDir)).map((entry) => entry.slug)).toEqual(["alpha"]);
  });

  it("reports the same creation time after the index is rebuilt (R7)", async () => {
    const dataDir = await dataDirs.create();
    const first = hub(dataDir);
    const url = await first.start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    // A later write, so the file's mtime has moved on from its creation time and
    // an index that read the creation time off the filesystem would be caught.
    await settle(20);
    writer.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await roomDocBytes(url, "alpha")) > 2);
    await first.stop();
    clients.closeAll();

    const created = (await readLog(dataDir, "alpha")).createdAt;
    await rm(indexPath(dataDir));
    await hub(dataDir).start();

    const entry = (await readIndex(dataDir)).find((candidate) => candidate.slug === "alpha");
    expect(entry?.createdAt).toBe(created);
    expect(entry?.updatedAt).toBeGreaterThan(created);
  });
});
