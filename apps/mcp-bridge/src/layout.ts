/**
 * The three tools that position elements by arithmetic instead of by guess.
 *
 * `place_relative` puts a target on one side of an anchor with a gap;
 * `align_elements` brings a set to a shared edge or centre line;
 * `distribute_elements` evens the spacing of a set along an axis. All three
 * read each element's true rotated footprint — the `bounds` describe_scene
 * already reports (CC-28) — compute a translation per element, and apply the
 * moves through `update_elements`: one Yjs transaction, each element's angle
 * left as it was, and any bound label carried with its container automatically.
 *
 * The whole method rests on one fact: a pure translation shifts an element's
 * rotated bounds by the same delta it shifts its stored x/y. So the tools
 * compute where a corner (or centre) of the bounds should land, take the delta
 * from where it is now, and write `x`/`y` — never recompute x/y from
 * width/height, which would break a rotated element (R4).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as Y from "yjs";
import { z } from "zod";
import type { Described } from "./describe.ts";
import { describeScene } from "./describe.ts";
import { answer, resultShape, updateElements } from "./drawing.ts";
import { elementsOf, readScene } from "./elements.ts";
import type { RoomAccess } from "./room.ts";
import { openRoom } from "./room.ts";
import type { ElementPatch } from "./skeleton.ts";

/** One element's rotated footprint — the box describe_scene reports as `bounds`. */
type Bounds = Described["bounds"];

/** Which side of the anchor `place_relative` puts the target on. */
type Direction = "above" | "below" | "left" | "right";
/** The edge or centre line `align_elements` brings elements to. */
type Alignment = "left" | "right" | "top" | "bottom" | "centre-x" | "centre-y";
/** The axis `distribute_elements` evens the spacing along. */
type Axis = "horizontal" | "vertical";

const slugArgument = z.string().describe("Board slug, e.g. `auth-redesign`.");

