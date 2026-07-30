/**
 * Element builders for the renderer scenarios.
 *
 * Deliberately not in `test-helpers.ts`: that module stands a hub up and pulls
 * the MCP SDK, `y-websocket` and Yjs in behind it, and the renderer is a pure
 * function over plain objects. A scenario that only renders should cost a
 * function call, not a server.
 *
 * The shapes here are the ones Excalidraw actually stores — a label is a `text`
 * element carrying `containerId`, a linear element's `points` are relative to
 * its own `x`/`y`, and an angle is in radians — so a scenario built from them
 * is asking the renderer the same question a real room does.
 */
import type { SceneElement } from "./elements.ts";

/** Fields every stored element carries, whatever its type. */
const BASE = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 0,
  link: null,
  locked: false,
} as const;

/** Any element, with every field a stored one carries filled in. */
export function el(element: Partial<SceneElement> & { id: string; type: string }): SceneElement {
  return { ...BASE, ...element };
}

/** A box-shaped element: rectangle, ellipse, diamond, image, freedraw, … */
export function box(
  type: string,
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<SceneElement> = {},
): SceneElement {
  return el({ id, type, x, y, width, height, ...extra });
}

/** A rectangle, the shape most of these scenarios are built out of. */
export function rect(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<SceneElement> = {},
): SceneElement {
  return box("rectangle", id, x, y, width, height, extra);
}

/**
 * A text element bound to `containerId`.
 *
 * `text` is what Excalidraw wrapped and `originalText` is what the person
 * typed; passing them separately is how a wrapped label is exercised.
 */
export function label(
  id: string,
  containerId: string,
  text: string,
  originalText: string = text,
  extra: Partial<SceneElement> = {},
): SceneElement {
  return el({
    id,
    type: "text",
    containerId,
    text,
    originalText,
    fontSize: 20,
    width: 80,
    height: 25,
    ...extra,
  });
}

/** A standalone text element — a loose note, with no container. */
export function note(
  id: string,
  x: number,
  y: number,
  text: string,
  extra: Partial<SceneElement> = {},
): SceneElement {
  return el({
    id,
    type: "text",
    containerId: null,
    text,
    originalText: text,
    fontSize: 20,
    x,
    y,
    width: Math.max(1, text.length * 10),
    height: 25,
    ...extra,
  });
}

/** A linear element — `type` is `arrow` or `line`; `points` are relative to `x`/`y`. */
export function linear(
  type: string,
  id: string,
  x: number,
  y: number,
  points: readonly (readonly [number, number])[],
  extra: Partial<SceneElement> = {},
): SceneElement {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  return el({
    id,
    type,
    x,
    y,
    points: points.map((point) => [...point]),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: type === "arrow" ? "arrow" : null,
    ...extra,
  });
}

/** An arrow, optionally bound at either end. */
export function arrow(
  id: string,
  x: number,
  y: number,
  points: readonly (readonly [number, number])[],
  bindings: { from?: string; to?: string } = {},
  extra: Partial<SceneElement> = {},
): SceneElement {
  return linear("arrow", id, x, y, points, {
    ...(bindings.from === undefined
      ? {}
      : { startBinding: { elementId: bindings.from, focus: 0, gap: 4 } }),
    ...(bindings.to === undefined
      ? {}
      : { endBinding: { elementId: bindings.to, focus: 0, gap: 4 } }),
    ...extra,
  });
}

/** A frame. `name` is `null` for one nobody has named, which is what Excalidraw creates. */
export function frame(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  name: string | null,
  extra: Partial<SceneElement> = {},
): SceneElement {
  return el({ id, type: "frame", x, y, width, height, name, ...extra });
}

/** Degrees as Excalidraw stores them. */
export function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * The description split into its sections, keyed by heading.
 *
 * A scenario that grepped the whole description for a substring would pass on
 * output whose sections had run into each other, which is exactly what a label
 * carrying a newline would produce. Splitting on the headings first means every
 * assertion below is about a line in the section it belongs to.
 */
export function sections(description: string): Map<string, string[]> {
  const headings = new Set(["NODES", "CONTAINERS", "ARROWS", "GEOMETRY"]);
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of description.split("\n")) {
    if (line === "") continue;
    const heading = line.split(" ")[0] ?? "";
    if (!line.startsWith(" ") && headings.has(heading)) {
      current = [];
      found.set(heading, current);
      continue;
    }
    // Anything else at column zero ends the section it follows: a label that
    // leaked a newline lands here rather than passing as one more entry.
    if (!line.startsWith("  ")) {
      current = null;
      continue;
    }
    current?.push(line.slice(2));
  }
  return found;
}

/** The lines of one section, or `[]` when the description has no such section. */
export function section(description: string, heading: string): string[] {
  return sections(description).get(heading) ?? [];
}

/** The id every node, arrow, frame or geometry line opens with. */
export function idOf(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}
