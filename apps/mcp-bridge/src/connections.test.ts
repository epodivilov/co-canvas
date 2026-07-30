import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import { createHarness, hubPeers, settle, waitFor } from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("room connections", () => {
  it("holds one connection per room however many calls address it (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    await bridge.call("create_room", { slug: "alpha" });
    await bridge.call("create_room", { slug: "alpha" });
    await bridge.call("open_room", { slug: "alpha", open: false });

    // A settle here would hide nothing and catch a late second socket.
    await settle();
    expect(await hubPeers(hub.url, "alpha")).toBe(1);
  });

  it("does not join a room just because open_room was asked about it (R6)", async () => {
    const hub = await harness.startHub();
    await harness.openPeer(hub.url, "alpha");
    const bridge = await harness.connect({ hubPort: hub.port });

    await bridge.call("open_room", { slug: "alpha", open: false });

    // Still the one peer the scenario opened. open_room answers from the room
    // listing over HTTP; joining a board nobody asked it to edit would put the
    // bridge on every board a human ever mentioned.
    await settle();
    expect(await hubPeers(hub.url, "alpha")).toBe(1);
  });

  it("drops every room connection when the bridge closes (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    await bridge.call("create_room", { slug: "beta" });
    expect(await hubPeers(hub.url, "alpha")).toBe(1);

    // Closing, not exiting: a process that leaves on `process.exit` drops its
    // sockets whether or not it meant to, and would hide a shutdown that closes
    // nothing.
    await bridge.close();

    await waitFor(
      async () =>
        (await hubPeers(hub.url, "alpha")) === 0 && (await hubPeers(hub.url, "beta")) === 0,
      "the hub still reports the bridge as a peer after it closed",
    );
  });

  it("keys the cache per slug rather than collapsing rooms together (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    await bridge.call("create_room", { slug: "alpha" });
    await bridge.call("create_room", { slug: "beta" });

    await settle();
    expect(await hubPeers(hub.url, "alpha")).toBe(1);
    expect(await hubPeers(hub.url, "beta")).toBe(1);
  });
});
