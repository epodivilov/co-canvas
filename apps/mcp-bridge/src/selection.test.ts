import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Described } from "./describe.ts";
import { describeScene } from "./describe.ts";
import type { SceneElement } from "./elements.ts";
import { arrow, label, rect } from "./scene-helpers.ts";
import { resolveSelection } from "./selection.ts";
import type { Harness, RoomPeer } from "./test-helpers.ts";
import { createHarness, textOf, waitFor } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// the pure resolver
// ---------------------------------------------------------------------------

/** Four rectangles in a row, so a selection can name a subset of them. */
const FOUR: SceneElement[] = [
  rect("a", 0, 0, 100, 100),
  rect("b", 200, 0, 100, 100),
  rect("c", 400, 0, 100, 100),
  rect("d", 600, 0, 100, 100),
];

/** The scene as `describe_scene`'s per-element geometry — what the resolver filters. */
function shapesOf(scene: SceneElement[]): readonly Described[] {
  return describeScene(scene).shapes;
}

/** One peer's awareness state carrying a selection, in the shape y-excalidraw publishes. */
function selecting(selected: Record<string, boolean>): Record<string, unknown> {
  return { selectedElementIds: selected };
}

describe("resolveSelection (pure)", () => {
  it("returns exactly the selected elements' shapes with full geometry (R1)", () => {
    const shapes = shapesOf(FOUR);
    const states = new Map<number, Record<string, unknown>>([[2, selecting({ a: true, c: true })]]);

    const result = resolveSelection(states, 1, shapes);

    expect(result.humanPresent).toBe(true);
    expect(result.shapes.map((shape) => shape.id)).toEqual(["a", "c"]);
    const a = result.shapes.find((shape) => shape.id === "a");
    expect(a).toMatchObject({ type: "rectangle", x: 0, y: 0, width: 100, height: 100, angle: 0 });
    expect(a?.bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it("returns the de-duplicated union across peers and drops the self state (R2)", () => {
    const shapes = shapesOf(FOUR);
    const states = new Map<number, Record<string, unknown>>([
      // The self state selects `d`; nothing it alone selects may leak into the result.
      [1, selecting({ d: true })],
      [2, selecting({ a: true, b: true })],
      [3, selecting({ b: true, c: true })],
    ]);

    const result = resolveSelection(states, 1, shapes);

    expect(result.humanPresent).toBe(true);
    // Union of the two remote states, deduped, in document order — not the self's `d`.
    expect(result.shapes.map((shape) => shape.id)).toEqual(["a", "b", "c"]);
    expect(result.shapes.map((shape) => shape.id)).not.toContain("d");
  });

  it("tells no human present apart from a present peer with an empty selection (R3)", () => {
    const shapes = shapesOf(FOUR);

    // (a) no remote state at all — the bridge's own state is the only one.
    const selfOnly = resolveSelection(
      new Map<number, Record<string, unknown>>([[1, selecting({ a: true })]]),
      1,
      shapes,
    );
    // The same case with no state whatsoever.
    const empty = resolveSelection(new Map<number, Record<string, unknown>>(), 1, shapes);

    // (b) one remote peer whose selection is empty.
    const emptySelection = resolveSelection(
      new Map<number, Record<string, unknown>>([[2, selecting({})]]),
      1,
      shapes,
    );

    expect(selfOnly.humanPresent).toBe(false);
    expect(selfOnly.shapes).toEqual([]);
    expect(empty.humanPresent).toBe(false);
    expect(empty.shapes).toEqual([]);

    expect(emptySelection.humanPresent).toBe(true);
    expect(emptySelection.shapes).toEqual([]);

    // The two empty results are distinguishable — the whole point of R3.
    expect(selfOnly.humanPresent).not.toBe(emptySelection.humanPresent);
  });

  it("treats an absent selectedElementIds field as an empty selection (R3)", () => {
    const shapes = shapesOf(FOUR);
    const result = resolveSelection(new Map<number, Record<string, unknown>>([[2, {}]]), 1, shapes);
    expect(result.humanPresent).toBe(true);
    expect(result.shapes).toEqual([]);
  });

  it("omits a selected id that no longer resolves to a scene element (R4)", () => {
    const shapes = shapesOf(FOUR);
    const states = new Map<number, Record<string, unknown>>([
      [2, selecting({ a: true, ghost: true })],
    ]);

    const result = resolveSelection(states, 1, shapes);

    // The stale `ghost` is dropped rather than errored, and `a` still comes back.
    expect(result.shapes.map((shape) => shape.id)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// the MCP tool
// ---------------------------------------------------------------------------

/** One entry of the tool's structured per-element geometry, as a test compares it. */
interface Shape {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Writes elements into a room as another client would — hand-rolled, so a
 * scenario that reads a selection back is not routed through the code that put
 * the elements there.
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

describe("get_selection (R5)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("answers with a text block and structured content for a human's live selection", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    const peer = await harness.openPeer(hub.url, "alpha");
    writeElements(peer, TWO_AND_AN_ARROW);
    // The human selects two of the boxes — the shape y-excalidraw publishes.
    peer.provider.awareness.setLocalStateField("selectedElementIds", { auth: true, store: true });

    // Awareness is a separate frame from doc sync, so the human's selection lands
    // a tick after the elements do; poll until the tool sees both.
    await waitFor(async () => {
      const pending = await bridge.call("get_selection", { slug: "alpha" });
      const shapes = (pending.structuredContent as { shapes?: unknown[] } | undefined)?.shapes;
      return Array.isArray(shapes) && shapes.length === 2;
    }, "get_selection never reported the human's two selected elements");

    const result = await bridge.call("get_selection", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    // A text block a text-only harness can render.
    expect(textOf(result)).toContain("auth");

    const structured = result.structuredContent as {
      slug: string;
      humanPresent: boolean;
      selected: number;
      shapes: Shape[];
    };
    expect(structured.slug).toBe("alpha");
    expect(structured.humanPresent).toBe(true);
    expect(structured.selected).toBe(2);
    expect(structured.shapes.map((shape) => shape.id).sort()).toEqual(["auth", "store"]);

    // The per-element geometry is the same object describe_scene emits (R1).
    const auth = structured.shapes.find((shape) => shape.id === "auth");
    expect(auth).toMatchObject({
      type: "rectangle",
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      label: "Auth",
    });
    expect(auth?.bounds).toEqual({ minX: 100, minY: 100, maxX: 300, maxY: 200 });
  });

  it("reports no human present when the board has no other peer (R3/R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    const result = await bridge.call("get_selection", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { humanPresent: boolean; shapes: unknown[] };
    expect(structured.humanPresent).toBe(false);
    expect(structured.shapes).toEqual([]);
    expect(textOf(result).toLowerCase()).toContain("no one");
  });

  it("refuses a room the hub does not hold, and does not create it by asking", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const result = await bridge.call("get_selection", { slug: "ghost" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ghost");
    expect(textOf(result)).toContain("create_room");
    void hub;
  });

  it("offers get_selection with a slug and a declared output schema (R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    void hub;

    const { tools } = await bridge.client.listTools();
    const tool = tools.find((entry) => entry.name === "get_selection");

    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["slug"]);
    expect(tool?.inputSchema.required).toEqual(["slug"]);
    // A declared output schema, consistent with the other bridge tools (R5).
    expect(tool?.outputSchema).toBeDefined();
    expect(Object.keys(tool?.outputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(["slug", "humanPresent", "shapes"]),
    );
  });
});
