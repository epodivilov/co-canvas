import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index";
import { createHub } from "./index";
import { createClientPool, settle, waitFor } from "./test-helpers";

describe("document sync", () => {
  const clients = createClientPool();
  let hub: Hub | null = null;

  afterEach(async () => {
    clients.closeAll();
    await hub?.stop();
    hub = null;
  });

  async function startHub(): Promise<string> {
    hub = createHub({ port: 0 });
    return await hub.start();
  }

  it("relays an update to the room's other peer and to no one else (R1)", async () => {
    const url = await startHub();

    const alphaOne = clients.open(url, "alpha");
    const alphaTwo = clients.open(url, "alpha");
    const beta = clients.open(url, "beta");
    await waitFor(
      () => alphaOne.provider.synced && alphaTwo.provider.synced && beta.provider.synced,
    );

    alphaOne.doc.getMap("board").set("shape", "rect");

    await waitFor(() => alphaTwo.doc.getMap("board").get("shape") === "rect");
    // Give a wrongly addressed broadcast time to arrive before ruling it out.
    await settle(150);
    expect(beta.doc.getMap("board").size).toBe(0);
  });

  it("converges when two peers of a room write concurrently (R1)", async () => {
    const url = await startHub();

    const one = clients.open(url, "alpha");
    const two = clients.open(url, "alpha");
    await waitFor(() => one.provider.synced && two.provider.synced);

    one.doc.getMap("board").set("from-one", 1);
    two.doc.getMap("board").set("from-two", 2);

    await waitFor(() => one.doc.getMap("board").size === 2 && two.doc.getMap("board").size === 2);
    expect([...one.doc.getMap("board").keys()].sort()).toEqual(["from-one", "from-two"]);
    expect([...two.doc.getMap("board").keys()].sort()).toEqual(["from-one", "from-two"]);
  });

  it("hands a late joiner the room's existing state without any new write (R2)", async () => {
    const url = await startHub();

    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("shape", "rect");
    // Let the update land in the room before the only peer holding it leaves.
    await settle(150);
    writer.close();

    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.provider.synced);
    await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");
    expect(reader.doc.getMap("board").get("shape")).toBe("rect");
  });
});
