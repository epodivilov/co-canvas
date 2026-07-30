import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Hub } from "./index";
import { createHub } from "./index";
import { loadRoomLog } from "./room-log";
import {
  createClientPool,
  createDataDirPool,
  encodeLog,
  logBoard,
  logPath,
  readLog,
  recordUpdates,
  roomDocBytes,
  waitFor,
} from "./test-helpers";

const CREATED_AT = 1_700_000_000_000;

/** The big-endian u32 a frame carries in front of its payload. */
function framePrefix(length: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(length, 0);
  return bytes;
}

/** Three updates: two small ones, then one big enough to truncate in many ways. */
function threeUpdates(): [Uint8Array, Uint8Array, Uint8Array] {
  const updates = recordUpdates([
    (doc) => doc.getMap("board").set("a", 1),
    (doc) => doc.getMap("board").set("b", 2),
    (doc) => {
      const board = doc.getMap("board");
      doc.transact(() => {
        for (let index = 0; index < 50; index += 1) board.set(`k${index}`, `value-${index}-xxxx`);
      });
    },
  ]);
  return [updates[0] as Uint8Array, updates[1] as Uint8Array, updates[2] as Uint8Array];
}

/**
 * Offsets at which truncating `bad` leaves a document already mutated when
 * `Y.applyUpdate` throws. These are the offsets that punish "apply onto the room
 * document until something throws, then keep what you have".
 */
function contaminatingOffsets(prefix: readonly Uint8Array[], bad: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let cut = 1; cut < bad.byteLength; cut += 1) {
    const doc = new Y.Doc();
    for (const frame of prefix) Y.applyUpdate(doc, frame);
    const before = doc.getMap("board").size;
    try {
      Y.applyUpdate(doc, bad.subarray(0, cut));
    } catch {
      if (doc.getMap("board").size !== before) offsets.push(cut);
    }
    doc.destroy();
  }
  return offsets;
}

async function quarantineFiles(dataDir: string, slug: string): Promise<string[]> {
  const names = await readdir(join(dataDir, "rooms"));
  return names.filter((name) => name.startsWith(`${slug}.log.corrupt.`));
}

