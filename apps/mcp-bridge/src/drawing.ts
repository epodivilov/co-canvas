/**
 * The three tools that draw.
 *
 * Every one of them takes the same route: validate, build everything the call
 * produces, then write it all in a single Yjs transaction. A rejected call has
 * written nothing by the time it fails, and an accepted one is never observable
 * half-applied — no peer ever sees a diagram with some of its boxes missing.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as Y from "yjs";
import { z } from "zod";
import type { BoundRef } from "./convert.ts";
import { convertSkeletons } from "./convert.ts";
import { num } from "./describe.ts";
import type { SceneElement } from "./elements.ts";
import {
  appendElements,
  elementsOf,
  readScene,
  removeElements,
  replaceElement,
} from "./elements.ts";
import { loadExcalidraw } from "./excalidraw.ts";
import type { RoomAccess } from "./room.ts";
import { openRoom } from "./room.ts";
import type { ElementPatch, ElementSkeleton } from "./skeleton.ts";
import { elementPatchSchema, elementSkeletonSchema } from "./skeleton.ts";

/** Fields of a bound label that only its container may decide. */
const LABEL_GEOMETRY_FIELDS = ["x", "y", "width", "height", "angle"] as const;

/** Fields a re-fitted label takes from the conversion, and nothing else. */
const LABEL_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  // Excalidraw keeps a bound text at its container's angle; leaving it flat
  // under a turned container is a state the app itself never produces.
  "angle",
  "text",
  "originalText",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "textAlign",
  "verticalAlign",
  "autoResize",
] as const;

const slugArgument = z.string().describe("Board slug, e.g. `auth-redesign`.");

