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
import { boardUrl } from "./board.ts";
import type { RoomConnections } from "./connections.ts";
import type { BoundRef } from "./convert.ts";
import { convertSkeletons } from "./convert.ts";
import type { SceneElement } from "./elements.ts";
import {
  appendElements,
  elementsOf,
  readScene,
  removeElements,
  replaceElement,
} from "./elements.ts";
import { loadExcalidraw } from "./excalidraw.ts";
import type { HubAccess } from "./hub.ts";
import { acquireHub, listHubRooms } from "./hub.ts";
import type { ElementPatch, ElementSkeleton } from "./skeleton.ts";
import { elementPatchSchema, elementSkeletonSchema } from "./skeleton.ts";
import { assertRoomSlug } from "./slug.ts";

/** What the drawing tools need from the rest of the bridge. */
export interface DrawingDeps {
  readonly access: HubAccess;
  /** CC-15's per-room cache. These tools open no connection of their own. */
  readonly connections: RoomConnections;
}

/** Fields a re-fitted label takes from the conversion, and nothing else. */
const LABEL_FIELDS = [
  "x",
  "y",
  "width",
  "height",
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
};

export function registerDrawingTools(server: McpServer, deps: DrawingDeps): void {
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
      return answer(slug, room.url, ids, `Drew ${count(ids.length)} on board "${slug}"`);
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
      return answer(slug, room.url, ids, `Changed ${count(ids.length)} on board "${slug}"`);
    },
  );

  server.registerTool(
    "delete_elements",
    {
      title: "Remove elements from a board",
      description:
        "Removes elements from a co-canvas board, by id. A container's label goes with it," +
        " and nothing left behind keeps pointing at what is gone.",
      inputSchema: {
        slug: slugArgument,
        ids: z.array(z.string()).min(1).describe("Ids of the elements to remove."),
      },
      outputSchema: resultShape,
    },
    async ({ slug, ids }) => {
      const room = await openRoom(deps, slug);
      const removed = deleteElements(room.doc, ids);
      return answer(slug, room.url, removed, `Removed ${count(removed.length)} from "${slug}"`);
    },
  );
}

/**
 * The document behind a board, and the URL it opens at.
 *
 * The room has to exist first. The hub creates a room on first connect, so the
 * check happens before the socket does — otherwise a typo would quietly make a
 * second board and draw on it, which is the same stance `open_room` takes.
 */
async function openRoom(deps: DrawingDeps, slug: string): Promise<{ doc: Y.Doc; url: string }> {
  assertRoomSlug(slug);
  const hub = await acquireHub(deps.access);
  const rooms = await listHubRooms(hub.url);
  if (!rooms.some((room) => room.slug === slug)) {
    throw new Error(
      `no board named "${slug}" is open. Call create_room with slug "${slug}" first.`,
    );
  }
  const connection = await deps.connections.open(hub.url, slug);
  return { doc: connection.doc, url: boardUrl(hub.url, slug) };
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
    if (typeof stored.containerId === "string") {
      throw new Error(
        `element "${stored.id}" is a label; change it through its container's \`label\` instead`,
      );
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

function answer(
  slug: string,
  url: string,
  ids: readonly string[],
  summary: string,
): {
  content: { type: "text"; text: string }[];
  structuredContent: { slug: string; url: string; ids: string[] };
} {
  return {
    content: [{ type: "text", text: `${summary}: ${url}` }],
    structuredContent: { slug, url, ids: [...ids] },
  };
}
