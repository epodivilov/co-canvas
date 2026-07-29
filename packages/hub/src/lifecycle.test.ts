import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index";
import { createHub } from "./index";
import { activeTimers, createClientPool, getJson, rawGet, settle, waitFor } from "./test-helpers";

describe("lifecycle", () => {
  const clients = createClientPool();
  let hub: Hub | null = null;

  afterEach(async () => {
    clients.closeAll();
    await hub?.stop();
    hub = null;
  });

  it("binds an OS-assigned port and reports it in the URL (R7)", async () => {
    hub = createHub({ port: 0 });

    const url = await hub.start();

    const boundPort = Number(new URL(url).port);
    expect(boundPort).toBeGreaterThan(0);
    await expect(rawGet(url, "/health")).resolves.toMatchObject({ status: 200 });
  });

  it("closes live sockets on stop and can be started again (R7)", async () => {
    hub = createHub({ port: 0 });
    const url = await hub.start();
    const client = clients.open(url, "alpha");
    await waitFor(() => client.provider.wsconnected);

    await hub.stop();

    await waitFor(() => !client.provider.wsconnected);
    const restartedUrl = await hub.start();
    await expect(rawGet(restartedUrl, "/health")).resolves.toMatchObject({ status: 200 });
  });

  it("hands back the timers its rooms hold, so the host process can exit (R7)", async () => {
    hub = createHub({ port: 0 });
    const url = await hub.start();
    for (const slug of ["alpha", "beta"]) {
      const client = clients.open(url, slug);
      await waitFor(() => client.provider.synced);
      client.close();
    }
    // Let the reconnect timer `y-websocket` schedules on close lapse, so the
    // only timers left in flight belong to the hub.
    await settle(400);
    await expect(getJson(url, "/__rooms")).resolves.toMatchObject({
      rooms: [{ slug: "alpha" }, { slug: "beta" }],
    });

    const whileRunning = activeTimers();
    await hub.stop();

    // Measured across `stop()` rather than against an absolute, so unrelated
    // handles in the worker cancel out. Each room's `Awareness` runs a keepalive
    // interval that only `destroy()` clears; a hub that leaves its rooms behind
    // gives back nothing here and keeps the process alive after Ctrl-C.
    expect(whileRunning - activeTimers()).toBe(2);
  });

  it("releases the port it was serving on (R7)", async () => {
    hub = createHub({ port: 0 });
    const url = await hub.start();

    await hub.stop();

    await expect(rawGet(url, "/health")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
