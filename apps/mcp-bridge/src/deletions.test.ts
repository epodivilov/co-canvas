import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import {
  createHarness,
  roomElement,
  roomIds,
  roomScene,
  settle,
  textOf,
  waitFor,
  waitForCount,
} from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("delete_elements", () => {
  it("removes the entry rather than flagging it deleted (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: ["one", "two", "three"].map((id, n) => ({
        type: "rectangle",
        id,
        x: n * 100,
        y: 0,
        width: 50,
        height: 50,
      })),
    });
    await waitForCount(peer, 3);

    const result = await bridge.call("delete_elements", { slug: "alpha", ids: ["two"] });

    expect(result.isError).toBeFalsy();
    await waitForCount(peer, 2);
    expect(roomIds(peer.doc)).toEqual(["one", "three"]);
    expect(roomScene(peer.doc).some((element) => element.isDeleted === true)).toBe(false);
    expect(result.structuredContent).toMatchObject({ ids: ["two"] });
  });

  it("takes a container's bound label with it (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });
    await waitForCount(peer, 2);

    await bridge.call("delete_elements", { slug: "alpha", ids: ["box"] });

    await waitForCount(peer, 0);
    expect(roomScene(peer.doc)).toEqual([]);
  });

  it("leaves no binding pointing at a shape that is gone (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "left", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "right", x: 300, y: 0, width: 100, height: 100 },
        { type: "arrow", id: "flow", start: { id: "left" }, end: { id: "right" } },
      ],
    });
    await waitForCount(peer, 3);

    await bridge.call("delete_elements", { slug: "alpha", ids: ["left"] });

    await waitForCount(peer, 2);
    const arrow = roomElement(peer.doc, "flow");
    expect(arrow).toBeDefined();
    expect(arrow?.startBinding).toBeNull();
    expect(arrow?.endBinding).toMatchObject({ elementId: "right" });
    expect(roomElement(peer.doc, "right")?.boundElements).toEqual([{ id: "flow", type: "arrow" }]);
  });

  it("frees a deleted frame's children instead of taking them with it (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "one", x: 0, y: 0, width: 50, height: 50 },
        { type: "rectangle", id: "two", x: 100, y: 100, width: 50, height: 50 },
        { type: "frame", id: "group", children: ["one", "two"] },
      ],
    });
    await waitForCount(peer, 3);

    await bridge.call("delete_elements", { slug: "alpha", ids: ["group"] });

    await waitForCount(peer, 2);
    expect(roomIds(peer.doc)).toEqual(["one", "two"]);
    expect(roomElement(peer.doc, "one")?.frameId).toBeNull();
    expect(roomElement(peer.doc, "two")?.frameId).toBeNull();
  });

  it("refuses a delete naming an id the room does not hold (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "one", x: 0, y: 0, width: 50, height: 50 },
        { type: "rectangle", id: "two", x: 100, y: 0, width: 50, height: 50 },
      ],
    });
    await waitForCount(peer, 2);

    const result = await bridge.call("delete_elements", {
      slug: "alpha",
      ids: ["one", "phantom"],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("phantom");
    await settle();
    expect(roomIds(peer.doc)).toEqual(["one", "two"]);
    await waitFor(
      () => roomScene(peer.doc).length === 2,
      "the room changed after a refused delete",
    );
  });
});