const resultShape = {
  slug: z.string().describe("The board that changed."),
  url: z.string().describe("URL a browser opens the board at."),
  ids: z.array(z.string()).describe("Ids of the elements this call touched, in order."),
  shapes: z
    .array(
      z.object({
        id: z.string(),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
    )
    .describe(
      "The final box of each element this call touched — after any bound-label grow," +
        " read back from the document. Place the next element against these, not against the" +
        " sizes requested. Only the box (x/y/width/height) equals what describe_scene reports" +
        " for the same element; describe_scene's shapes also carry type, angle, bounds, points" +
        " and bindings, none of which a draw response returns.",
    ),
};

export function registerDrawingTools(server: McpServer, deps: RoomAccess): void {
  server.registerTool(
    "add_elements",
    {
      title: "Draw on a board",
      description:
        "Adds elements to an existing co-canvas board. Describe each one the way you would" +
        ' say it out loud — a box is `{ type: "rectangle", x, y, width, height,' +
        " label: { text } }` — and the bridge turns it into a real Excalidraw element." +
        " Give an element your own `id` to refer to it from a later call. New elements are" +
        " drawn on top of whatever is already there.",
      inputSchema: {
        slug: slugArgument,
        elements: z.array(elementSkeletonSchema).min(1).describe("Elements to draw, in order."),
      },
      outputSchema: resultShape,
    },
    async ({ slug, elements }) => {
      const room = await openRoom(deps, slug);
      const ids = await addElements(room.doc, elements);
      return answer(slug, room.url, room.doc, ids, `Drew ${count(ids.length)} on board "${slug}"`);
    },
  );

  server.registerTool(
    "update_elements",
    {
      title: "Change elements on a board",
      description:
        "Changes elements already on a co-canvas board, by id. Name only the fields you want" +
        " different; everything else is left as it is. Moving an element carries its label" +
        " along, and changing a label re-fits it to its container.",
      inputSchema: {
        slug: slugArgument,
        patches: z.array(elementPatchSchema).min(1).describe("One change per element."),
      },
      outputSchema: resultShape,
    },
    async ({ slug, patches }) => {
      const room = await openRoom(deps, slug);
      const ids = await updateElements(room.doc, patches);
      return answer(
        slug,
        room.url,
        room.doc,
        ids,
        `Changed ${count(ids.length)} on board "${slug}"`,
      );
    },
  );

  server.registerTool(
    "delete_elements",
    {
      title: "Remove elements from a board",
      description:
        "Removes elements from a co-canvas board, by id. A container's label goes with it," +
        " and nothing left behind keeps pointing at what is gone. The `ids` field lists what" +
        " was removed, labels included; `shapes` is always empty here, since removed elements" +
        " have no geometry left to read back — do not read that empty `shapes` as nothing" +
        " having been touched.",
      inputSchema: {
        slug: slugArgument,
        ids: z.array(z.string()).min(1).describe("Ids of the elements to remove."),
      },
      outputSchema: resultShape,
    },
    async ({ slug, ids }) => {
      const room = await openRoom(deps, slug);
      const removed = deleteElements(room.doc, ids);
      return answer(
        slug,
        room.url,
        room.doc,
        removed,
        `Removed ${count(removed.length)} from "${slug}"`,
      );
    },
  );
}

/** Adds elements to a room; answers with one id per element asked for. */
export async function addElements(
  doc: Y.Doc,
  skeletons: readonly ElementSkeleton[],
): Promise<string[]> {
  const yElements = elementsOf(doc);
  const before = readScene(yElements);
  const { created, ids, rebound } = await convertSkeletons(skeletons, before);

  doc.transact(() => {
    for (const [id, boundElements] of rebound) {
      const stored = before.find((element) => element.id === id);
      if (stored === undefined) continue;
      replaceElement(yElements, touch({ ...stored, boundElements }));
    }
    // `index` is the one field Excalidraw repairs on its own: `updateScene`
    // runs `syncInvalidIndices` and assigns it from the order the binding
    // produced, which is the `pos` order. Anything else has to be right here.
    appendElements(
      yElements,
      created.map((element) => ({ ...element, index: null })),
    );
  });

  return ids;
}

/** Applies patches to a room; answers with the ids it changed. */
export async function updateElements(
  doc: Y.Doc,
  patches: readonly ElementPatch[],
): Promise<string[]> {
  const yElements = elementsOf(doc);
  const scene = readScene(yElements);
  const byId = new Map(scene.map((element) => [element.id, element]));

  for (const patch of patches) {
    if (byId.has(patch.id)) continue;
    throw new Error(`element "${patch.id}" is not on this board`);
  }

  const changed = new Map<string, SceneElement>();
  for (const patch of patches) {
    // Read through `changed` so two patches naming the same element compose
    // rather than the second one discarding the first.
    const stored = changed.get(patch.id) ?? byId.get(patch.id);
    if (stored === undefined) continue;
    for (const element of await applyPatch(stored, patch, changed, byId)) {
      changed.set(element.id, element);
    }
  }

  doc.transact(() => {
    for (const element of changed.values()) replaceElement(yElements, touch(element));
  });

  return patches.map((patch) => patch.id);
}

/** Removes elements from a room; answers with everything it took, labels included. */
export function deleteElements(doc: Y.Doc, ids: readonly string[]): string[] {
  const yElements = elementsOf(doc);
  const scene = readScene(yElements);
  const byId = new Map(scene.map((element) => [element.id, element]));

  for (const id of ids) {
    if (byId.has(id)) continue;
    throw new Error(`element "${id}" is not on this board`);
  }

  const removed = new Set(ids);
  for (const id of ids) {
    // A container's label is part of the container: leaving it would strand a
    // text element whose `containerId` names nothing.
    for (const ref of boundRefs(byId.get(id))) {
      if (ref.type === "text") removed.add(ref.id);
    }
  }

  const survivors: SceneElement[] = [];
  for (const element of scene) {
    if (removed.has(element.id)) continue;
    const next = forget(element, removed);
    if (next !== null) survivors.push(next);
  }

  doc.transact(() => {
    for (const element of survivors) replaceElement(yElements, touch(element));
    removeElements(yElements, removed);
  });

  return [...removed];
}

/** The elements one patch changes: the element itself, and its label if it has one. */
async function applyPatch(
  stored: SceneElement,
  patch: ElementPatch,
  changed: ReadonlyMap<string, SceneElement>,
  byId: ReadonlyMap<string, SceneElement>,
): Promise<SceneElement[]> {
  const { id: _id, label, roundness, text, ...fields } = patch;

  // A bound label's box is its container's to decide: the position, the
  // wrapping and the size all come out of the container's geometry, and moving
  // one by hand breaks the fit R2 requires with nothing to put it back. The
  // container is what a caller changes, and the label follows it.
  if (typeof stored.containerId === "string") {
    const owned = LABEL_GEOMETRY_FIELDS.filter((field) => patch[field] !== undefined);
    if (owned.length > 0 || text !== undefined) {
      const named = [...owned, ...(text === undefined ? [] : ["text"])].join(", ");
      throw new Error(
        `element "${stored.id}" is the label of "${String(stored.containerId)}";` +
          ` change ${named} through its container instead`,
      );
    }
  }

  const next: SceneElement = { ...stored };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) next[key] = value;
  }
  if (roundness !== undefined) {
    next.roundness = roundness ? roundnessFor(stored.type) : null;
  }

  const boundTextId = boundRefs(stored).find((ref) => ref.type === "text")?.id;

  if (text !== undefined) {
    if (stored.type !== "text") {
      throw new Error(`element "${stored.id}" is a ${stored.type}; only a text element has text`);
    }
    next.text = text;
    next.originalText = text;
    return [await remeasure(next)];
  }

  if (label !== undefined && boundTextId === undefined) {
    throw new Error(
      `element "${stored.id}" has no label to change; add one with the element itself`,
    );
  }
  if (boundTextId === undefined) return [next];

  const storedLabel = changed.get(boundTextId) ?? byId.get(boundTextId);
  if (storedLabel === undefined) return [next];
  return refit(next, storedLabel, label?.text ?? String(storedLabel.originalText ?? ""));
}

