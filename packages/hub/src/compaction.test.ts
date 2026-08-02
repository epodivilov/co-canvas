import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index.ts";
import { createHub } from "./index.ts";
import {
  createClientPool,
  createDataDirPool,
  encodeLog,
  logPath,
  readIndex,
  readLog,
  recordUpdates,
  settle,
  stopHubs,
  waitFor,
} from "./test-helpers.ts";

const KIB = 1024;

function blob(bytes: number): string {
  return "x".repeat(bytes);
}

describe("compaction", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(dataDir: string): Hub {
    const created = createHub({ port: 0, dataDir });
    hubs.add(created);
    return created;
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

  it("collapses the log to one frame once the appends outgrow the board (R5)", async () => {
    const dataDir = await dataDirs.create();
    const running = hub(dataDir);
    const url = await running.start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);

    // The same key is rewritten over and over: the appends pile up while the
    // board itself stays one value big, which is exactly the shape the log is a
    // write optimisation for.
    const value = blob(4 * KIB);
    let appended = 0;
    let last = "";
    for (let batch = 0; batch < 3; batch += 1) {
      // Each batch on its own clears the 64 KiB floor and dwarfs the one-value
      // board, so the writes settle on a compacted log rather than on whatever
      // remainder the last batch happened to leave.
      for (let index = 0; index < 20; index += 1) {
        last = `${batch}-${index}-${value}`;
        writer.doc.getMap("board").set("blob", last);
        appended += last.length;
      }
      // Long enough for the 250 ms debounce to turn the batch into one frame.
      await settle(320);
    }

    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1, 10_000);
    const log = await readLog(dataDir, "alpha");
    expect(log.frames).toHaveLength(1);
    expect(log.bytes).toBeLessThan(appended);

    await running.stop();
    clients.closeAll();
    const reopenedUrl = await hub(dataDir).start();
    const reader = clients.open(reopenedUrl, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("blob") === last);
    expect(reader.doc.getMap("board").get("blob")).toBe(last);
  }, 15_000);

  it("leaves the log alone when the appends are large but the board is larger (R5)", async () => {
    const dataDir = await dataDirs.create();
    const running = hub(dataDir);
    const url = await running.start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);

    // First a board far bigger than the 64 KiB floor, written in one go so it
    // becomes a single snapshot the next threshold check measures against.
    const board = writer.doc.getMap("board");
    writer.doc.transact(() => {
      for (let index = 0; index < 100; index += 1) board.set(`k${index}`, blob(2 * KIB));
    });
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1, 10_000);
    const snapshot = (await readLog(dataDir, "alpha")).bytes;
    expect(snapshot).toBeGreaterThan(64 * KIB);

    // Then ~80 KiB of appends: over the 64 KiB floor, well under twice the
    // snapshot. Both conditions have to hold, so nothing is rewritten.
    writer.doc.transact(() => {
      for (let index = 100; index < 140; index += 1) board.set(`k${index}`, blob(2 * KIB));
    });
    await waitFor(async () => (await readLog(dataDir, "alpha")).bytes > snapshot, 10_000);
    await settle(400);

    const log = await readLog(dataDir, "alpha");
    expect(log.frames.length).toBeGreaterThan(1);
    expect(log.bytes).toBeGreaterThan(snapshot);
  }, 15_000);

  it("ignores a temporary file left behind by an interrupted compaction (R5)", async () => {
    const dataDir = await dataDirs.create();
    await mkdir(join(dataDir, "rooms"), { recursive: true });
    const updates = recordUpdates([
      (doc) => doc.getMap("board").set("shape", "rect"),
      (doc) => doc.getMap("board").set("colour", "red"),
    ]);
    await writeFile(logPath(dataDir, "alpha"), encodeLog(1_700_000_000_000, updates));
    // Half a snapshot, exactly what a process killed mid-rewrite would leave.
    await writeFile(join(dataDir, "rooms", "alpha.log.tmp"), encodeLog(1_700_000_000_000, []));

    const url = await hub(dataDir).start();
    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("colour") === "red");

    expect(reader.doc.getMap("board").toJSON()).toEqual({ shape: "rect", colour: "red" });
    expect((await readIndex(dataDir)).map((entry) => entry.slug)).toEqual(["alpha"]);
  });
});
