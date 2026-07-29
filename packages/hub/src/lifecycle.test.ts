import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index";
import { createHub } from "./index";
import { createClientPool, rawGet, waitFor } from "./test-helpers";

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

  it("releases the port it was serving on (R7)", async () => {
    hub = createHub({ port: 0 });
    const url = await hub.start();

    await hub.stop();

    await expect(rawGet(url, "/health")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
