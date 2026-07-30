import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import {
  createHarness,
  roomElement,
  roomIds,
  roomScene,
  settle,
  textOf,
  waitForCount,
} from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

const CHILDREN = [
  { type: "rectangle", id: "one", x: 0, y: 0, width: 50, height: 50 },
  { type: "rectangle", id: "two", x: 100, y: 100, width: 50, height: 50 },
];

describe("frames", () => {
  it("puts a frame's children immediately before it and names the frame on each (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "frame", id: "group", children: ["one", "two"], name: "Services" },
        ...CHILDREN,
      ],
    });

    await waitForCount(peer, 3);
    // The ordering invariant Excalidraw's own frame code documents and its
    // converter does not produce, asserted with the frame listed first so the
    // reordering is doing something.
    expect(roomIds(peer.doc)).toEqual(["one", "two", "group"]);
    expect(roomElement(peer.doc, "one")?.frameId).toBe("group");
    expect(roomElement(peer.doc, "two")?.frameId).toBe("group");
  });

  it("sizes a frame around its children when no box was given (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [...CHILDREN, { type: "frame", id: "group", children: ["one", "two"] }],
    });

    await waitForCount(peer, 3);
    const frame = roomElement(peer.doc, "group");
    // Children span (0,0)-(150,150); upstream's frame margin is 10 a side.
    expect(frame).toMatchObject({ x: -10, y: -10, width: 170, height: 170 });
  });

  it("keeps a frame box the caller did give (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        ...CHILDREN,
        {
          type: "frame",
          id: "group",
          children: ["one", "two"],
          x: -40,
          y: -30,
          width: 400,
          height: 300,
        },
      ],
    });

    await waitForCount(peer, 3);
    expect(roomElement(peer.doc, "group")).toMatchObject({
      x: -40,
      y: -30,
      width: 400,
      height: 300,
    });
  });

  it("keeps the members of a group next to each other (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "member-a",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          groupIds: ["pair"],
        },
        { type: "rectangle", id: "loner", x: 100, y: 0, width: 50, height: 50 },
        {
          type: "rectangle",
          id: "member-b",
          x: 200,
          y: 0,
          width: 50,
          height: 50,
          groupIds: ["pair"],
        },
      ],
    });

    await waitForCount(peer, 3);
    expect(roomIds(peer.doc)).toEqual(["member-a", "member-b", "loner"]);
    expect(roomElement(peer.doc, "member-a")?.groupIds).toEqual(["pair"]);
    expect(roomElement(peer.doc, "member-b")?.groupIds).toEqual(["pair"]);
    expect(roomElement(peer.doc, "loner")?.groupIds).toEqual([]);
  });

  it("refuses a frame naming a child that exists nowhere (R4, R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [CHILDREN[0], { type: "frame", id: "group", children: ["one", "phantom"] }],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("phantom");
    await settle();
    expect(roomScene(peer.doc)).toEqual([]);
  });
});
