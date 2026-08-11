import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeClient, Harness } from "./test-helpers.ts";
import {
  BOUND_TEXT_PADDING,
  createHarness,
  roomElement,
  roomScene,
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

/** A min/max box, as describe_scene reports each element's rotated footprint. */
interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Every element's rotated bounds, read back through describe_scene (CC-28). */
async function boundsById(bridge: BridgeClient, slug: string): Promise<Map<string, Bounds>> {
  const result = await bridge.call("describe_scene", { slug });
  const shapes = (result.structuredContent as { shapes: { id: string; bounds: Bounds }[] }).shapes;
  return new Map(shapes.map((shape) => [shape.id, shape.bounds]));
}

/** The bounds of one id, or a loud failure — keeps the assertions free of `?.`. */
function must(bounds: Map<string, Bounds>, id: string): Bounds {
  const found = bounds.get(id);
  if (found === undefined) throw new Error(`no bounds reported for "${id}"`);
  return found;
}

function centreX(bounds: Bounds): number {
  return (bounds.minX + bounds.maxX) / 2;
}

function centreY(bounds: Bounds): number {
  return (bounds.minY + bounds.maxY) / 2;
}

/**
 * A bound label sits inside its container with the padding Excalidraw keeps.
 *
 * Restated from the update scenarios: if a layout tool double-moved the label —
 * once itself, once through the container carry — it would land outside the box
 * and fail this, which is how the "single container move" claim is checked.
 */
function fits(container: Record<string, unknown>, label: Record<string, unknown>): void {
  const cx = Number(container.x);
  const cy = Number(container.y);
  const lx = Number(label.x);
  const ly = Number(label.y);
  expect(lx - cx).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
  expect(ly - cy).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
  expect(cx + Number(container.width) - (lx + Number(label.width))).toBeGreaterThanOrEqual(
    BOUND_TEXT_PADDING,
  );
  expect(cy + Number(container.height) - (ly + Number(label.height))).toBeGreaterThanOrEqual(
    BOUND_TEXT_PADDING,
  );
}

describe("place_relative", () => {
  it("places the target below the anchor at the exact gap, centred on x (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "b", x: 500, y: 500, width: 60, height: 40 },
      ],
    });

    const result = await bridge.call("place_relative", {
      slug: "alpha",
      anchor: "a",
      target: "b",
      direction: "below",
      gap: 20,
    });
    expect(result.isError).toBeFalsy();

    const bounds = await boundsById(bridge, "alpha");
    const a = must(bounds, "a");
    const b = must(bounds, "b");
    // The target's top edge sits exactly `gap` below the anchor's bottom edge.
    expect(b.minY).toBeCloseTo(a.maxY + 20);
    // And it is centred on the cross axis.
    expect(centreX(b)).toBeCloseTo(centreX(a));
  });

  it("places to the right of a rotated anchor using its rotated bounds, not raw width (R1/R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 200, height: 100 },
        { type: "rectangle", id: "b", x: 800, y: 800, width: 60, height: 60 },
      ],
    });
    // A quarter turn: the 200x100 stored box becomes a 100x200 rotated footprint,
    // so its true right edge (~150) is nowhere near its stored x+width (200).
    await bridge.call("update_elements", {
      slug: "alpha",
      patches: [{ id: "a", angle: Math.PI / 2 }],
    });

    await bridge.call("place_relative", {
      slug: "alpha",
      anchor: "a",
      target: "b",
      direction: "right",
      gap: 30,
    });

    const bounds = await boundsById(bridge, "alpha");
    const a = must(bounds, "a");
    const b = must(bounds, "b");
    // The anchor's footprint is the rotated one, not the stored 200-wide box.
    expect(a.maxX - a.minX).toBeCloseTo(100);
    expect(a.maxX).toBeLessThan(200);
    // The target clears the rotated bounds, not the raw width.
    expect(b.minX).toBeCloseTo(a.maxX + 30);
    expect(centreY(b)).toBeCloseTo(centreY(a));
  });
});