/**
 * Re-runs the conversion for a container and its label, and takes the geometry.
 *
 * The wrapping, the padding, how far a container has to grow — all of it is
 * Excalidraw's, and reproducing it here would be a second implementation to
 * keep in step. Only the fields that describe where the text sits are taken
 * back; nothing else about either element is touched.
 */
async function refit(
  container: SceneElement,
  label: SceneElement,
  text: string,
): Promise<SceneElement[]> {
  const skeleton: SceneElement = {
    id: container.id,
    type: container.type,
    x: Number(container.x),
    y: Number(container.y),
    width: Number(container.width),
    height: Number(container.height),
    // Carried so upstream hands the label its container's angle back.
    angle: Number(container.angle ?? 0),
    label: { id: label.id, text },
  };
  // An arrow's label is placed along its points, so they have to travel too.
  if (container.type === "arrow") skeleton.points = container.points;

  const runtime = await loadExcalidraw();
  const converted = runtime.convert([skeleton]);
  const fittedContainer = converted.find((element) => element.id === container.id);
  const fittedLabel = converted.find((element) => element.containerId === container.id);
  if (fittedContainer === undefined || fittedLabel === undefined) {
    throw new Error(`could not re-fit the label of "${container.id}"`);
  }

  const nextContainer = { ...container };
  // A container grows to hold a label that outgrew it — except an arrow, whose
  // width is its geometry rather than a box around its text.
  if (container.type !== "arrow") {
    nextContainer.width = fittedContainer.width;
    nextContainer.height = fittedContainer.height;
  }

  const nextLabel = { ...label };
  for (const field of LABEL_FIELDS) nextLabel[field] = fittedLabel[field];

  return [nextContainer, nextLabel];
}

/** Re-measures a standalone text element after its text changed. */
async function remeasure(element: SceneElement): Promise<SceneElement> {
  const runtime = await loadExcalidraw();
  const [measured] = runtime.convert([
    {
      id: element.id,
      type: "text",
      x: Number(element.x),
      y: Number(element.y),
      text: String(element.text),
      fontSize: element.fontSize,
      fontFamily: element.fontFamily,
    },
  ]);
  if (measured === undefined) throw new Error(`could not measure the text of "${element.id}"`);
  return { ...element, width: measured.width, height: measured.height };
}

/**
 * The element with every reference to a removed id dropped.
 *
 * `null` when there was nothing to drop, so an unrelated element is never
 * rewritten — a version bump on an element nobody touched would show up as a
 * change on every other peer.
 */
