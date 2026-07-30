/**
 * The shape an agent describes a drawing in.
 *
 * A deliberate narrowing of Excalidraw's own `ExcalidrawElementSkeleton`, not a
 * copy of it. A real Excalidraw element carries `seed`, `versionNonce`,
 * `updated`, `index`, `boundElements`, `roundness`, `points`,
 * `lastCommittedPoint` and `startBinding` — fields that mean nothing to a model,
 * bloat the tool schema and are exactly what one gets wrong. Everything here is
 * something a person drawing a diagram would say out loud.
 */
import { z } from "zod";

/** Element types the bridge can draw. */
export const DRAWABLE_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
] as const;

/** Types that can carry a label, and that an arrow can be bound to. */
export const LABELLABLE_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow"]);

/** Types an arrow may name as its start or end. */
export const BINDABLE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

const arrowhead = z.enum([
  "arrow",
  "bar",
  "dot",
  "circle",
  "circle_outline",
  "triangle",
  "triangle_outline",
  "diamond",
  "diamond_outline",
  "crowfoot_one",
  "crowfoot_many",
  "crowfoot_one_or_many",
]);

/** Everything that only changes how an element looks. */
const style = {
  strokeColor: z.string().optional().describe("Outline colour, e.g. `#1e1e1e`."),
  backgroundColor: z.string().optional().describe("Fill colour, or `transparent`."),
  fillStyle: z
    .enum(["hachure", "cross-hatch", "solid", "zigzag"])
    .optional()
    .describe("How the fill colour is applied."),
  strokeWidth: z.number().positive().optional().describe("Outline width in pixels."),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z
    .number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe("0 architect, 1 artist, 2 cartoonist."),
  opacity: z.number().min(0).max(100).optional(),
  roundness: z.boolean().optional().describe("Rounded corners. Ignored by types that have none."),
  groupIds: z
    .array(z.string())
    .optional()
    .describe("Groups this element belongs to. Elements sharing a group stay together."),
};

/**
 * A label, offered only by the types that can hold one.
 *
 * The objects below are strict, which is the whole guard: Excalidraw's own
 * converter drops a label on a `line` or a `text` without a word, and an agent
 * would go on believing it drew one nobody can see.
 */
const label = z
  .strictObject({ text: z.string().min(1).describe("Text to show inside the element.") })
  .describe("A text element bound inside this one. Shapes and arrows only.");

const endpoint = z
  .strictObject({ id: z.string().describe("Id of the shape this end attaches to.") })
  .describe("A rectangle, ellipse or diamond, in this room or in this same call.");

const shape = z.strictObject({
  type: z.enum(["rectangle", "ellipse", "diamond"]),
  id: z.string().optional().describe("Your own id, kept verbatim so you can refer to it later."),
  x: z.number().describe("Left edge, in scene coordinates."),
  y: z.number().describe("Top edge, in scene coordinates."),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  label: label.optional(),
  ...style,
});

const text = z.strictObject({
  type: z.literal("text"),
  id: z.string().optional(),
  x: z.number(),
  y: z.number(),
  text: z.string().min(1),
  ...style,
});

const line = z.strictObject({
  type: z.literal("line"),
  id: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().optional().describe("Horizontal extent; may be negative to run leftwards."),
  height: z.number().optional().describe("Vertical extent; may be negative to run upwards."),
  ...style,
});

const arrow = z.strictObject({
  type: z.literal("arrow"),
  id: z.string().optional(),
  x: z.number().optional().describe("Omit together with `y` to route between `start` and `end`."),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  start: endpoint.optional(),
  end: endpoint.optional(),
  label: label.optional(),
  startArrowhead: arrowhead.nullable().optional(),
  endArrowhead: arrowhead.nullable().optional(),
  ...style,
});

const frame = z.strictObject({
  type: z.literal("frame"),
  id: z.string().optional(),
  name: z.string().optional().describe("Caption shown above the frame."),
  children: z
    .array(z.string())
    .min(1)
    .describe("Ids of elements created in this same call that the frame holds."),
  x: z.number().optional().describe("Omit the whole box to fit the frame around its children."),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

/** One element, as an agent describes it. */
export const elementSkeletonSchema = z.discriminatedUnion("type", [
  shape,
  text,
  line,
  arrow,
  frame,
]);

export type ElementSkeleton = z.infer<typeof elementSkeletonSchema>;

/** A change to one element already in the room. */
export const elementPatchSchema = z.strictObject({
  id: z.string().describe("Id of the element to change."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  angle: z.number().optional().describe("Rotation in radians."),
  text: z.string().min(1).optional().describe("New text. Text elements only."),
  label: z
    .strictObject({ text: z.string().min(1) })
    .optional()
    .describe("New label text. Only for an element that already has a label."),
  ...style,
});

export type ElementPatch = z.infer<typeof elementPatchSchema>;
