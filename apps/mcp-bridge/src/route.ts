/**
 * The tool that bends an arrow for you.
 *
 * `route_arrow` computes an orthogonal, single-elbow path between two bound
 * shapes and writes it through the multi-point arrow path (CC-31), so a bound
 * arrow comes out as a clean right-angled connector instead of the agent
 * guessing waypoints off a screenshot. It reads the two shapes' geometry the
 * same way the layout tools do — `describe_scene`'s rotated `bounds` (CC-28) —
 * lays down either an L (one corner) or a Z (two corners) depending on how the
 * boxes sit relative to each other, and emits ABSOLUTE scene points that the
 * write path relativises and re-snaps onto the shapes' edges.
 *
 * The one geometric idea it owns is where the bends go. Every corner adjacent to
 * a bound terminal sits on that shape's centre-line, so when the write path
 * re-aims the terminal at the shape's centre (`normalizeTerminals`) the first and
 * last segments stay axis-aligned rather than tilting (R3). Edge-landing and
 * binding maths belong to the write path; this file does not duplicate them.
 *
 * v1 avoids only its own two endpoint boxes (R5). A third shape between them may
 * still be crossed — obstacle avoidance is CC-38.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as Y from "yjs";
import { z } from "zod";
import type { Described } from "./describe.ts";
import { describeScene } from "./describe.ts";
import { addElements, answer, resultShape, updateElements } from "./drawing.ts";
import { elementsOf, readScene } from "./elements.ts";
import type { RoomAccess } from "./room.ts";
import { openRoom } from "./room.ts";
import { BINDABLE_TYPES } from "./skeleton.ts";

/** One element's rotated footprint — the box describe_scene reports as `bounds`. */
type Bounds = Described["bounds"];

/** A point in absolute scene coordinates. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/** Below this, two centre coordinates are the same point and no axis can be picked. */
const SAME_CENTRE = 1e-6;
/** Below this, a cross-axis offset is sub-pixel and the elbow collapses to a straight run. */
const STRAIGHT = 0.5;

const slugArgument = z.string().describe("Board slug, e.g. `auth-redesign`.");

export function registerRouteTool(server: McpServer, deps: RoomAccess): void {
  server.registerTool(
    "route_arrow",
    {
      title: "Route a right-angled arrow between two shapes",
      description:
        "Draws an orthogonal (right-angled) arrow between two shapes and works out the bend for" +
        " you, so a bound arrow comes out clean without you eyeballing waypoints. Every segment" +
        " is horizontal or vertical, both ends bind to the shapes, and the terminals stay square" +
        " to them. Give `id` to re-route an existing bound arrow in place; omit it to draw a new" +
        " one. It clears its own two shapes, but may still cross a third shape between them.",
      inputSchema: {
        slug: slugArgument,
        start: z.string().describe("Id of the shape the arrow starts at."),
        end: z.string().describe("Id of the shape the arrow ends at."),
        id: z
          .string()
          .optional()
          .describe(
            "Id of an existing bound arrow to re-route in place. Omit to draw a new arrow;" +
              " pass an unused id to name the new arrow.",
          ),
      },
      outputSchema: resultShape,
    },
    async ({ slug, start, end, id }) => {
      const room = await openRoom(deps, slug);
      const byId = shapesById(room.doc);

      if (start === end) {
        throw new Error(`route_arrow cannot join "${start}" to itself`);
      }
      const startShape = lookup(byId, start);
      const endShape = lookup(byId, end);

      const existing = id === undefined ? undefined : byId.get(id);
      if (existing !== undefined) {
        const ids = await reroute(room.doc, byId, existing, startShape, endShape);
        return answer(
          slug,
          room.url,
          room.doc,
          ids,
          `Re-routed arrow "${id}" between "${start}" and "${end}" on board "${slug}"`,
        );
      }

      const ids = await author(room.doc, id, start, end, startShape, endShape);
      return answer(
        slug,
        room.url,
        room.doc,
        ids,
        `Routed an arrow from "${start}" to "${end}" on board "${slug}"`,
      );
    },
  );
}

