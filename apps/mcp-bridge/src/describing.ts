/**
 * The tool that reads.
 *
 * `describe_scene` is the other half of the agent loop CC-16 opened: without it
 * an agent draws blind and cannot touch a board a person has already edited.
 * Every call renders the room as it is at that moment — nothing is cached
 * between calls, and nothing is held between them either.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Described } from "./describe.ts";
import { describeScene } from "./describe.ts";
import { elementsOf, readScene } from "./elements.ts";
import type { RoomAccess } from "./room.ts";
import { openRoom } from "./room.ts";

const extentShape = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});

/**
 * One element's structured geometry (CC-28).
 *
 * The same box the text's `GEOMETRY` appendix reports, plus the identity and
 * bindings an agent computes placement from: it reads topology from the text
 * and computes intersections from this. An arrow carries its endpoints in
 * absolute scene coordinates, and the ids its ends bind to.
 */
const shapeShape = z.object({
  id: z.string().describe("The element's id."),
  type: z.string().describe("Its Excalidraw type, e.g. `rectangle` or `arrow`."),
  x: z.number().describe("Left edge of the stored box, in scene units."),
  y: z.number().describe("Top edge of the stored box, in scene units."),
  width: z.number().describe("Stored width, after any bound-label grow."),
  height: z.number().describe("Stored height, after any bound-label grow."),
  angle: z.number().describe("Rotation in radians, as Excalidraw stores it."),
  label: z.string().nullable().describe("Its label, or a text element's own text; null when none."),
  name: z.string().nullable().describe("A frame's caption; null for everything else."),
  frameId: z.string().nullable().describe("The frame that holds it, or null."),
  groupIds: z.array(z.string()).describe("Groups it belongs to, outermost last."),
  startBinding: z
    .string()
    .nullable()
    .describe("For an arrow, the id its start attaches to; null otherwise."),
  endBinding: z
    .string()
    .nullable()
    .describe("For an arrow, the id its end attaches to; null otherwise."),
  points: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .nullable()
    .describe("For a linear element, its points in absolute scene coordinates; null otherwise."),
});

/** A `Described` element as the tool reports it — its box, identity and bindings. */
function toShape(shape: Described): z.infer<typeof shapeShape> {
  return {
    id: shape.id,
    type: shape.type,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    angle: shape.angle,
    label: shape.label,
    name: shape.name,
    frameId: shape.frameId,
    groupIds: [...shape.groupIds],
    startBinding: shape.startBinding,
    endBinding: shape.endBinding,
    points:
      shape.points === null ? null : shape.points.map((point) => ({ x: point.x, y: point.y })),
  };
}

export function registerDescribeTool(server: McpServer, deps: RoomAccess): void {
  server.registerTool(
    "describe_scene",
    {
      title: "Read a board",
      description:
        "Describes everything on a co-canvas board as text: what is on it, what each element" +
        " is called, which arrows connect what, which frames and groups hold what, and where" +
        " every element sits. Read this before drawing on a board that is not empty — the" +
        " coordinates it reports are the ones to place new elements against.",
      inputSchema: { slug: z.string().describe("Board slug, e.g. `auth-redesign`.") },
      outputSchema: {
        slug: z.string().describe("The board that was read."),
        elements: z.number().int().describe("Elements the board holds, labels included."),
        nodes: z
          .number()
          .int()
          .describe("Elements described as nodes: everything but arrows, frames and labels."),
        arrows: z.number().int().describe("Arrows on the board."),
        extent: extentShape
          .nullable()
          .describe("Box enclosing everything on the board; null when it is empty."),
        shapes: z
          .array(shapeShape)
          .describe(
            "Per-element geometry for everything the text describes — box, identity and" +
              " bindings — as JSON to compute placement from. Read topology from the text and" +
              " intersections from this.",
          ),
      },
    },
    async ({ slug }) => {
      const room = await openRoom(deps, slug);
      const { text, summary, shapes } = describeScene(readScene(elementsOf(room.doc)));

      // The description travels as text and the geometry as structured content.
      // The text carries the topology the CC-9 format proved at reading it; the
      // structured `shapes` carry each element's box and identity so an agent
      // computes placement rather than parsing it out of prose (CC-28). What is
      // not sent twice is the prose itself — the rendered headings, grid and
      // geometry lines. The SDK validates structured content against the schema
      // above but never synthesises text from it, so the text block is this
      // tool's to write.
      return {
        content: [{ type: "text", text }],
        structuredContent: { slug, ...summary, shapes: shapes.map(toShape) },
      };
    },
  );
}
