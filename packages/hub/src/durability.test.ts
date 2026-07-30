import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Hub } from "./index";
import { createHub } from "./index";
import {
  createClientPool,
  createDataDirPool,
  encodeLog,
  freePort,
  logBoard,
  logPath,
  MESSAGE_SYNC,
  openRawClient,
  readLog,
  recordUpdates,
  roomDocBytes,
  settle,
  waitFor,
} from "./test-helpers";

/** Reads the state vector out of the sync step 1 the hub opens a connection with. */
function openingStateVector(frame: Uint8Array): Map<number, number> {
  const decoder = decoding.createDecoder(frame);
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
  // `y-protocols/sync` writes the step number before the payload; 0 is step 1.
  expect(decoding.readVarUint(decoder)).toBe(0);
  return Y.decodeStateVector(decoding.readVarUint8Array(decoder));
}

describe("durability", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(options: { dataDir: string; port?: number }): Hub {
    const created = createHub({ port: options.port ?? 0, dataDir: options.dataDir });
    hubs.add(created);
    return created;
  }

  afterEach(async () => {
    clients.closeAll();
    for (const created of hubs) await created.stop();
    hubs.clear();
    await dataDirs.removeAll();
  });

  it("serves a board written before a restart to a client of the next hub (R1)", async () => {
    const dataDir = await dataDirs.create();

    const first = hub({ dataDir });
    const firstUrl = await first.start();
    const writer = clients.open(firstUrl, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await roomDocBytes(firstUrl, "alpha")) > 2);
    await first.stop();

    const second = hub({ dataDir });
    const secondUrl = await second.start();
    const reader = clients.open(secondUrl, "alpha");

    await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");
    expect(reader.doc.getMap("board").get("shape")).toBe("rect");
  });

  it("writes what is still inside the debounce window before stop() resolves (R1)", async () => {
    const dataDir = await dataDirs.create();
    const running = hub({ dataDir });
    const url = await running.start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);

    // Half a megabyte, so that the write `stop()` performs takes long enough
    // for "started it" and "waited for it" to be different answers.
    const stroke = "x".repeat(512 * 1024);
    writer.doc.getMap("board").set("shape", stroke);
    await waitFor(async () => (await roomDocBytes(url, "alpha")) > 2);

    // The debounce buffers updates for 250 ms of quiet, and the hub took only a
    // few milliseconds to receive this one, so the write is still in memory.
    // Asserting that first is what makes the assertion after `stop()` mean
    // something: the flush is the one `stop()` performs.
    expect(logBoard(await readLog(dataDir, "alpha"))).toEqual({});

    await running.stop();

    expect(logBoard(await readLog(dataDir, "alpha"))).toEqual({ shape: stroke });
  });

  it("rejects start() and holds no port when the data directory cannot be created (R1)", async () => {
    const parent = await dataDirs.create();
    const blocker = join(parent, "not-a-directory");
    await writeFile(blocker, "a regular file where a directory has to go");
    const port = await freePort();

    const broken = hub({ dataDir: join(blocker, "data"), port });

    await expect(broken.start()).rejects.toThrow();
    expect(broken.url).toBeNull();
    // A hub that failed to start must not be sitting on the port either: the
    // next attempt has to be able to bind it.
    const replacement = hub({ dataDir: await dataDirs.create(), port });
    await expect(replacement.start()).resolves.toContain(String(port));
  });

  it("leaves a log that needs no repair byte-identical across a load (R2)", async () => {
    const dataDir = await dataDirs.create();
    await mkdir(join(dataDir, "rooms"), { recursive: true });
    const updates = recordUpdates([
      (doc) => doc.getMap("board").set("shape", "rect"),
      (doc) => doc.getMap("board").set("colour", "red"),
    ]);
    await writeFile(logPath(dataDir, "alpha"), encodeLog(1_700_000_000_000, updates));
    const before = await readFile(logPath(dataDir, "alpha"));

    const running = hub({ dataDir });
    const url = await running.start();
    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("colour") === "red");
    // Past the whole debounce window. Applying the loaded state fires the
    // document's update event like any other write, so without an origin marker
    // on it the hub appends everything it just read straight back and the file
    // doubles on every restart — which takes a quarter of a second to show.
    await settle(600);

    const after = await readFile(logPath(dataDir, "alpha"));
    expect(after.equals(before)).toBe(true);
  });

  it("has the persisted content in the document it opens a connection with (R2)", async () => {
    const dataDir = await dataDirs.create();
    await mkdir(join(dataDir, "rooms"), { recursive: true });
    const updates = recordUpdates([(doc) => doc.getMap("board").set("shape", "rect")]);
    await writeFile(logPath(dataDir, "alpha"), encodeLog(1_700_000_000_000, updates));

    const running = hub({ dataDir });
    const url = await running.start();
    const peer = await openRawClient(url, "/sync/alpha");
    await waitFor(() => peer.frames.length > 0);

    // The hub's opening sync step 1 carries its own state vector. A hub that
    // attached the connection first and read the log afterwards would announce
    // an empty document here and the peer would see the board appear later.
    const stateVector = openingStateVector(peer.frames[0] as Uint8Array);
    expect(stateVector.size).toBeGreaterThan(0);
    peer.close();
  });

  it("never shows a connecting client an empty board that fills in later (R2)", async () => {
    const dataDir = await dataDirs.create();
    await mkdir(join(dataDir, "rooms"), { recursive: true });
    const updates = recordUpdates([(doc) => doc.getMap("board").set("shape", "rect")]);
    await writeFile(logPath(dataDir, "alpha"), encodeLog(1_700_000_000_000, updates));

    const running = hub({ dataDir });
    const url = await running.start();
    const reader = clients.open(url, "alpha");
    const atSync: unknown[] = [];
    reader.provider.on("sync", (state: boolean) => {
      if (state) atSync.push(reader.doc.getMap("board").get("shape"));
    });

    await waitFor(() => atSync.length > 0);
    expect(atSync).toEqual(["rect"]);
  });
});