function forget(element: SceneElement, removed: ReadonlySet<string>): SceneElement | null {
  const next: SceneElement = { ...element };
  let touched = false;

  const bound = boundRefs(element);
  const kept = bound.filter((ref) => !removed.has(ref.id));
  if (kept.length !== bound.length) {
    next.boundElements = kept.length === 0 ? null : kept;
    touched = true;
  }

  for (const side of ["startBinding", "endBinding"] as const) {
    const binding = element[side] as { elementId?: unknown } | null | undefined;
    if (binding == null || typeof binding !== "object") continue;
    if (typeof binding.elementId !== "string" || !removed.has(binding.elementId)) continue;
    next[side] = null;
    touched = true;
  }

  if (typeof element.frameId === "string" && removed.has(element.frameId)) {
    next.frameId = null;
    touched = true;
  }
  if (typeof element.containerId === "string" && removed.has(element.containerId)) {
    next.containerId = null;
    touched = true;
  }

  return touched ? next : null;
}

function boundRefs(element: SceneElement | undefined): BoundRef[] {
  const bound = element?.boundElements;
  return Array.isArray(bound) ? (bound as BoundRef[]) : [];
}

/**
 * Marks an element as changed.
 *
 * `y-excalidraw` compares an element it already holds against an incoming one
 * by id and version alone, so an element whose version stood still is one the
 * browser keeps rendering from its own copy.
 */
function touch(element: SceneElement): SceneElement {
  const previous = Number(element.versionNonce);
  let versionNonce = randomNonce();
  while (versionNonce === previous) versionNonce = randomNonce();
  return {
    ...element,
    version: Number(element.version ?? 0) + 1,
    versionNonce,
    updated: Date.now(),
  };
}

function randomNonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Excalidraw's own rule for which rounding algorithm a type uses. */
function roundnessFor(type: string): { type: number } | null {
  if (type === "line" || type === "arrow" || type === "diamond") return { type: 2 };
  if (type === "rectangle") return { type: 3 };
  return null;
}

function count(elements: number): string {
  return `${elements} element${elements === 1 ? "" : "s"}`;
}

/** The final box of one element a call touched, read back after the write. */
interface TouchedShape {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function answer(
  slug: string,
  url: string,
  doc: Y.Doc,
  ids: readonly string[],
  summary: string,
): {
  content: { type: "text"; text: string }[];
  structuredContent: { slug: string; url: string; ids: string[]; shapes: TouchedShape[] };
} {
  return {
    content: [{ type: "text", text: `${summary}: ${url}` }],
    structuredContent: { slug, url, ids: [...ids], shapes: touchedGeometry(doc, ids) },
  };
}

/**
 * The final box of each touched element, read back from the document.
 *
 * From the stored element rather than from the input skeleton: a container
 * grows to hold a bound label that outgrew it, so the requested size is a box
 * that is not on the board. Reading it back is also what makes the geometry
 * agree with a later `describe_scene`, which reads the same stored element. A
 * removed id is gone from the document and drops out here.
 *
 * The scene is re-read once per call rather than threaded through the write.
 * A draw is not a hot path, and re-reading is the plainest way to guarantee the
 * geometry is exactly what `describe_scene` would read from the same document.
 */
function touchedGeometry(doc: Y.Doc, ids: readonly string[]): TouchedShape[] {
  const byId = new Map(readScene(elementsOf(doc)).map((element) => [element.id, element]));
  const shapes: TouchedShape[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    // `update_elements` composes patches, so `ids` can name one element twice;
    // `describe_scene` reports each element once, and this has to match it. The
    // returned `ids` array keeps every entry — only the geometry is de-duped.
    if (seen.has(id)) continue;
    seen.add(id);
    const element = byId.get(id);
    if (element === undefined) continue;
    // `num`, the same finite-guard `describe_scene` uses: a non-finite stored
    // value reads back as 0 on both paths, so they never disagree (R4).
    shapes.push({
      id,
      x: num(element.x),
      y: num(element.y),
      width: num(element.width),
      height: num(element.height),
    });
  }
  return shapes;
}
