import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hub } from "./index.ts";
import { createHub } from "./index.ts";
import {
  createClientPool,
  createDataDirPool,
  getJson,
  stopHubs,
  upgradeOutcome,
  waitFor,
} from "./test-helpers.ts";

describe("websocket routing", () => {
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

  it("refuses the handshake for a path outside the sync prefix (R4)", async () => {
    await expect(upgradeOutcome(url, "/nope")).resolves.toEqual({ kind: "handshake-failed" });
  });

  it("refuses the handshake for a bare /sync with no trailing slash (R4)", async () => {
    await expect(upgradeOutcome(url, "/sync")).resolves.toEqual({ kind: "handshake-failed" });
  });

  it("closes with 1008 when the slug does not match the room pattern (R4)", async () => {
    await expect(upgradeOutcome(url, "/sync/Not_A_Slug")).resolves.toEqual({
      kind: "closed",
      code: 1008,
    });
  });

  it("closes with 1008 on an empty slug and creates no room for it (R4)", async () => {
    await expect(upgradeOutcome(url, "/sync/")).resolves.toEqual({ kind: "closed", code: 1008 });
    await expect(getJson(url, "/__rooms")).resolves.toEqual({ rooms: [] });
  });

  it("resolves the room from the pathname when the URL carries a query string (R4)", async () => {
    const one = clients.open(url, "alpha", { token: "abc" });
    const two = clients.open(url, "alpha");
    expect(one.provider.url).toContain("?token=abc");

    await waitFor(() => one.provider.synced && two.provider.synced);
    one.doc.getMap("board").set("shape", "rect");

    await waitFor(() => two.doc.getMap("board").get("shape") === "rect");
    await expect(getJson(url, "/__rooms")).resolves.toMatchObject({
      rooms: [{ slug: "alpha", peers: 2 }],
    });
  });
});
