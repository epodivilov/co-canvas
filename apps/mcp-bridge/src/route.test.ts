import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BridgeClient, Harness } from "./test-helpers.ts";
import { createHarness, roomElement, waitFor, waitForCount } from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

interface Point {
  x: number;
  y: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Shape {
  id: string;
  type: string;
  bounds: Bounds;
  points: Point[] | null;
  startBinding: string | null;
  endBinding: string | null;
}

/** Every element read back through describe_scene, keyed by id. */
async function shapesById(bridge: BridgeClient, slug: string): Promise<Map<string, Shape>> {
  const result = await bridge.call("describe_scene", { slug });
  const shapes = (result.structuredContent as { shapes: Shape[] }).shapes;
  return new Map(shapes.map((shape) => [shape.id, shape]));
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/** The absolute points of a linear shape, or a loud failure. */
function pointsOf(shape: Shape | undefined): Point[] {
  if (shape === undefined) throw new Error("missing arrow");
  if (shape.points === null) throw new Error("arrow has no points");
  return shape.points;
}

/** True when a segment is horizontal or vertical to within a pixel. */
function isAxisAligned([a, b]: [Point, Point]): boolean {
  return Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) < 1;
}

/** Consecutive point pairs of a polyline. */
function segments(points: Point[]): [Point, Point][] {
  const pairs: [Point, Point][] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a !== undefined && b !== undefined) pairs.push([a, b]);
  }
  return pairs;
}

/**
 * Whether a segment enters a box's interior (Liang–Barsky against the box shrunk
 * by `inset`, so a terminal that merely lands on the edge does not count).
 */