/**
 * Draws a new bound arrow whose shape is the computed elbow.
 *
 * The waypoints go onto an arrow skeleton with its two `start`/`end` bindings,
 * so the shared `add_elements` path binds it, snaps its terminals onto the
 * shapes' edges and records the `focus`/`gap` — exactly as an authored bent
 * arrow (CC-31). The order is start→end, so the first waypoint sits at the start
 * shape.
 */
async function author(
  doc: Y.Doc,
  id: string | undefined,
  start: string,
  end: string,
  startShape: Described,
  endShape: Described,
): Promise<string[]> {
  for (const shape of [startShape, endShape]) {
    if (!BINDABLE_TYPES.has(shape.type)) {
      throw new Error(
        `route_arrow can only join a rectangle, an ellipse or a diamond;` +
          ` "${shape.id}" is a ${shape.type}`,
      );
    }
  }
  const points = routeWaypoints(startShape.bounds, endShape.bounds);
  return addElements(doc, [
    {
      type: "arrow",
      ...(id === undefined ? {} : { id }),
      start: { id: start },
      end: { id: end },
      points,
    },
  ]);
}

/**
 * Rewrites an existing bound arrow's points to the computed elbow.
 *
 * The arrow keeps the bindings it already has, so the caller's `start`/`end`
 * must name the two shapes it is bound to. The waypoints are ordered to match
 * the arrow's own binding order — the `points` patch re-snaps the first terminal
 * onto the start-binding shape and the last onto the end-binding shape — so a
 * caller that lists the shapes the other way round still gets a correct route.
 */
async function reroute(
  doc: Y.Doc,
  byId: ReadonlyMap<string, Described>,
  arrow: Described,
  startShape: Described,
  endShape: Described,
): Promise<string[]> {
  if (arrow.type !== "arrow") {
    throw new Error(`"${arrow.id}" is a ${arrow.type}, not an arrow to re-route`);
  }
  const boundStart = arrow.startBinding;
  const boundEnd = arrow.endBinding;
  const wanted = new Set([startShape.id, endShape.id]);
  if (
    boundStart === null ||
    boundEnd === null ||
    !wanted.has(boundStart) ||
    !wanted.has(boundEnd)
  ) {
    throw new Error(
      `arrow "${arrow.id}" is not bound to both "${startShape.id}" and "${endShape.id}";` +
        " re-routing keeps an arrow's own bindings",
    );
  }
  // Order the waypoints by the arrow's binding order, not the caller's argument
  // order, so the write path snaps each terminal to the shape it already binds.
  const from = lookup(byId, boundStart);
  const to = lookup(byId, boundEnd);
  const points = routeWaypoints(from.bounds, to.bounds);
  return updateElements(doc, [{ id: arrow.id, points }]);
}

// ---------------------------------------------------------------------------
// the routing
// ---------------------------------------------------------------------------

/**
 * The orthogonal waypoints joining two boxes, absolute and start→end.
 *
 * Boxes offset on both axes get an L — one corner in the free quadrant. Boxes
 * that only clear on one axis get a Z along it, its mid-line dropped in the gap;
 * an L there would put its corner inside a box. The terminals are emitted at the
 * shapes' centres and the write path lands them on the edges — every corner next
 * to a terminal already sits on that shape's centre-line, so the terminal
 * segment comes out square (R3).
 */
function routeWaypoints(from: Bounds, to: Bounds): Point[] {
  const a = centre(from);
  const b = centre(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < SAME_CENTRE && Math.abs(dy) < SAME_CENTRE) {
    throw new Error("route_arrow needs two shapes with different centres");
  }

  const horizontallyApart = from.maxX < to.minX || to.maxX < from.minX;
  const verticallyApart = from.maxY < to.minY || to.maxY < from.minY;

  if (horizontallyApart && verticallyApart) return elbow(a, b, dx, dy);
  if (horizontallyApart) return zigzag(a, b, "horizontal", from, to);
  if (verticallyApart) return zigzag(a, b, "vertical", from, to);
  // Overlapping on both axes is outside R5's non-overlapping premise (CC-38): lay
  // a best-effort Z along whichever axis the centres are further apart on.
  return zigzag(a, b, Math.abs(dx) >= Math.abs(dy) ? "horizontal" : "vertical", from, to);
}

