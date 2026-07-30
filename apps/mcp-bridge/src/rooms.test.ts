import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import {
  createHarness,
  FIXTURE_OPENER_RECORD,
  hubRooms,
  settle,
  textOf,
  waitFor,
} from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("list_rooms", () => {
  it("reports every live room with its board URL and peer count (R1)", async () => {
    const hub = await harness.startHub();
    await harness.openPeer(hub.url, "alpha");
    await harness.openPeer(hub.url, "alpha");
    await harness.openPeer(hub.url, "beta");

    const bridge = await harness.connect({ hubPort: hub.port });
    const result = await bridge.call("list_rooms");

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      rooms: [
        { slug: "alpha", url: `${hub.url}/room/alpha`, peers: 2 },
        { slug: "beta", url: `${hub.url}/room/beta`, peers: 1 },
      ],
    });
    expect(textOf(result)).toContain(`${hub.url}/room/alpha`);
    expect(textOf(result)).toContain(`${hub.url}/room/beta`);
  });

  it("reports an empty list rather than failing when the hub holds nothing (R1)", async () => {
    const hub = await harness.startHub();

    const bridge = await harness.connect({ hubPort: hub.port });
    const result = await bridge.call("list_rooms");

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ rooms: [] });
  });
});

describe("create_room", () => {
  it("makes the hub hold the room before the call returns (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const result = await bridge.call("create_room", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      url: `${hub.url}/room/alpha`,
      created: true,
    });
    // Deliberately no waiting and no retrying: an implementation that returns
    // before its socket has synced has not made the room exist yet.
    expect((await hubRooms(hub.url)).map((room) => room.slug)).toEqual(["alpha"]);
  });

  it("does not answer before the hub is actually holding the room (R2)", async () => {
    const hub = await harness.startHub();
    // Against a hub on loopback the assertion above is a race the scheduler
    // almost always loses: one HTTP round trip is long enough for a WebSocket
    // upgrade nobody waited for. Behind a proxy that holds everything the
    // bridge says for 300ms, "returned too early" stops being a matter of luck.
    const proxy = await harness.startLaggingProxy(hub.port, 300);
    const bridge = await harness.connect({ hubPort: proxy.port });

    const result = await bridge.call("create_room", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      url: `${proxy.url}/room/alpha`,
      created: true,
    });
    expect((await hubRooms(hub.url)).map((room) => room.slug)).toEqual(["alpha"]);
  }, 20_000);

  it("is idempotent and leaves an existing room's content intact (R2)", async () => {
    const hub = await harness.startHub();
    const peer = await harness.openPeer(hub.url, "alpha");
    peer.doc.getMap<string>("scratch").set("written-by", "another client");
    await waitFor(
      async () => (await hubRooms(hub.url)).some((room) => room.docBytes > 0),
      "the hub never received the other client's write",
    );

    const bridge = await harness.connect({ hubPort: hub.port });
    const result = await bridge.call("create_room", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      url: `${hub.url}/room/alpha`,
      created: false,
    });

    // Read the content back through a peer that joined afterwards, so what is
    // asserted is the hub's copy rather than a local doc nobody touched.
    const witness = await harness.openPeer(hub.url, "alpha");
    await waitFor(
      () => witness.doc.getMap<string>("scratch").get("written-by") === "another client",
      "the room lost the other client's content",
    );
    expect(peer.doc.getMap<string>("scratch").get("written-by")).toBe("another client");
  });
});

describe("open_room", () => {
  it("launches the opener on the board URL (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    const result = await bridge.call("open_room", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      url: `${hub.url}/room/alpha`,
      opened: true,
    });
    await waitFor(
      async () => (await harness.openedUrls()).length === 1,
      "the opener fixture never recorded a launch",
    );
    expect(await harness.openedUrls()).toEqual([`${hub.url}/room/alpha`]);
  });

  it("hands back the URL without launching anything when asked not to (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    const result = await bridge.call("open_room", { slug: "alpha", open: false });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      url: `${hub.url}/room/alpha`,
      opened: false,
    });
    await settle();
    expect(await harness.openedUrls()).toEqual([]);
  });

  it("still succeeds on a host whose opener does not exist (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({
      hubPort: hub.port,
      openCommand: { executable: `${FIXTURE_OPENER_RECORD}.does-not-exist`, args: [] },
    });
    await bridge.call("create_room", { slug: "alpha" });

    const result = await bridge.call("open_room", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      url: `${hub.url}/room/alpha`,
      opened: false,
    });
    expect(textOf(result)).toContain(`${hub.url}/room/alpha`);
  });

  it("fails on a slug the hub does not hold and points at create_room (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const result = await bridge.call("open_room", { slug: "ghost" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ghost");
    expect(textOf(result)).toContain("create_room");
    await settle();
    expect(await harness.openedUrls()).toEqual([]);
    expect(await hubRooms(hub.url)).toEqual([]);
  });
});
