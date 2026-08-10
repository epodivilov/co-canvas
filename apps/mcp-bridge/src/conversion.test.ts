/**
 * The compatibility layer on its own: no hub, no sockets, no document. What
 * these scenarios grade is whether Excalidraw's own converter runs inside a
 * plain Node process and hands back elements a browser would accept.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { convertSkeletons } from "./convert.ts";
import { elementSkeletonSchema } from "./skeleton.ts";
import { measureLineWidth } from "./text-width.ts";

/** Every field a rectangle element declares, per Excalidraw's own types. */
const RECTANGLE_FIELDS = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "index",
  "roundness",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
] as const;

async function convert(skeletons: unknown[]): Promise<Record<string, unknown>[]> {
  const parsed = z.array(elementSkeletonSchema).parse(skeletons);
  const result = await convertSkeletons(parsed, []);
  return result.created as unknown as Record<string, unknown>[];
}

describe("the headless conversion", () => {
  it("returns a complete Excalidraw element, not the skeleton it was given (R1)", async () => {
    const [rectangle] = await convert([
      { type: "rectangle", id: "r1", x: 10, y: 20, width: 120, height: 80 },
    ]);

    expect(rectangle).toBeDefined();
    for (const field of RECTANGLE_FIELDS) {
      expect(rectangle, `rectangle is missing ${field}`).toHaveProperty(field);
    }
    expect(typeof rectangle?.seed).toBe("number");
    expect(typeof rectangle?.versionNonce).toBe("number");
    expect(typeof rectangle?.version).toBe("number");
    expect(typeof rectangle?.updated).toBe("number");
    expect(rectangle).toMatchObject({ id: "r1", type: "rectangle", x: 10, y: 20 });
  });

  it("measures a label with the bridge's own width function (R2)", async () => {
    const elements = await convert([
      { type: "rectangle", id: "r1", x: 0, y: 0, width: 200, height: 100, label: { text: "Auth" } },
    ]);

    const text = elements.find((element) => element.type === "text");
    expect(text).toBeDefined();
    const expected = measureLineWidth("Auth", "20px Excalifont");
    expect(expected).toBeGreaterThan(0);
    expect(text?.width).toBe(expected);
  });
});

/** The `points` of a converted linear element, as `[x, y]` pairs. */
function pointsOf(element: Record<string, unknown> | undefined): [number, number][] {
  return (element?.points as [number, number][] | undefined) ?? [];
}

