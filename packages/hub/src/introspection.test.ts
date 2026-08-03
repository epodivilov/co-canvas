import { PROTOCOL_VERSION } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hub } from "./index.ts";
import { createHub } from "./index.ts";
import { createClientPool, createDataDirPool, getJson, stopHubs, waitFor } from "./test-helpers.ts";

interface RoomsPayload {
  rooms: Array<{ slug: string; peers: number; docBytes: number }>;
}

describe("introspection", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  let hub: Hub;
  let url: string;

  beforeEach(async () => {
    hub = createHub({ port: 0, dataDir: await dataDirs.create() });
    url = await hub.start();
  });

  afterEach(async () => {
    clients.closeAll();
    try {
      await stopHubs([hub]);
    } finally {
      // Unconditional: a scenario that failed with a hub mid-flush would
      // otherwise leave its directory behind in the OS temp dir forever.
      await dataDirs.removeAll();
    }
  });

  it("lists every live room with its peer count and document size (R6)", async () => {
    const alphaOne = clients.open(url, "alpha");
    const alphaTwo = clients.open(url, "alpha");
    const beta = clients.open(url, "beta");
    await waitFor(
      () => alphaOne.provider.synced && alphaTwo.provider.synced && beta.provider.synced,
    );

    alphaOne.doc.getMap("board").set("shape", "rect");
    await waitFor(() => alphaTwo.doc.getMap("board").get("shape") === "rect");

    const payload = (await getJson(url, "/__rooms")) as RoomsPayload;
    const bySlug = new Map(payload.rooms.map((room) => [room.slug, room]));

    expect([...bySlug.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(bySlug.get("alpha")?.peers).toBe(2);
    expect(bySlug.get("beta")?.peers).toBe(1);
    expect(typeof bySlug.get("alpha")?.docBytes).toBe("number");
    expect(typeof bySlug.get("beta")?.docBytes).toBe("number");
    expect(bySlug.get("alpha")?.docBytes).toBeGreaterThan(0);
  });

  it("keeps reporting the service identity and protocol version on /health (R6)", async () => {
    await expect(getJson(url, "/health")).resolves.toEqual({
      service: "co-canvas-hub",
      protocol: PROTOCOL_VERSION,
    });
  });
});