function entersBox([p1, p2]: [Point, Point], box: Bounds, inset = 1): boolean {
  const minX = box.minX + inset;
  const maxX = box.maxX - inset;
  const minY = box.minY + inset;
  const maxY = box.maxY - inset;
  if (minX >= maxX || minY >= maxY) return false;

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let t0 = 0;
  let t1 = 1;
  const clips: [number, number][] = [
    [-dx, p1.x - minX],
    [dx, maxX - p1.x],
    [-dy, p1.y - minY],
    [dy, maxY - p1.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t1 > t0;
}

/** Two rectangles offset diagonally: separated on both axes. */
const DIAGONAL = [
  { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100 },
  { type: "rectangle", id: "b", x: 400, y: 300, width: 100, height: 100 },
];

describe("route_arrow", () => {
  it("stores an orthogonal polyline for a diagonal pair (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    await bridge.call("add_elements", { slug: "alpha", elements: DIAGONAL });

    const result = await bridge.call("route_arrow", { slug: "alpha", start: "a", end: "b" });
    expect(result.isError).toBeFalsy();
    const arrowId = must((result.structuredContent as { ids: string[] }).ids[0], "routed arrow id");

    const shapes = await shapesById(bridge, "alpha");
    const points = pointsOf(shapes.get(arrowId));
    // A diagonal pair bends: an elbow, not a straight line.
    expect(points.length).toBeGreaterThanOrEqual(3);
    for (const segment of segments(points)) expect(isAxisAligned(segment)).toBe(true);
  });

  it("binds both terminals to the two shapes and stays bound on re-read (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    await bridge.call("add_elements", { slug: "alpha", elements: DIAGONAL });
    await waitForCount(peer, 2);

    const result = await bridge.call("route_arrow", { slug: "alpha", start: "a", end: "b" });
    const arrowId = must((result.structuredContent as { ids: string[] }).ids[0], "routed arrow id");
    await waitForCount(peer, 3);

    // Bound in the stored element itself.
    const stored = roomElement(peer.doc, arrowId);
    expect(stored?.startBinding).toMatchObject({ elementId: "a" });
    expect(stored?.endBinding).toMatchObject({ elementId: "b" });
    expect(roomElement(peer.doc, "a")?.boundElements).toContainEqual({
      id: arrowId,
      type: "arrow",
    });
    expect(roomElement(peer.doc, "b")?.boundElements).toContainEqual({
      id: arrowId,
      type: "arrow",
    });

    // And still bound when re-read through describe_scene.
    const shapes = await shapesById(bridge, "alpha");
    const arrow = must(shapes.get(arrowId), "arrow");
    expect(arrow.startBinding).toBe("a");
    expect(arrow.endBinding).toBe("b");
  });

  it("anchors at [0,0] and keeps the terminal segments axis-aligned after the re-snap (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    await bridge.call("add_elements", { slug: "alpha", elements: DIAGONAL });
    await waitForCount(peer, 2);

    const result = await bridge.call("route_arrow", { slug: "alpha", start: "a", end: "b" });
    const arrowId = must((result.structuredContent as { ids: string[] }).ids[0], "routed arrow id");
    await waitForCount(peer, 3);

    // Stored relative points are anchored at the first point: the write path
    // makes `points[0]` the origin. A bound terminal then carries Excalidraw's
    // half-pixel bind nudge, imperceptible against the shape, so the origin is
    // exact to within a pixel rather than dead-on [0, 0].
    const stored = roomElement(peer.doc, arrowId);
    const relative = must((stored?.points as [number, number][] | undefined)?.[0], "first point");
    expect(Math.abs(relative[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(relative[1])).toBeLessThanOrEqual(1);

    // The terminal segments — first and last — remain orthogonal even after the
    // write path re-aims each bound terminal at its shape's centre.
    const shapes = await shapesById(bridge, "alpha");
    const points = pointsOf(shapes.get(arrowId));
    const all = segments(points);
    const first = must(all[0], "first segment");
    const last = must(all[all.length - 1], "last segment");
    expect(isAxisAligned(first)).toBe(true);
    expect(isAxisAligned(last)).toBe(true);
  });

  it("re-routes an existing bound arrow and preserves its bindings (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");
    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [...DIAGONAL, { type: "arrow", id: "flow", start: { id: "a" }, end: { id: "b" } }],
    });
    await waitForCount(peer, 3);
    // A straight routed arrow starts life with two points.
    expect((roomElement(peer.doc, "flow")?.points as unknown[] | undefined)?.length).toBe(2);

    const result = await bridge.call("route_arrow", {
      slug: "alpha",
      start: "a",
      end: "b",
      id: "flow",
    });
    expect(result.isError).toBeFalsy();
    await waitFor(
      () => (roomElement(peer.doc, "flow")?.points as unknown[] | undefined)?.length === 3,
      "the arrow never adopted the elbow",
    );

    const stored = roomElement(peer.doc, "flow");
    // Bindings survive the re-route.
    expect(stored?.startBinding).toMatchObject({ elementId: "a" });
    expect(stored?.endBinding).toMatchObject({ elementId: "b" });

    const shapes = await shapesById(bridge, "alpha");
    const points = pointsOf(shapes.get("flow"));
    for (const segment of segments(points)) expect(isAxisAligned(segment)).toBe(true);
  });

  it("keeps every segment clear of both endpoint boxes (R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    await bridge.call("add_elements", { slug: "alpha", elements: DIAGONAL });

    const result = await bridge.call("route_arrow", { slug: "alpha", start: "a", end: "b" });
    const arrowId = must((result.structuredContent as { ids: string[] }).ids[0], "routed arrow id");

    const shapes = await shapesById(bridge, "alpha");
    const points = pointsOf(shapes.get(arrowId));
    const boxA = must(shapes.get("a"), "a").bounds;
    const boxB = must(shapes.get("b"), "b").bounds;
    for (const segment of segments(points)) {
      expect(entersBox(segment, boxA)).toBe(false);
      expect(entersBox(segment, boxB)).toBe(false);
    }
  });

  it("routes a Z between two boxes sitting side by side with offset centres (R1, R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    // Horizontally separated, y-ranges overlapping: an L corner would land inside
    // a box, so the router must lay a Z instead.
    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "b", x: 400, y: 40, width: 100, height: 100 },
      ],
    });

    const result = await bridge.call("route_arrow", { slug: "alpha", start: "a", end: "b" });
    expect(result.isError).toBeFalsy();
    const arrowId = must((result.structuredContent as { ids: string[] }).ids[0], "routed arrow id");

    const shapes = await shapesById(bridge, "alpha");
    const points = pointsOf(shapes.get(arrowId));
    expect(points.length).toBeGreaterThanOrEqual(4);
    const boxA = must(shapes.get("a"), "a").bounds;
    const boxB = must(shapes.get("b"), "b").bounds;
    for (const segment of segments(points)) {
      expect(isAxisAligned(segment)).toBe(true);
      expect(entersBox(segment, boxA)).toBe(false);
      expect(entersBox(segment, boxB)).toBe(false);
    }
  });
});
