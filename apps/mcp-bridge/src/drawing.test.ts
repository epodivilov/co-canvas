import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import {
  createHarness,
  hubRooms,
  roomEntries,
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

describe("add_elements", () => {
  it("writes a rectangle where it was asked for (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "rectangle", x: 40, y: 60, width: 120, height: 80 }],
    });

    expect(result.isError).toBeFalsy();
    await waitForCount(peer, 1);
    expect(roomScene(peer.doc)[0]).toMatchObject({
      type: "rectangle",
      x: 40,
      y: 60,
      width: 120,
      height: 80,
    });
    expect(result.structuredContent).toMatchObject({
      slug: "alpha",
      ids: [roomIds(peer.doc)[0]],
    });
  });

  it("writes every element type it accepts, in the order given (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "rect", x: 0, y: 0, width: 100, height: 60 },
        { type: "ellipse", id: "oval", x: 200, y: 0, width: 100, height: 60 },
        { type: "diamond", id: "gem", x: 400, y: 0, width: 100, height: 60 },
        { type: "text", id: "label", x: 0, y: 200, text: "hello" },
        { type: "line", id: "rule", x: 0, y: 300, width: 200, height: 0 },
        { type: "arrow", id: "point", x: 0, y: 400, width: 200, height: 0 },
      ],
    });

    expect(result.isError).toBeFalsy();
    await waitForCount(peer, 6);
    expect(roomIds(peer.doc)).toEqual(["rect", "oval", "gem", "label", "rule", "point"]);
    expect(result.structuredContent).toMatchObject({
      ids: ["rect", "oval", "gem", "label", "rule", "point"],
    });

    // Every one carries the fields its type declares, not just the ones asked for.
    for (const element of roomScene(peer.doc)) {
      for (const field of ["seed", "version", "versionNonce", "updated", "isDeleted", "angle"]) {
        expect(element, `${String(element.id)} is missing ${field}`).toHaveProperty(field);
      }
    }
    const text = roomScene(peer.doc).find((element) => element.id === "label");
    expect(text).toHaveProperty("originalText");
    expect(text).toHaveProperty("lineHeight");
    const arrow = roomScene(peer.doc).find((element) => element.id === "point");
    expect(arrow).toHaveProperty("points");
    expect(arrow).toHaveProperty("startBinding");
    expect(arrow).toHaveProperty("endArrowhead");
  });

  it("sorts a new element after everything already in the room (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "one", x: 0, y: 0, width: 50, height: 50 },
        { type: "rectangle", id: "two", x: 60, y: 0, width: 50, height: 50 },
      ],
    });
    await waitForCount(peer, 2);
    const before = roomEntries(peer.doc);

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "rectangle", id: "three", x: 120, y: 0, width: 50, height: 50 }],
    });
    await waitForCount(peer, 3);

    const after = roomEntries(peer.doc);
    expect(after.map((entry) => entry.el.id)).toEqual(["one", "two", "three"]);
    expect((after[2]?.pos ?? "") > (after[1]?.pos ?? "")).toBe(true);
    // The two that were already there are untouched, `pos` included.
    expect(after.slice(0, 2)).toEqual(before);
  });

  it("lands the whole call in one transaction (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    // A half-drawn diagram must never be observable, so what is counted is not
    // the elements but the transactions they arrived in.
    const sizes: number[] = [];
    const array = peer.doc.getArray("elements");
    array.observe(() => sizes.push(array.length));

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [0, 1, 2, 3, 4].map((n) => ({
        type: "rectangle",
        id: `r${n}`,
        x: n * 60,
        y: 0,
        width: 50,
        height: 50,
      })),
    });

    await waitForCount(peer, 5);
    await settle();
    expect(sizes).toEqual([5]);
  });

  it("refuses a room the hub does not hold and points at create_room (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const result = await bridge.call("add_elements", {
      slug: "ghost",
      elements: [{ type: "rectangle", x: 0, y: 0, width: 50, height: 50 }],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ghost");
    expect(textOf(result)).toContain("create_room");
    // Not created as a side effect of being written to.
    await settle();
    expect(await hubRooms(hub.url)).toEqual([]);
  });
});

describe("ids and atomicity", () => {
  it("keeps an agent's own id verbatim and lets a later call bind to it (R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "rectangle", id: "auth-service", x: 0, y: 0, width: 100, height: 100 }],
    });
    await waitForCount(peer, 1);
    expect(roomIds(peer.doc)).toEqual(["auth-service"]);

    const second = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "gateway", x: 300, y: 0, width: 100, height: 100 },
        { type: "arrow", id: "link", start: { id: "auth-service" }, end: { id: "gateway" } },
      ],
    });

    expect(second.isError).toBeFalsy();
    await waitForCount(peer, 3);
    const arrow = roomScene(peer.doc).find((element) => element.id === "link");
    expect(arrow?.startBinding).toMatchObject({ elementId: "auth-service" });
  });

  it("refuses an id the room already holds and writes nothing (R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "rectangle", id: "auth-service", x: 0, y: 0, width: 100, height: 100 }],
    });
    await waitForCount(peer, 1);

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "ellipse", id: "auth-service", x: 300, y: 0, width: 100, height: 100 }],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("auth-service");
    // Refused before anything is converted, and told what to do instead —
    // there is a second, blunter check behind this one for ids the conversion
    // generates, and it is not the one an agent should be reading.
    expect(textOf(result)).toContain("update_elements");
    await settle();
    expect(roomScene(peer.doc)).toHaveLength(1);
    expect(roomScene(peer.doc)[0]?.type).toBe("rectangle");
  });

  it("refuses one call that names the same id twice (R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "twin", x: 0, y: 0, width: 50, height: 50 },
        { type: "rectangle", id: "twin", x: 60, y: 0, width: 50, height: 50 },
      ],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("twin");
    await settle();
    expect(roomScene(peer.doc)).toEqual([]);
  });

  it("applies nothing when one element of a valid batch is unusable (R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 50, height: 50 },
        { type: "rectangle", id: "b", x: 60, y: 0, width: 50, height: 50 },
        { type: "rectangle", id: "c", x: 120, y: 0, width: 50, height: 50 },
        { type: "octagon", id: "d", x: 180, y: 0, width: 50, height: 50 },
      ],
    });

    expect(result.isError).toBe(true);
    await settle();
    expect(roomScene(peer.doc)).toEqual([]);
  });

  it("generates a distinct id for every element that carries none (R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: Array.from({ length: 10 }, (_, n) => ({
        type: "rectangle",
        x: n * 60,
        y: 0,
        width: 50,
        height: 50,
      })),
    });

    expect(result.isError).toBeFalsy();
    const ids = (result.structuredContent as { ids: string[] }).ids;
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    await waitForCount(peer, 10);
    expect(new Set(roomIds(peer.doc))).toEqual(new Set(ids));
  });
});
