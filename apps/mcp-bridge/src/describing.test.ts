import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { describeScene } from "./describe.ts";
import type { SceneElement } from "./elements.ts";
import { arrow, frame, label, note, radians, rect } from "./scene-helpers.ts";
import type { Harness, RoomPeer } from "./test-helpers.ts";
import { createHarness, hubRooms, settle, textOf, waitFor } from "./test-helpers.ts";

let harness: Harness;

/** One entry of `describe_scene`'s structured per-element geometry (CC-28). */
interface Shape {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  label: string | null;
  name: string | null;
  frameId: string | null;
  groupIds: string[];
  startBinding: string | null;
  endBinding: string | null;
  points: { x: number; y: number }[] | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function shapesOf(result: { structuredContent?: unknown }): Shape[] {
  return (result.structuredContent as { shapes: Shape[] }).shapes;
}

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
      // CC-28: the same geometry the GEOMETRY appendix reports, as JSON the
      // agent computes placement from. Bound labels are folded into their
      // container, exactly as the text folds them.
      shapes: [
        {
          id: "auth",
          type: "rectangle",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          angle: 0,
          label: "Auth",
          name: null,
          frameId: null,
          groupIds: [],
          startBinding: null,
          endBinding: null,
          points: null,
          bounds: { minX: 100, minY: 100, maxX: 300, maxY: 200 },
        },
        {
          id: "store",
          type: "rectangle",
          x: 600,
          y: 100,
          width: 200,
          height: 100,
          angle: 0,
          label: "Store",
          name: null,
          frameId: null,
          groupIds: [],
          startBinding: null,
          endBinding: null,
          points: null,
          bounds: { minX: 600, minY: 100, maxX: 800, maxY: 200 },
        },
        {
          id: "writes",
          type: "arrow",
          x: 300,
          y: 150,
          width: 300,
          height: 0,
          angle: 0,
          label: null,
          name: null,
          frameId: null,
          groupIds: [],
          startBinding: "auth",
          endBinding: "store",
          points: [
            { x: 300, y: 150 },
            { x: 600, y: 150 },
          ],
          bounds: { minX: 300, minY: 150, maxX: 600, maxY: 150 },
        },
      ],
    });
  });

  it("carries every element's geometry in the summary, without re-emitting the prose (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    writeElements(peer, TWO_AND_AN_ARROW);

    const result = await bridge.call("describe_scene", { slug: "alpha" });

    // CC-28 reverses the old invariant: the summary now carries every element
    // the text describes — id, type, box and label — so the agent can compute
    // intersections rather than parse them out of prose.
    const shapes = shapesOf(result);
    expect(shapes.map((shape) => shape.id)).toEqual(["auth", "store", "writes"]);

    const auth = shapes.find((shape) => shape.id === "auth");
    expect(auth).toMatchObject({
      type: "rectangle",
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      label: "Auth",
    });

    const writes = shapes.find((shape) => shape.id === "writes");
    expect(writes).toMatchObject({ type: "arrow", startBinding: "auth", endBinding: "store" });
    // Absolute endpoints, not the near-origin relative pairs.
    expect(writes?.points).toEqual([
      { x: 300, y: 150 },
      { x: 600, y: 150 },
    ]);

    // What stays out is the prose: the split's point is not to send the rendered
    // headings, grid and geometry lines a second time as strings.
    const summary = JSON.stringify(result.structuredContent);
    for (const heading of ["SCENE", "NODES", "GRID", "CONTAINERS", "GEOMETRY"]) {
      expect(summary, `summary re-emits ${heading}`).not.toContain(heading);
    }
  });

  it("carries a framed node's frame and a grouped pair's groups (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    writeElements(peer, [
      frame("board", 0, 0, 400, 300, "Board"),
      rect("inside", 40, 40, 120, 80, { frameId: "board" }),
      rect("left", 600, 0, 120, 80, { groupIds: ["pair"] }),
      rect("right", 600, 120, 120, 80, { groupIds: ["pair"] }),
    ]);

    const result = await bridge.call("describe_scene", { slug: "alpha" });
    const shapes = shapesOf(result);

    expect(shapes.find((shape) => shape.id === "inside")?.frameId).toBe("board");
    expect(shapes.find((shape) => shape.id === "left")?.groupIds).toEqual(["pair"]);
    expect(shapes.find((shape) => shape.id === "right")?.groupIds).toEqual(["pair"]);
  });

  it("carries a loose note as text, and claims no binding an arrow does not have (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    writeElements(peer, [
      note("memo", 10, 10, "Remember this"),
      arrow("floating", 0, 200, [
        [0, 0],
        [100, 0],
      ]),
    ]);

    const result = await bridge.call("describe_scene", { slug: "alpha" });
    const shapes = shapesOf(result);

    const memo = shapes.find((shape) => shape.id === "memo");
    expect(memo?.type).toBe("text");
    expect(memo?.label).toBe("Remember this");

    const floating = shapes.find((shape) => shape.id === "floating");
    expect(floating?.startBinding).toBeNull();
    expect(floating?.endBinding).toBeNull();
  });

  it("carries a turned element's rotated footprint and an arrow's rotated points (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    // A quarter turn about each element's own centre.
    writeElements(peer, [
      rect("turned", 0, 0, 200, 100, { angle: radians(90) }),
      arrow(
        "skew",
        0,
        0,
        [
          [0, 0],
          [100, 0],
        ],
        {},
        { angle: radians(90) },
      ),
    ]);

    const result = await bridge.call("describe_scene", { slug: "alpha" });
    const shapes = shapesOf(result);

    const turned = shapes.find((shape) => shape.id === "turned");
    expect(turned?.angle).toBeCloseTo(radians(90));
    // The stored box is untouched — that is the box a caller writes back (R4).
    expect(turned).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });
    // `bounds` is the rotated footprint, and for a turned element it differs: a
    // 200x100 box on a quarter turn spans 100 wide by 200 tall about (100,50).
    // De-overlap has to test against this, not against the stored box.
    expect(turned?.bounds?.minX).toBeCloseTo(50);
    expect(turned?.bounds?.minY).toBeCloseTo(-50);
    expect(turned?.bounds?.maxX).toBeCloseTo(150);
    expect(turned?.bounds?.maxY).toBeCloseTo(150);
    expect(turned?.bounds).not.toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });

    // The arrow's points come out rotated into absolute scene coordinates: a
    // horizontal segment turned a quarter turn stands vertical.
    const skew = shapes.find((shape) => shape.id === "skew");
    expect(skew?.points).toHaveLength(2);
    expect(skew?.points?.[0]?.x).toBeCloseTo(50);
    expect(skew?.points?.[0]?.y).toBeCloseTo(-50);
    expect(skew?.points?.[1]?.x).toBeCloseTo(50);
    expect(skew?.points?.[1]?.y).toBeCloseTo(50);
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
      shapes: [],
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