/**
 * A single-corner path: `[A, corner, B]`.
 *
 * The arrow leaves the start box along the axis the centres are further apart on
 * and enters the end box along the other, so the longer run is the straight one.
 * The corner shares the start centre's coordinate on the exit axis and the end
 * centre's on the entry axis — both terminals land square (R3), and for a pair
 * that clears on both axes the corner sits outside either box (R5).
 */
function elbow(a: Point, b: Point, dx: number, dy: number): Point[] {
  const corner =
    Math.abs(dx) >= Math.abs(dy)
      ? { x: b.x, y: a.y } // exit the start box horizontally, enter the end box vertically
      : { x: a.x, y: b.y }; // exit vertically, enter horizontally
  return dedupe([a, corner, b]);
}

/**
 * A two-corner path along one axis: `[A, m1, m2, B]`.
 *
 * The mid-line is dropped in the gap between the two facing edges, so its
 * perpendicular run passes between the boxes and touches neither (R5). Both
 * terminal corners share their shape's centre on the routing axis, so the
 * terminal segments are square (R3). When the centres already line up across the
 * routing axis the two corners coincide and the path is a straight run.
 */
function zigzag(
  a: Point,
  b: Point,
  axis: "horizontal" | "vertical",
  from: Bounds,
  to: Bounds,
): Point[] {
  if (axis === "horizontal") {
    if (Math.abs(b.y - a.y) < STRAIGHT) return dedupe([a, b]);
    const midX = gapMidpoint(from.minX, from.maxX, to.minX, to.maxX, a.x, b.x);
    return dedupe([a, { x: midX, y: a.y }, { x: midX, y: b.y }, b]);
  }
  if (Math.abs(b.x - a.x) < STRAIGHT) return dedupe([a, b]);
  const midY = gapMidpoint(from.minY, from.maxY, to.minY, to.maxY, a.y, b.y);
  return dedupe([a, { x: a.x, y: midY }, { x: b.x, y: midY }, b]);
}

/**
 * The mid-line coordinate a Z bends at.
 *
 * The midpoint of the gap between the two boxes' facing edges when they clear on
 * this axis, so the perpendicular run sits between them; the midpoint of the two
 * centres when they do not, which only happens on the best-effort overlapping
 * path.
 */
function gapMidpoint(
  fromMin: number,
  fromMax: number,
  toMin: number,
  toMax: number,
  centreFrom: number,
  centreTo: number,
): number {
  if (fromMax < toMin) return (fromMax + toMin) / 2;
  if (toMax < fromMin) return (toMax + fromMin) / 2;
  return (centreFrom + centreTo) / 2;
}

/** Drops consecutive points closer than a pixel, keeping at least two. */
function dedupe(points: readonly Point[]): Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    const previous = kept.at(-1);
    if (
      previous !== undefined &&
      Math.abs(previous.x - point.x) < STRAIGHT &&
      Math.abs(previous.y - point.y) < STRAIGHT
    ) {
      continue;
    }
    kept.push(point);
  }
  // The caller guards against coincident centres, so two distinct points always
  // survive; the fallback only satisfies the "arrow needs two points" contract.
  if (kept.length < 2) {
    const last = points.at(-1) ?? { x: 0, y: 0 };
    kept.push(last);
  }
  return kept;
}

function centre(bounds: Bounds): Point {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

// ---------------------------------------------------------------------------
// reading the scene
// ---------------------------------------------------------------------------

/**
 * The scene as a map of id to its geometry, folding bound labels into their
 * containers exactly as `describe_scene` does — so a label id reads as absent
 * rather than as a routable shape.
 */
function shapesById(doc: Y.Doc): Map<string, Described> {
  const { shapes } = describeScene(readScene(elementsOf(doc)));
  return new Map(shapes.map((shape) => [shape.id, shape]));
}

/** One element by id, or an error naming it. */
function lookup(byId: ReadonlyMap<string, Described>, id: string): Described {
  const shape = byId.get(id);
  if (shape === undefined) throw new Error(`element "${id}" is not on this board`);
  return shape;
}