export function registerLayoutTools(server: McpServer, deps: RoomAccess): void {
  server.registerTool(
    "place_relative",
    {
      title: "Place one element next to another",
      description:
        "Moves one element so it sits a set gap away from another on a chosen side — above," +
        " below, left or right — centred on the other axis. Positions are computed from each" +
        " element's true rotated footprint, so a turned anchor is cleared correctly. The anchor" +
        " stays put; only the target moves, carrying its label with it.",
      inputSchema: {
        slug: slugArgument,
        anchor: z
          .string()
          .describe("Id of the element that stays put; the target is placed relative to it."),
        target: z.string().describe("Id of the element to move."),
        direction: z
          .enum(["above", "below", "left", "right"])
          .describe("Which side of the anchor the target goes on."),
        gap: z
          .number()
          .default(24)
          .describe("Clear space in pixels between the two footprints. Defaults to 24."),
      },
      outputSchema: resultShape,
    },
    async ({ slug, anchor, target, direction, gap }) => {
      const room = await openRoom(deps, slug);
      const byId = shapesById(room.doc);
      const anchorShape = lookup(byId, anchor);
      const targetShape = lookup(byId, target);

      const ids = await updateElements(room.doc, [
        placeRelativePatch(anchorShape, targetShape, direction, gap),
      ]);
      return answer(
        slug,
        room.url,
        room.doc,
        ids,
        `Placed "${target}" ${direction} "${anchor}" on board "${slug}"`,
      );
    },
  );

  server.registerTool(
    "align_elements",
    {
      title: "Align a set of elements",
      description:
        "Moves two or more elements so their rotated footprints share an edge (left, right, top" +
        " or bottom) or a centre line (centre-x is a shared vertical centre, centre-y a shared" +
        " horizontal one). Edge alignments snap to the outermost element; centre alignments use" +
        " the middle of the group. Elements already in place are left untouched.",
      inputSchema: {
        slug: slugArgument,
        ids: z.array(z.string()).min(2).describe("Ids of the elements to align — at least two."),
        alignment: z
          .enum(["left", "right", "top", "bottom", "centre-x", "centre-y"])
          .describe("Edge or centre line to share."),
      },
      outputSchema: resultShape,
    },
    async ({ slug, ids, alignment }) => {
      const room = await openRoom(deps, slug);
      const byId = shapesById(room.doc);
      const shapes = resolveAll(
        byId,
        ids,
        2,
        "align_elements needs at least two distinct elements",
      );

      const reference = alignReference(shapes, alignment);
      const patches = shapes
        .map((shape) => alignPatch(shape, alignment, reference))
        .filter((patch): patch is ElementPatch => patch !== null);

      const moved = await updateElements(room.doc, patches);
      return answer(
        slug,
        room.url,
        room.doc,
        moved,
        `Aligned ${countOf(moved.length)} ${alignment} on board "${slug}"`,
      );
    },
  );

  server.registerTool(
    "distribute_elements",
    {
      title: "Distribute a set of elements evenly",
      description:
        "Moves the inner elements of three or more so the gaps between their rotated footprints" +
        " along an axis (horizontal or vertical) are equal. The two extreme elements stay put;" +
        " everything between them is respaced. Cross-axis position is left as it was.",
      inputSchema: {
        slug: slugArgument,
        ids: z
          .array(z.string())
          .min(3)
          .describe("Ids of the elements to distribute — at least three."),
        axis: z.enum(["horizontal", "vertical"]).describe("Axis to even the spacing along."),
      },
      outputSchema: resultShape,
    },
    async ({ slug, ids, axis }) => {
      const room = await openRoom(deps, slug);
      const byId = shapesById(room.doc);
      const shapes = resolveAll(
        byId,
        ids,
        3,
        "distribute_elements needs at least three distinct elements",
      );

      const moved = await updateElements(room.doc, distributePatches(shapes, axis));
      return answer(
        slug,
        room.url,
        room.doc,
        moved,
        `Distributed ${countOf(shapes.length)} ${axis}ly on board "${slug}"`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// reading the scene
// ---------------------------------------------------------------------------

/**
 * The scene as a map of id to its geometry.
 *
 * Built from `describe_scene`'s `shapes`, which fold every bound label into its
 * container: a label id is not a key here, so passing one reads as an absent id
 * (R6) rather than moving a label out from under the container that owns it.
 */
function shapesById(doc: Y.Doc): Map<string, Described> {
  const { shapes } = describeScene(readScene(elementsOf(doc)));
  return new Map(shapes.map((shape) => [shape.id, shape]));
}

/** One element by id, or an error naming it — the guard behind R6. */
function lookup(byId: ReadonlyMap<string, Described>, id: string): Described {
  const shape = byId.get(id);
  if (shape === undefined) throw new Error(`element "${id}" is not on this board`);
  return shape;
}

/**
 * Resolves every id to its element, de-duplicated, or throws before any write.
 *
 * De-duplicated first so an id repeated in the input cannot be moved twice or
 * pad the count past the minimum; every id is then resolved, so a single absent
 * one fails the whole call and nothing is moved (R6).
 */
function resolveAll(
  byId: ReadonlyMap<string, Described>,
  ids: readonly string[],
  minimum: number,
  tooFew: string,
): Described[] {
  const unique = [...new Set(ids)];
  if (unique.length < minimum) throw new Error(tooFew);
  return unique.map((id) => lookup(byId, id));
}

// ---------------------------------------------------------------------------
// the arithmetic
// ---------------------------------------------------------------------------

function centreX(bounds: Bounds): number {
  return (bounds.minX + bounds.maxX) / 2;
}

function centreY(bounds: Bounds): number {
  return (bounds.minY + bounds.maxY) / 2;
}

/**
 * The move that puts `target` a gap from `anchor` on one side, centred across.
 *
 * The main-axis delta lands the target's near edge `gap` from the anchor's far
 * edge; the cross-axis delta lines their centres up. Both are applied as a
 * translation of the stored x/y, which shifts the rotated bounds the same way.
 */
function placeRelativePatch(
  anchor: Described,
  target: Described,
  direction: Direction,
  gap: number,
): ElementPatch {
  if (direction === "above" || direction === "below") {
    const dy =
      direction === "below"
        ? anchor.bounds.maxY + gap - target.bounds.minY
        : anchor.bounds.minY - gap - target.bounds.maxY;
    const dx = centreX(anchor.bounds) - centreX(target.bounds);
    return { id: target.id, x: target.x + dx, y: target.y + dy };
  }
  const dx =
    direction === "right"
      ? anchor.bounds.maxX + gap - target.bounds.minX
      : anchor.bounds.minX - gap - target.bounds.maxX;
  const dy = centreY(anchor.bounds) - centreY(target.bounds);
  return { id: target.id, x: target.x + dx, y: target.y + dy };
}

/** The single coordinate every aligned element brings its footprint to. */
function alignReference(shapes: readonly Described[], alignment: Alignment): number {
  const boxes = shapes.map((shape) => shape.bounds);
  const minX = Math.min(...boxes.map((box) => box.minX));
  const maxX = Math.max(...boxes.map((box) => box.maxX));
  const minY = Math.min(...boxes.map((box) => box.minY));
  const maxY = Math.max(...boxes.map((box) => box.maxY));
  if (alignment === "left") return minX;
  if (alignment === "right") return maxX;
  if (alignment === "top") return minY;
  if (alignment === "bottom") return maxY;
  if (alignment === "centre-x") return (minX + maxX) / 2;
  return (minY + maxY) / 2; // centre-y
}

/** One element's move onto the alignment reference, or `null` if already there. */
function alignPatch(
  shape: Described,
  alignment: Alignment,
  reference: number,
): ElementPatch | null {
  const { bounds } = shape;
  if (alignment === "left") return shiftX(shape, reference - bounds.minX);
  if (alignment === "right") return shiftX(shape, reference - bounds.maxX);
  if (alignment === "centre-x") return shiftX(shape, reference - centreX(bounds));
  if (alignment === "top") return shiftY(shape, reference - bounds.minY);
  if (alignment === "bottom") return shiftY(shape, reference - bounds.maxY);
  return shiftY(shape, reference - centreY(bounds)); // centre-y
}

/**
 * The moves that even the gaps between a set along one axis.
 *
 * Sorted by position first, the two extremes are held and their footprints fix
 * the span; the total gap is what the span has left once every footprint's own
 * length is taken out, divided equally. Each inner element is then walked into
 * place one gap past the previous one. Only the along-axis coordinate is
 * written, so cross-axis position is preserved.
 */
function distributePatches(shapes: readonly Described[], axis: Axis): ElementPatch[] {
  const horizontal = axis === "horizontal";
  const near = (shape: Described): number => (horizontal ? shape.bounds.minX : shape.bounds.minY);
  const far = (shape: Described): number => (horizontal ? shape.bounds.maxX : shape.bounds.maxY);

  const sorted = [...shapes].sort((a, b) => {
    const byPosition = (near(a) + far(a)) / 2 - (near(b) + far(b)) / 2;
    if (byPosition !== 0) return byPosition;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const first = sorted[0];
  const last = sorted.at(-1);
  // The caller guarantees at least three, so both extremes and an inner element
  // exist; the guard is only here to satisfy the checked-index access.
  if (first === undefined || last === undefined) return [];

  const span = far(last) - near(first);
  const filled = sorted.reduce((total, shape) => total + (far(shape) - near(shape)), 0);
  const gap = (span - filled) / (sorted.length - 1);

  const patches: ElementPatch[] = [];
  let cursor = far(first);
  for (let index = 1; index < sorted.length - 1; index += 1) {
    const shape = sorted[index];
    if (shape === undefined) continue;
    const start = cursor + gap;
    const delta = start - near(shape);
    cursor = start + (far(shape) - near(shape));
    if (delta === 0) continue;
    patches.push(
      horizontal ? { id: shape.id, x: shape.x + delta } : { id: shape.id, y: shape.y + delta },
    );
  }
  return patches;
}

/** A patch that shifts an element along x, or `null` when the shift is zero. */
function shiftX(shape: Described, dx: number): ElementPatch | null {
  return dx === 0 ? null : { id: shape.id, x: shape.x + dx };
}

/** A patch that shifts an element along y, or `null` when the shift is zero. */
function shiftY(shape: Described, dy: number): ElementPatch | null {
  return dy === 0 ? null : { id: shape.id, y: shape.y + dy };
}

function countOf(elements: number): string {
  return `${elements} element${elements === 1 ? "" : "s"}`;
}