describe("align_elements", () => {
  it("aligns every element's left edge to the leftmost (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "r1", x: 0, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "r2", x: 200, y: 100, width: 100, height: 60 },
        { type: "rectangle", id: "r3", x: 500, y: 300, width: 100, height: 60 },
      ],
    });

    const result = await bridge.call("align_elements", {
      slug: "alpha",
      ids: ["r1", "r2", "r3"],
      alignment: "left",
    });
    expect(result.isError).toBeFalsy();

    const bounds = await boundsById(bridge, "alpha");
    expect(must(bounds, "r1").minX).toBeCloseTo(0);
    expect(must(bounds, "r2").minX).toBeCloseTo(0);
    expect(must(bounds, "r3").minX).toBeCloseTo(0);
  });

  it("aligns every element to a shared horizontal centre line (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "r1", x: 0, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "r2", x: 200, y: 100, width: 100, height: 40 },
        { type: "rectangle", id: "r3", x: 500, y: 300, width: 100, height: 100 },
      ],
    });

    await bridge.call("align_elements", {
      slug: "alpha",
      ids: ["r1", "r2", "r3"],
      alignment: "centre-y",
    });

    const bounds = await boundsById(bridge, "alpha");
    const c1 = centreY(must(bounds, "r1"));
    const c2 = centreY(must(bounds, "r2"));
    const c3 = centreY(must(bounds, "r3"));
    expect(c1).toBeCloseTo(c2);
    expect(c2).toBeCloseTo(c3);
  });

  it("errors naming a missing id and moves nothing (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "r1", x: 0, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "r2", x: 300, y: 0, width: 100, height: 60 },
      ],
    });
    const before = await boundsById(bridge, "alpha");

    const result = await bridge.call("align_elements", {
      slug: "alpha",
      ids: ["r1", "ghost"],
      alignment: "left",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ghost");
    // No partial move: the element that does exist stayed exactly where it was.
    const after = await boundsById(bridge, "alpha");
    expect(must(after, "r1")).toEqual(must(before, "r1"));
    expect(must(after, "r2")).toEqual(must(before, "r2"));
  });
});

describe("distribute_elements", () => {
  it("equalises the gaps between three elements, leaving the extremes fixed (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });

    // Gaps are 50 (r1→r2) then 350 (r2→r3): unequal on purpose.
    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "r1", x: 0, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "r2", x: 150, y: 0, width: 100, height: 60 },
        { type: "rectangle", id: "r3", x: 600, y: 0, width: 100, height: 60 },
      ],
    });
    const before = await boundsById(bridge, "alpha");

    await bridge.call("distribute_elements", {
      slug: "alpha",
      ids: ["r1", "r2", "r3"],
      axis: "horizontal",
    });

    const after = await boundsById(bridge, "alpha");
    // The two extreme elements are untouched.
    expect(must(after, "r1")).toEqual(must(before, "r1"));
    expect(must(after, "r3")).toEqual(must(before, "r3"));
    // The successive gaps are now equal, and the inner element actually moved.
    const gap1 = must(after, "r2").minX - must(after, "r1").maxX;
    const gap2 = must(after, "r3").minX - must(after, "r2").maxX;
    expect(gap1).toBeCloseTo(gap2);
    expect(must(after, "r2").minX).not.toBeCloseTo(must(before, "r2").minX);
  });
});

describe("shared result shape (R5)", () => {
  it("moves a bound label with its container and answers in the draw-tool shape", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "anchor", x: 0, y: 0, width: 100, height: 100 },
        {
          type: "rectangle",
          id: "box",
          x: 900,
          y: 900,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });
    // anchor, box, and the box's bound label.
    await waitForCount(peer, 3);
    const labelBefore = roomScene(peer.doc).find((element) => element.type === "text");
    expect(labelBefore).toBeDefined();

    const result = await bridge.call("place_relative", {
      slug: "alpha",
      anchor: "anchor",
      target: "box",
      direction: "right",
      gap: 20,
    });

    expect(result.isError).toBeFalsy();
    // A text block a text-only harness can render.
    expect(textOf(result).length).toBeGreaterThan(0);

    // structuredContent in the shared draw-tool result shape.
    const structured = result.structuredContent as {
      slug: string;
      url: string;
      ids: string[];
      shapes: { id: string; x: number; y: number; width: number; height: number }[];
    };
    expect(structured.slug).toBe("alpha");
    expect(typeof structured.url).toBe("string");
    expect(structured.ids).toContain("box");
    const moved = structured.shapes.find((shape) => shape.id === "box");
    expect(moved).toMatchObject({ id: "box", x: 120, y: 0 });

    // The label followed the container, and only the container was patched: it
    // is one move, not a double one, so the label is still fitted inside the box.
    await waitFor(() => roomElement(peer.doc, "box")?.x === 120, "the container never moved");
    const container = roomElement(peer.doc, "box");
    const labelAfter = roomScene(peer.doc).find((element) => element.type === "text");
    expect(labelAfter?.x).not.toBe(labelBefore?.x);
    expect(container).toBeDefined();
    expect(labelAfter).toBeDefined();
    if (container !== undefined && labelAfter !== undefined) fits(container, labelAfter);
  });
});
