import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Hub } from "./index";
import { createHub } from "./index";
import {
  activeTimers,
  createClientPool,
  createDataDirPool,
  getJson,
  liveRooms,
  openRawClient,
  rawGet,
  stopHubs,
  waitFor,
} from "./test-helpers";

describe("lifecycle", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  let hub: Hub | null = null;

  afterEach(async () => {
    clients.closeAll();
    try {
      await stopHubs(hub === null ? [] : [hub]);
    } finally {
      hub = null;
      // Unconditional: a scenario that failed with a hub mid-flush would
      // otherwise leave its directory behind in the OS temp dir forever.
      await dataDirs.removeAll();
    }
  });

  it("binds an OS-assigned port and reports it in the URL (R7)", async () => {
    hub = createHub({ port: 0, dataDir: await dataDirs.create() });

    const url = await hub.start();

    const boundPort = Number(new URL(url).port);
    expect(boundPort).toBeGreaterThan(0);
    await expect(rawGet(url, "/health")).resolves.toMatchObject({ status: 200 });
  });

  it("closes live sockets on stop and comes back up able to serve (R7)", async () => {
    hub = createHub({ port: 0, dataDir: await dataDirs.create() });
    const url = await hub.start();
    const before = clients.open(url, "alpha");
    await waitFor(() => before.provider.wsconnected);

    await hub.stop();

    await waitFor(() => !before.provider.wsconnected);
    const restartedUrl = await hub.start();
    await expect(rawGet(restartedUrl, "/health")).resolves.toMatchObject({ status: 200 });

    // The previous run's rooms are gone, not merely unreachable. A registry that
    // emptied nothing would hand `alpha` back on the next connect — a room whose
    // `Y.Doc` and `Awareness` `destroy()` has already unhooked, so peers would
    // join it and never hear from each other again.
    await expect(getJson(restartedUrl, "/__rooms")).resolves.toEqual({ rooms: [] });

    const one = clients.open(restartedUrl, "alpha");
    const two = clients.open(restartedUrl, "alpha");
    await waitFor(() => one.provider.synced && two.provider.synced);
    one.doc.getMap("board").set("shape", "rect");

    await waitFor(() => two.doc.getMap("board").get("shape") === "rect");
    expect(two.doc.getMap("board").get("shape")).toBe("rect");
  });

  it("hands back the timers its rooms hold, so the host process can exit (R7)", async () => {
    hub = createHub({ port: 0, dataDir: await dataDirs.create() });
    const url = await hub.start();

    // Raw sockets rather than `y-websocket` clients: a provider schedules a
    // reconnect timer of its own the moment it closes, and waiting that out
    // would put a sleep in the middle of a timer measurement.
    const peers = await Promise.all([
      openRawClient(url, "/sync/alpha"),
      openRawClient(url, "/sync/beta"),
    ]);
    // A room is registered once it has been read off disk, which is a turn of
    // the event loop after the socket opened.
    await waitFor(async () => (await liveRooms(url)).length === 2);
    await expect(getJson(url, "/__rooms")).resolves.toMatchObject({
      rooms: [{ slug: "alpha" }, { slug: "beta" }],
    });
    for (const peer of peers) peer.close();
    await waitFor(() => peers.every((peer) => peer.socket.readyState === WebSocket.CLOSED));

    const whileRunning = activeTimers();
    await hub.stop();

    // `activeTimers()` reads a process-wide count, so this is measured as a
    // delta across `stop()` and unrelated handles cancel out. It does assume the
    // runner gives each test file its own process — vitest's default — and would
    // read other files' timers under `pool: "threads"` with `isolate: false`.
    //
    // Each room's `Awareness` runs a keepalive interval that only `destroy()`
    // clears, so a hub that leaves its rooms behind hands back nothing here and
    // keeps its host process alive after Ctrl-C.
    expect(whileRunning - activeTimers()).toBe(2);
  });

  it("releases the port it was serving on (R7)", async () => {
    hub = createHub({ port: 0, dataDir: await dataDirs.create() });
    const url = await hub.start();

    await hub.stop();

    await expect(rawGet(url, "/health")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