describe("recovery", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(dataDir: string): Hub {
    const created = createHub({ port: 0, dataDir });
    hubs.add(created);
    return created;
  }

  async function seed(dataDir: string, slug: string, bytes: Buffer): Promise<void> {
    await mkdir(join(dataDir, "rooms"), { recursive: true });
    await writeFile(logPath(dataDir, slug), bytes);
  }

  afterEach(async () => {
    clients.closeAll();
    for (const created of hubs) await created.stop();
    hubs.clear();
    await dataDirs.removeAll();
  });

  it("loads the complete frames and cuts a truncated payload off the file (R3)", async () => {
    const [first, second] = threeUpdates();
    const dataDir = await dataDirs.create();
    const intact = encodeLog(CREATED_AT, [first]);
    await seed(
      dataDir,
      "alpha",
      Buffer.concat([
        intact,
        framePrefix(second.byteLength),
        Buffer.from(second.subarray(0, second.byteLength - 5)),
      ]),
    );

    const url = await hub(dataDir).start();
    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.provider.synced);

    expect(reader.doc.getMap("board").toJSON()).toEqual({ a: 1 });
    const repaired = await readFile(logPath(dataDir, "alpha"));
    expect(repaired.length).toBe(intact.length);
    expect(repaired.equals(intact)).toBe(true);
  });

  it("cuts stray bytes too short to be a length prefix off the file (R3)", async () => {
    const [first, second] = threeUpdates();
    const dataDir = await dataDirs.create();
    const intact = encodeLog(CREATED_AT, [first, second]);
    await seed(dataDir, "alpha", Buffer.concat([intact, Buffer.from([0xff, 0xff])]));

    const url = await hub(dataDir).start();
    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.provider.synced);

    expect(reader.doc.getMap("board").toJSON()).toEqual({ a: 1, b: 2 });
    const repaired = await readFile(logPath(dataDir, "alpha"));
    expect(repaired.equals(intact)).toBe(true);
  });

  it("keeps a repaired log appendable across a restart (R3)", async () => {
    const [first, second] = threeUpdates();
    const dataDir = await dataDirs.create();
    await seed(
      dataDir,
      "alpha",
      Buffer.concat([
        encodeLog(CREATED_AT, [first]),
        framePrefix(second.byteLength),
        Buffer.from(second.subarray(0, second.byteLength - 5)),
      ]),
    );

    const repaired = hub(dataDir);
    const url = await repaired.start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("added", "after-repair");
    await waitFor(async () => (await roomDocBytes(url, "alpha")) > 2);
    await repaired.stop();
    clients.closeAll();

    const restarted = hub(dataDir);
    const restartedUrl = await restarted.start();
    const reader = clients.open(restartedUrl, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("added") === "after-repair");

    expect(reader.doc.getMap("board").toJSON()).toEqual({ a: 1, added: "after-repair" });
  });

  it("quarantines the original and reopens on the good prefix when a frame is rejected (R4)", async () => {
    const [first, second, third] = threeUpdates();
    const dataDir = await dataDirs.create();
    const bad = third.subarray(0, third.byteLength - 10);
    const original = Buffer.concat([
      encodeLog(CREATED_AT, [first, second]),
      framePrefix(bad.byteLength),
      Buffer.from(bad),
    ]);
    await seed(dataDir, "alpha", original);

    const url = await hub(dataDir).start();
    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.provider.synced);

    expect(reader.doc.getMap("board").toJSON()).toEqual({ a: 1, b: 2 });

    const quarantined = await quarantineFiles(dataDir, "alpha");
    expect(quarantined).toHaveLength(1);
    const preserved = await readFile(join(dataDir, "rooms", quarantined[0] as string));
    expect(preserved.equals(original)).toBe(true);

    const log = await readLog(dataDir, "alpha");
    expect(log.trailing).toBe(0);
    expect(logBoard(log)).toEqual({ a: 1, b: 2 });
  });

  it("carries nothing from a rejected frame at any truncation offset (R4)", async () => {
    const [first, second, third] = threeUpdates();
    const dataDir = await dataDirs.create();
    await mkdir(join(dataDir, "rooms"), { recursive: true });

    // A rejected update can mutate its target before it throws. Sweeping one
    // arbitrary offset lands in the overwhelming majority that fail cleanly and
    // proves nothing, so every offset is opened — and the sweep is only
    // meaningful if some of them do contaminate a naive apply.
    const dangerous = contaminatingOffsets([first, second], third);
    expect(dangerous.length).toBeGreaterThan(0);

    const wrong: { cut: number; board: Record<string, unknown> }[] = [];
    for (let cut = 1; cut < third.byteLength; cut += 1) {
      const bad = third.subarray(0, cut);
      await writeFile(
        logPath(dataDir, "alpha"),
        Buffer.concat([
          encodeLog(CREATED_AT, [first, second]),
          framePrefix(bad.byteLength),
          Buffer.from(bad),
        ]),
      );

      const loaded = await loadRoomLog(dataDir, "alpha");
      const doc = new Y.Doc();
      if (loaded.state !== null) Y.applyUpdate(doc, loaded.state);
      const board = doc.getMap("board").toJSON();
      doc.destroy();
      if (board.a !== 1 || board.b !== 2 || Object.keys(board).length !== 2) {
        wrong.push({ cut, board });
      }
    }

    expect(wrong).toEqual([]);
  }, 60_000);

  it("keeps a recovered room writable across a restart (R4)", async () => {
    const [first, second, third] = threeUpdates();
    const dataDir = await dataDirs.create();
    const dangerous = contaminatingOffsets([first, second], third);
    const bad = third.subarray(0, dangerous[0] as number);
    await seed(
      dataDir,
      "alpha",
      Buffer.concat([
        encodeLog(CREATED_AT, [first, second]),
        framePrefix(bad.byteLength),
        Buffer.from(bad),
      ]),
    );

    const recovered = hub(dataDir);
    const url = await recovered.start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("added", "after-recovery");
    await waitFor(async () => (await roomDocBytes(url, "alpha")) > 2);
    await recovered.stop();
    clients.closeAll();

    const restarted = hub(dataDir);
    const restartedUrl = await restarted.start();
    const reader = clients.open(restartedUrl, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("added") === "after-recovery");

    expect(reader.doc.getMap("board").toJSON()).toEqual({ a: 1, b: 2, added: "after-recovery" });
  });
});
