import { afterEach, describe, expect, it } from "vitest";
import type { Hub, HubOptions } from "./index";
import { createHub, DEFAULT_IDLE_PERIOD_MS } from "./index";
import {
  createClientPool,
  createDataDirPool,
  liveRooms,
  readLog,
  roomDocBytes,
  settle,
  stopHubs,
  waitFor,
} from "./test-helpers";

describe("idle eviction", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(options: HubOptions): Hub {
    const created = createHub({ port: 0, ...options });
    hubs.add(created);
    return created;
  }

  async function liveSlugs(url: string): Promise<string[]> {
    return (await liveRooms(url)).map((room) => room.slug);
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

  it("drops a room from memory once its idle period passes with no peers (R6)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub({ dataDir, idlePeriodMs: 80 }).start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await roomDocBytes(url, "alpha")) > 2);
    expect(await liveSlugs(url)).toEqual(["alpha"]);

    clients.closeAll();

    await waitFor(async () => (await liveSlugs(url)).length === 0);
    expect(await liveSlugs(url)).toEqual([]);
  });

  it("gives an evicted room's content back on the next connect (R6)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub({ dataDir, idlePeriodMs: 80 }).start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await roomDocBytes(url, "alpha")) > 2);
    clients.closeAll();
    await waitFor(async () => (await liveSlugs(url)).length === 0);

    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");

    expect(reader.doc.getMap("board").toJSON()).toEqual({ shape: "rect" });
  });

  it("collapses an evicted room's log to a single frame (R6)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub({ dataDir, idlePeriodMs: 80 }).start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);

    // Two flushes, so the log genuinely holds more than one frame when the last
    // peer leaves and there is something for eviction to collapse.
    writer.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1);
    writer.doc.getMap("board").set("colour", "red");
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 2);

    clients.closeAll();
    // A room leaves `/__rooms` the moment eviction starts; the flush and the
    // rewrite are what it is still doing after that.
    await waitFor(async () => (await liveSlugs(url)).length === 0);
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1);

    expect((await readLog(dataDir, "alpha")).frames).toHaveLength(1);
  });

  it("does not evict, or round-trip through disk, when a peer returns in time (R6)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub({ dataDir, idlePeriodMs: 400 }).start();
    const first = clients.open(url, "alpha");
    await waitFor(() => first.provider.synced);
    first.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1);
    first.doc.getMap("board").set("colour", "red");
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 2);

    clients.closeAll();
    await settle(150);
    const second = clients.open(url, "alpha");
    await waitFor(() => second.provider.synced);

    // Well past the deadline the disconnect would have set.
    const listed: string[][] = [];
    for (let sample = 0; sample < 40; sample += 1) {
      listed.push(await liveSlugs(url));
      await settle(15);
    }

    expect(listed.every((slugs) => slugs.includes("alpha"))).toBe(true);
    // Eviction always collapses the log; two frames still on disk mean the room
    // was never released and never reloaded.
    expect((await readLog(dataDir, "alpha")).frames).toHaveLength(2);
    expect(second.doc.getMap("board").toJSON()).toEqual({ shape: "rect", colour: "red" });
  });

  it("keeps a room for sixty seconds when no idle period is configured (R6)", async () => {
    const dataDir = await dataDirs.create();

    expect(hub({ dataDir }).idlePeriodMs).toBe(60_000);
    expect(DEFAULT_IDLE_PERIOD_MS).toBe(60_000);
  });
});
