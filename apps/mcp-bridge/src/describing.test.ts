import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { describeScene } from "./describe.ts";
import type { SceneElement } from "./elements.ts";
import { arrow, label, rect } from "./scene-helpers.ts";
import type { Harness, RoomPeer } from "./test-helpers.ts";
import { createHarness, hubRooms, settle, textOf, waitFor } from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/**
 * Writes elements into a room as another client would.
 *
 * Hand-rolled rather than routed through `elements.ts`, so a scenario that
 * describes a room is not reading it back through the same code that put it
 * there. The keys are padded so their string order is their insertion order.
 */
function writeElements(peer: RoomPeer, elements: readonly SceneElement[]): void {
  const yElements = peer.doc.getArray<Y.Map<unknown>>("elements");
  const start = yElements.length;
  peer.doc.transact(() => {
    for (const [index, element] of elements.entries()) {
      const entry = new Y.Map<unknown>();
      entry.set("pos", `a${String(start + index).padStart(3, "0")}`);
      entry.set("el", JSON.parse(JSON.stringify(element)) as SceneElement);
      yElements.push([entry]);
    }
  });
}

const TWO_AND_AN_ARROW: SceneElement[] = [
  rect("auth", 100, 100, 200, 100),
  label("auth-label", "auth", "Auth"),
  rect("store", 600, 100, 200, 100),
  label("store-label", "store", "Store"),
  arrow(
    "writes",
    300,
    150,
    [
      [0, 0],
      [300, 0],
    ],
    { from: "auth", to: "store" },
  ),
];

describe("describe_scene (R1)", () => {
  it("answers with the rendered description and a summary of the room", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    writeElements(peer, TWO_AND_AN_ARROW);

    const result = await bridge.call("describe_scene", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(describeScene(TWO_AND_AN_ARROW).text);
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      elements: 5,
      nodes: 2,
      arrows: 1,
      extent: { minX: 100, minY: 100, maxX: 800, maxY: 200 },
    });
  });

  it("keeps the description out of the summary, and every element with it", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    writeElements(peer, TWO_AND_AN_ARROW);

    const result = await bridge.call("describe_scene", { slug: "alpha" });
    const summary = JSON.stringify(result.structuredContent);

    // Sending the description twice would undo the format's whole cost
    // advantage, and an element in the summary is the same payload again.
    expect(summary).not.toContain("SCENE");
    expect(summary).not.toContain("NODES");
    for (const id of ["auth", "store", "writes", "auth-label"]) {
      expect(summary, `summary names ${id}`).not.toContain(id);
    }
    expect(summary).not.toContain("Auth");
    expect(summary).not.toContain("rectangle");
    // The extent is the only geometry allowed through.
    expect(summary).not.toContain("600");
  });

  it("re-reads the room on every call rather than caching a description", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    writeElements(peer, TWO_AND_AN_ARROW);

    const first = await bridge.call("describe_scene", { slug: "alpha" });
    expect(textOf(first)).not.toContain("cache");
    expect(textOf(first)).not.toContain("Later");

    writeElements(peer, [
      rect("later", 1200, 100, 200, 100),
      label("later-label", "later", "Later"),
    ]);

    await waitFor(async () => {
      const again = await bridge.call("describe_scene", { slug: "alpha" });
      return textOf(again).includes("Later");
    }, "the second description never picked up the element another client added");

    const second = await bridge.call("describe_scene", { slug: "alpha" });
    expect(textOf(second)).toContain("later");
    expect((second.structuredContent as { elements?: number }).elements).toBe(7);
  });

  it("refuses a room the hub does not hold, and does not create it by asking", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const result = await bridge.call("describe_scene", { slug: "ghost" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ghost");
    expect(textOf(result)).toContain("create_room");
    // Connecting is what makes the hub hold a room, so an empty listing is the
    // assertion that matters.
    await settle();
    expect(await hubRooms(hub.url)).toEqual([]);
  });

  it("refuses a slug the shared rule rejects and connects to nothing", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    const result = await bridge.call("describe_scene", { slug: "Not_A_Slug" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("lowercase letters, digits");
    await settle();
    expect((await hubRooms(hub.url)).map((room) => room.slug)).toEqual(["alpha"]);
  });

  it("describes a room that holds nothing at all", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    const result = await bridge.call("describe_scene", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result).toLowerCase()).toContain("empty");
    expect(result.structuredContent).toEqual({
      slug: "alpha",
      elements: 0,
      nodes: 0,
      arrows: 0,
      extent: null,
    });
  });

  it("offers describe_scene with a slug and nothing else to decide", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const { tools } = await bridge.client.listTools();
    const tool = tools.find((entry) => entry.name === "describe_scene");

    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["slug"]);
    expect(tool?.inputSchema.required).toEqual(["slug"]);
  });
});