describe("the arrow write path (CC-31)", () => {
  it("stores an unbound arrow's explicit waypoints and a box from their extent (R1)", async () => {
    const [arrow] = await convert([
      {
        type: "arrow",
        id: "bent",
        points: [
          { x: 100, y: 30 },
          { x: 300, y: 90 },
          { x: 500, y: 290 },
          { x: 600, y: 430 },
        ],
      },
    ]);

    // The anchor is the first waypoint; interior points are stored verbatim,
    // relative to it. Binding nudges the two terminals half a pixel inward even
    // on an unbound arrow, so only they carry a tolerance.
    expect(arrow).toMatchObject({ x: 100, y: 30, width: 500, height: 400 });
    const points = pointsOf(arrow);
    expect(points).toHaveLength(4);
    expect(points[1]).toEqual([200, 60]);
    expect(points[2]).toEqual([400, 260]);
    expect(Math.abs(Number(points[0]?.[0]) - 0)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(Number(points[0]?.[1]) - 0)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(Number(points[3]?.[0]) - 500)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(Number(points[3]?.[1]) - 400)).toBeLessThanOrEqual(0.6);
  });

  it("normalises a bound arrow's terminals onto the edges, keeping its bends (R2)", async () => {
    const created = await convert([
      { type: "rectangle", id: "left", x: 0, y: 0, width: 100, height: 100 },
      { type: "rectangle", id: "right", x: 300, y: 0, width: 100, height: 100 },
      {
        type: "arrow",
        id: "flow",
        // The terminals sit off both shapes; the interior waypoints are the bend.
        points: [
          { x: 90, y: 60 },
          { x: 150, y: 150 },
          { x: 250, y: 150 },
          { x: 310, y: 40 },
        ],
        start: { id: "left" },
        end: { id: "right" },
      },
    ]);
    const arrow = created.find((element) => element.id === "flow");
    expect(arrow).toBeDefined();
    const points = pointsOf(arrow);
    const x = Number(arrow?.x);
    const y = Number(arrow?.y);

    const startBinding = arrow?.startBinding as { elementId: string; focus: number; gap: number };
    const endBinding = arrow?.endBinding as { elementId: string; focus: number; gap: number };
    expect(startBinding.elementId).toBe("left");
    expect(endBinding.elementId).toBe("right");
    // Radial terminal segments: focus is ~0 and the gap is at its small floor, so
    // Excalidraw re-derives the same endpoint after a shape moves (the [manual] part).
    expect(Math.abs(startBinding.focus)).toBeLessThan(0.01);
    expect(Math.abs(endBinding.focus)).toBeLessThan(0.01);
    expect(startBinding.gap).toBeGreaterThanOrEqual(1);
    expect(startBinding.gap).toBeLessThanOrEqual(6);
    expect(endBinding.gap).toBeGreaterThanOrEqual(1);
    expect(endBinding.gap).toBeLessThanOrEqual(6);

    // The interior waypoints keep their absolute positions; only the terminals moved.
    expect(x + Number(points[1]?.[0])).toBeCloseTo(150, 6);
    expect(y + Number(points[1]?.[1])).toBeCloseTo(150, 6);
    expect(x + Number(points[2]?.[0])).toBeCloseTo(250, 6);
    expect(y + Number(points[2]?.[1])).toBeCloseTo(150, 6);
    // The first point landed on the left shape's edge (the corner facing the
    // bend), give or take the half-pixel bind nudge.
    expect(Math.abs(x + Number(points[0]?.[0]) - 100)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(y + Number(points[0]?.[1]) - 100)).toBeLessThanOrEqual(0.6);
  });

  it("lets explicit points win over a box given in the same call (R4)", async () => {
    const [arrow] = await convert([
      {
        type: "arrow",
        id: "flow",
        x: 999,
        y: 999,
        width: 5,
        height: 5,
        points: [
          { x: 100, y: 50 },
          { x: 200, y: 100 },
          { x: 300, y: 50 },
        ],
      },
    ]);

    // The box is derived from the points' extent, not from the 999/5 the caller also gave.
    expect(arrow).toMatchObject({ x: 100, y: 50, width: 200, height: 50 });
    expect(pointsOf(arrow)[1]).toEqual([100, 50]);
  });

  it("rejects a points array with fewer than two entries (R5)", async () => {
    await expect(convert([{ type: "arrow", id: "a", points: [{ x: 0, y: 0 }] }])).rejects.toThrow();
  });

  it("rejects a points array carrying a non-finite number (R5)", async () => {
    await expect(
      convert([
        {
          type: "arrow",
          id: "a",
          points: [
            { x: 0, y: 0 },
            { x: Number.NaN, y: 10 },
          ],
        },
      ]),
    ).rejects.toThrow();
  });

  it("guards the points array inside the converter, past the schema (R5)", async () => {
    // The schema rejects a degenerate array at the tool boundary; this reaches
    // the converter directly, so the inner guard is what has to catch it.
    await expect(
      convertSkeletons([{ type: "arrow", id: "a", points: [{ x: 0, y: 0 }] }] as never, []),
    ).rejects.toThrow("at least two points");
    await expect(
      convertSkeletons(
        [
          {
            type: "arrow",
            id: "a",
            points: [
              { x: 0, y: 0 },
              { x: Number.POSITIVE_INFINITY, y: 1 },
            ],
          },
        ] as never,
        [],
      ),
    ).rejects.toThrow("finite");
  });
});
