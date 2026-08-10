import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import {
  createHarness,
  roomElement,
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

/** Global coordinates of an arrow's first and last point. */
function endpoints(arrow: Record<string, unknown> | undefined): {
  start: [number, number];
  end: [number, number];
} {
  const points = arrow?.points as [number, number][];
  const x = Number(arrow?.x);
  const y = Number(arrow?.y);
  const first = points[0] ?? [0, 0];
  const last = points[points.length - 1] ?? [0, 0];
  return { start: [x + first[0], y + first[1]], end: [x + last[0], y + last[1]] };
}

/** Shortest distance from a point to an axis-aligned box; negative inside. */
function distanceToBox(
  element: Record<string, unknown> | undefined,
  [px, py]: [number, number],
): number {
  const left = Number(element?.x);
  const top = Number(element?.y);
  const right = left + Number(element?.width);
  const bottom = top + Number(element?.height);
  if (px >= left && px <= right && py >= top && py <= bottom) {
    return -Math.min(px - left, right - px, py - top, bottom - py);
  }
  const dx = Math.max(left - px, 0, px - right);
  const dy = Math.max(top - py, 0, py - bottom);
  return Math.hypot(dx, dy);
}

const TWO_BOXES = [
  { type: "rectangle", id: "left", x: 0, y: 0, width: 100, height: 100 },
  { type: "rectangle", id: "right", x: 300, y: 0, width: 100, height: 100 },
];

describe("arrows", () => {
  it("binds to elements the room already holds (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", { slug: "alpha", elements: TWO_BOXES });
    await waitForCount(peer, 2);

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "arrow", id: "flow", start: { id: "left" }, end: { id: "right" } }],
    });

    expect(result.isError).toBeFalsy();
    await waitForCount(peer, 3);
    const arrow = roomElement(peer.doc, "flow");
    expect(arrow?.startBinding).toMatchObject({ elementId: "left" });
    expect(arrow?.endBinding).toMatchObject({ elementId: "right" });
    expect(roomElement(peer.doc, "left")?.boundElements).toEqual([{ id: "flow", type: "arrow" }]);
    expect(roomElement(peer.doc, "right")?.boundElements).toEqual([{ id: "flow", type: "arrow" }]);
  });

  it("binds to elements introduced by the same call (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        ...TWO_BOXES,
        { type: "arrow", id: "flow", start: { id: "left" }, end: { id: "right" } },
      ],
    });

    expect(result.isError).toBeFalsy();
    await waitForCount(peer, 3);
    const arrow = roomElement(peer.doc, "flow");
    expect(arrow?.startBinding).toMatchObject({ elementId: "left" });
    expect(arrow?.endBinding).toMatchObject({ elementId: "right" });
    expect(roomElement(peer.doc, "left")?.boundElements).toEqual([{ id: "flow", type: "arrow" }]);
    expect(roomElement(peer.doc, "right")?.boundElements).toEqual([{ id: "flow", type: "arrow" }]);
  });

  it("routes an unpositioned arrow between the shapes it joins (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        ...TWO_BOXES,
        { type: "arrow", id: "flow", start: { id: "left" }, end: { id: "right" } },
      ],
    });
    await waitForCount(peer, 3);

    const arrow = roomElement(peer.doc, "flow");
    const left = roomElement(peer.doc, "left");
    const right = roomElement(peer.doc, "right");
    const { start, end } = endpoints(arrow);

    // Upstream binds without routing: an arrow that kept its default 100x0
    // shape would bind correctly and render as a stub floating between the
    // boxes, so the geometry is what this asserts.
    const startGap = Number((arrow?.startBinding as { gap: number } | undefined)?.gap);
    const endGap = Number((arrow?.endBinding as { gap: number } | undefined)?.gap);
    expect(startGap).toBeGreaterThan(0);
    expect(endGap).toBeGreaterThan(0);
    expect(distanceToBox(left, start)).toBeGreaterThan(0);
    expect(distanceToBox(left, start)).toBeLessThanOrEqual(startGap);
    expect(distanceToBox(right, end)).toBeGreaterThan(0);
    expect(distanceToBox(right, end)).toBeLessThanOrEqual(endGap);
    // Pointing from the left box towards the right one, not the other way.
    expect(end[0]).toBeGreaterThan(start[0]);
  });

  it("keeps geometry the caller gave it (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        ...TWO_BOXES,
        {
          type: "arrow",
          id: "flow",
          x: 110,
          y: 20,
          width: 180,
          height: 40,
          start: { id: "left" },
          end: { id: "right" },
        },
      ],
    });
    await waitForCount(peer, 3);

    const arrow = roomElement(peer.doc, "flow");
    expect(arrow).toMatchObject({ x: 110, y: 20, width: 180, height: 40 });
  });

  it("refuses an arrow bound to something that is not a shape (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "left", x: 0, y: 0, width: 100, height: 100 },
        { type: "text", id: "note", x: 300, y: 0, text: "hello" },
      ],
    });
    await waitForCount(peer, 2);

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "arrow", id: "flow", start: { id: "left" }, end: { id: "note" } }],
    });

    // A frame, a line or another arrow makes upstream's converter reach for a
    // bound element it never built and die on `undefined.id`; a text element
    // binds, but to a copy of itself this bridge never writes back.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("note");
    expect(textOf(result)).toContain("rectangle, an ellipse or a diamond");
    await settle();
    expect(roomScene(peer.doc)).toHaveLength(2);
    expect(roomElement(peer.doc, "left")?.boundElements).toBeNull();
  });

  it("authors a bent arrow whose waypoints round-trip through describe_scene (R1)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const waypoints: [number, number][] = [
      [100, 30],
      [300, 90],
      [500, 290],
      [600, 430],
    ];
    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "arrow", id: "bent", points: waypoints }],
    });

    expect(result.isError).toBeFalsy();
    await waitForCount(peer, 1);

    const described = await bridge.call("describe_scene", { slug: "alpha" });
    const shapes = (
      described.structuredContent as {
        shapes: { id: string; points: { x: number; y: number }[] | null }[];
      }
    ).shapes;
    const reported = shapes.find((shape) => shape.id === "bent")?.points;
    expect(reported).toHaveLength(4);
    // Interior waypoints round-trip exactly; the two terminals carry Excalidraw's
    // half-pixel bind nudge, imperceptible against the shape.
    expect(reported?.[1]).toEqual({ x: 300, y: 90 });
    expect(reported?.[2]).toEqual({ x: 500, y: 290 });
    for (const [index, [wx, wy]] of waypoints.entries()) {
      expect(Math.abs(Number(reported?.[index]?.x) - wx)).toBeLessThanOrEqual(1);
      expect(Math.abs(Number(reported?.[index]?.y) - wy)).toBeLessThanOrEqual(1);
    }
  });

  it("refuses an arrow bound to an id present nowhere (R3, R5)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "rectangle", id: "left", x: 0, y: 0, width: 100, height: 100 }],
    });
    await waitForCount(peer, 1);

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [{ type: "arrow", id: "flow", start: { id: "left" }, end: { id: "nowhere" } }],
    });

    // Upstream drops a binding it cannot resolve and reports nothing.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nowhere");
    expect(textOf(result)).toContain("neither in this room nor created by this call");
    await settle();
    expect(roomScene(peer.doc)).toHaveLength(1);
    expect(roomElement(peer.doc, "left")?.boundElements).toBeNull();
  });
});
