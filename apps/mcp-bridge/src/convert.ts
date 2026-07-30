/**
 * From what an agent asked for to what the room stores.
 *
 * Three things happen here that Excalidraw's converter does not do. It is told
 * about the elements a new arrow binds to that are already in the room, because
 * upstream drops a binding it cannot resolve and reports nothing. Arrows are
 * routed between the shapes they join, because upstream binds without routing
 * and would leave a default 100x0 stub floating between the boxes. And the
 * result is reordered, because upstream returns elements in the order they were
 * listed — bound text at the very end, frames before their children, groups
 * scattered.
 */
import { randomUUID } from "node:crypto";
import type { SceneElement } from "./elements.ts";
import { loadExcalidraw } from "./excalidraw.ts";
import type { ElementSkeleton } from "./skeleton.ts";
import { BINDABLE_TYPES } from "./skeleton.ts";

/** One entry of an element's `boundElements`. */
export interface BoundRef {
  readonly id: string;
  readonly type: string;
}

export interface Conversion {
  /** New elements, in the order they must sit in the document. */
  readonly created: SceneElement[];
  /**
   * One id per skeleton, in the order they were given.
   *
   * What the caller gets back, and what it can name in a later call. Labels are
   * absent on purpose: the caller asked for a box with words in it, and the id
   * it can act on afterwards is the box's.
   */
  readonly ids: string[];
  /** `boundElements` for room elements a new arrow attached itself to, by id. */
  readonly rebound: ReadonlyMap<string, BoundRef[]>;
}

/** A box, in the only terms routing cares about. */
interface Box {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle: number;
}

/**
 * Builds the elements a call adds to a room.
 *
 * Nothing is written anywhere: this either returns everything the call
 * produces or throws, which is what makes a rejected call leave the room
 * exactly as it was.
 */
export async function convertSkeletons(
  skeletons: readonly ElementSkeleton[],
  existing: readonly SceneElement[],
): Promise<Conversion> {
  const inRoom = new Map(existing.map((element) => [element.id, element]));
  const ids = assignIds(skeletons, inRoom);
  const inCall = new Map(skeletons.map((skeleton, index) => [ids[index] ?? "", skeleton]));

  const bindings = validateBindings(skeletons, ids, inCall, inRoom);
  validateChildren(skeletons, ids, inCall, inRoom);

  const context = contextSkeletons(bindings, inRoom);
  const upstream = [
    ...context,
    ...skeletons.map((skeleton, index) => toUpstream(skeleton, ids[index] ?? "", inCall, inRoom)),
  ];

  const runtime = await loadExcalidraw();
  const converted = runtime.convert(upstream);

  const contextIds = new Set(context.map((element) => element.id));
  const created = converted.filter((element) => !contextIds.has(element.id));

  for (const element of created) {
    if (inRoom.has(element.id)) {
      throw new Error(`element id "${element.id}" is already in this room`);
    }
  }

  return { created: order(created, skeletons, ids), ids, rebound: rebind(bindings, inRoom) };
}

/** An arrow end, resolved to the element it names. */
interface Binding {
  readonly arrowId: string;
  readonly targetId: string;
  readonly fromRoom: boolean;
}

function assignIds(
  skeletons: readonly ElementSkeleton[],
  inRoom: ReadonlyMap<string, SceneElement>,
): string[] {
  const taken = new Set<string>();
  return skeletons.map((skeleton) => {
    const given = skeleton.id;
    if (given === undefined) {
      let generated = randomUUID();
      while (inRoom.has(generated) || taken.has(generated)) generated = randomUUID();
      taken.add(generated);
      return generated;
    }
    if (inRoom.has(given)) {
      throw new Error(
        `element id "${given}" is already in this room. Pick another id,` +
          " or change the element that is there with update_elements.",
      );
    }
    if (taken.has(given)) throw new Error(`element id "${given}" is used twice in this call`);
    taken.add(given);
    return given;
  });
}

function validateBindings(
  skeletons: readonly ElementSkeleton[],
  ids: readonly string[],
  inCall: ReadonlyMap<string, ElementSkeleton>,
  inRoom: ReadonlyMap<string, SceneElement>,
): Binding[] {
  const bindings: Binding[] = [];
  for (const [index, skeleton] of skeletons.entries()) {
    if (skeleton.type !== "arrow") continue;
    const arrowId = ids[index] ?? "";
    for (const end of [skeleton.start, skeleton.end]) {
      if (end === undefined) continue;
      const fromCall = inCall.get(end.id);
      const fromRoom = inRoom.get(end.id);
      const type = fromCall?.type ?? fromRoom?.type;
      if (type === undefined) {
        // Upstream drops a binding it cannot resolve and returns `null`.
        throw new Error(
          `arrow "${arrowId}" is bound to "${end.id}", which is neither in this room` +
            " nor created by this call",
        );
      }
      if (!BINDABLE_TYPES.has(type)) {
        throw new Error(
          `arrow "${arrowId}" is bound to "${end.id}", which is a ${type};` +
            " an arrow can only attach to a rectangle, an ellipse or a diamond",
        );
      }
      bindings.push({ arrowId, targetId: end.id, fromRoom: fromCall === undefined });
    }
  }
  return bindings;
}

function validateChildren(
  skeletons: readonly ElementSkeleton[],
  ids: readonly string[],
  inCall: ReadonlyMap<string, ElementSkeleton>,
  inRoom: ReadonlyMap<string, SceneElement>,
): void {
  for (const [index, skeleton] of skeletons.entries()) {
    if (skeleton.type !== "frame") continue;
    for (const child of skeleton.children) {
      if (inCall.has(child)) continue;
      throw new Error(
        inRoom.has(child)
          ? `frame "${ids[index]}" names child "${child}", which is already in this room;` +
              " a frame can only take children created in the same call"
          : `frame "${ids[index]}" names child "${child}", which is neither in this room` +
              " nor created by this call",
      );
    }
  }
}

/**
 * Stand-ins for the room elements a new arrow binds to.
 *
 * Upstream resolves a binding target out of its own store, so an element that
 * is only in the room is invisible to it — it logs and then invents a fresh
 * 100x100 shape in its place. Handing it the real geometry is what makes the
 * `focus` and `gap` it computes describe the shape that is actually there.
 * Their converted copies are thrown away; only the arrow's own binding and the
 * target's `boundElements` survive, and the latter is rebuilt from the stored
 * element rather than from the copy.
 */
function contextSkeletons(
  bindings: readonly Binding[],
  inRoom: ReadonlyMap<string, SceneElement>,
): SceneElement[] {
  const seen = new Set<string>();
  const context: SceneElement[] = [];
  for (const binding of bindings) {
    if (!binding.fromRoom || seen.has(binding.targetId)) continue;
    seen.add(binding.targetId);
    const element = inRoom.get(binding.targetId);
    if (element === undefined) continue;
    context.push({
      id: element.id,
      type: element.type,
      x: Number(element.x),
      y: Number(element.y),
      width: Number(element.width),
      height: Number(element.height),
      angle: Number(element.angle ?? 0),
    });
  }
  return context;
}

/** `boundElements` for each room element a new arrow attached itself to. */
function rebind(
  bindings: readonly Binding[],
  inRoom: ReadonlyMap<string, SceneElement>,
): Map<string, BoundRef[]> {
  const rebound = new Map<string, BoundRef[]>();
  for (const binding of bindings) {
    if (!binding.fromRoom) continue;
    const stored = inRoom.get(binding.targetId);
    if (stored === undefined) continue;
    const current = rebound.get(binding.targetId) ?? [
      ...((stored.boundElements as BoundRef[] | null) ?? []),
    ];
    if (!current.some((ref) => ref.id === binding.arrowId)) {
      current.push({ id: binding.arrowId, type: "arrow" });
    }
    rebound.set(binding.targetId, current);
  }
  return rebound;
}

/** One agent skeleton, in the shape Excalidraw's converter reads. */
function toUpstream(
  skeleton: ElementSkeleton,
  id: string,
  inCall: ReadonlyMap<string, ElementSkeleton>,
  inRoom: ReadonlyMap<string, SceneElement>,
): SceneElement {
  const { roundness, label, ...rest } = skeleton as ElementSkeleton & {
    roundness?: boolean;
    label?: { text: string };
  };
  const upstream: SceneElement = { ...(rest as SceneElement), id };

  if (roundness !== undefined) {
    upstream.roundness = roundness ? roundnessFor(skeleton.type) : null;
  }
  if (label !== undefined) upstream.label = { text: label.text };

  if (skeleton.type === "arrow") route(upstream, skeleton, inCall, inRoom);
  return upstream;
}

/**
 * Excalidraw's own rule for which rounding algorithm a type uses.
 *
 * `isUsingProportionalRadius` for linear elements and diamonds,
 * `isUsingAdaptiveRadius` for rectangles; anything else has no rounding to ask
 * for and gets none.
 */
function roundnessFor(type: string): { type: number } | null {
  if (type === "line" || type === "arrow" || type === "diamond") return { type: 2 };
  if (type === "rectangle") return { type: 3 };
  return null;
}

/**
 * Gives a bound arrow endpoints on the shapes it joins.
 *
 * Only when the caller named neither `x` nor `y`: geometry that was asked for
 * is honoured. The endpoints land exactly on the facing edges, and upstream
 * then nudges each of them half a pixel outwards as it binds — which is what
 * puts them outside both shapes and inside the gap it records.
 */
function route(
  upstream: SceneElement,
  skeleton: Extract<ElementSkeleton, { type: "arrow" }>,
  inCall: ReadonlyMap<string, ElementSkeleton>,
  inRoom: ReadonlyMap<string, SceneElement>,
): void {
  if (skeleton.x !== undefined || skeleton.y !== undefined) return;
  if (skeleton.start === undefined || skeleton.end === undefined) {
    throw new Error(
      `arrow "${String(upstream.id)}" needs either x and y, or both a start and an end to` +
        " route between",
    );
  }

  const from = boxOf(skeleton.start.id, inCall, inRoom);
  const to = boxOf(skeleton.end.id, inCall, inRoom);
  const fromCentre = centreOf(from);
  const toCentre = centreOf(to);
  if (fromCentre.x === toCentre.x && fromCentre.y === toCentre.y) {
    throw new Error(
      `arrow "${String(upstream.id)}" joins two elements with the same centre;` +
        " give it x and y so it has a direction",
    );
  }

  const start = edgePoint(from, toCentre);
  const end = edgePoint(to, fromCentre);
  upstream.x = start.x;
  upstream.y = start.y;
  upstream.width = end.x - start.x;
  upstream.height = end.y - start.y;
  upstream.points = [
    [0, 0],
    [end.x - start.x, end.y - start.y],
  ];
}

function boxOf(
  id: string,
  inCall: ReadonlyMap<string, ElementSkeleton>,
  inRoom: ReadonlyMap<string, SceneElement>,
): Box {
  const skeleton = inCall.get(id);
  if (skeleton !== undefined) {
    // Matches the defaults Excalidraw's converter applies to a shape whose box
    // the caller left out.
    const width = "width" in skeleton ? (skeleton.width ?? 100) : 100;
    const height = "height" in skeleton ? (skeleton.height ?? 100) : 100;
    const x = "x" in skeleton ? (skeleton.x ?? 0) : 0;
    const y = "y" in skeleton ? (skeleton.y ?? 0) : 0;
    return { type: skeleton.type, x, y, width, height, angle: 0 };
  }

  const element = inRoom.get(id);
  if (element === undefined) throw new Error(`element "${id}" is not in this room`);
  return {
    type: element.type,
    x: Number(element.x),
    y: Number(element.y),
    width: Number(element.width),
    height: Number(element.height),
    angle: Number(element.angle ?? 0),
  };
}

function centreOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Where a ray from the centre of `box` towards `towards` leaves the shape.
 *
 * Computed in the box's own frame so a rotated element — which only a person
 * can produce, but a person shares the board — is met on its real outline.
 */
function edgePoint(box: Box, towards: { x: number; y: number }): { x: number; y: number } {
  const centre = centreOf(box);
  const cos = Math.cos(-box.angle);
  const sin = Math.sin(-box.angle);
  const dx = towards.x - centre.x;
  const dy = towards.y - centre.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  const halfWidth = Math.max(box.width / 2, 1e-6);
  const halfHeight = Math.max(box.height / 2, 1e-6);
  const scale = reachOf(box.type, localX / halfWidth, localY / halfHeight);
  const edgeX = localX * scale;
  const edgeY = localY * scale;

  return {
    x: centre.x + (edgeX * cos + edgeY * sin),
    y: centre.y + (-edgeX * sin + edgeY * cos),
  };
}

/** How far along a unit-box direction the outline sits, per shape. */
function reachOf(type: string, unitX: number, unitY: number): number {
  if (type === "ellipse") return 1 / Math.hypot(unitX, unitY);
  // |x| + |y| = 1 is the rhombus Excalidraw draws for a diamond.
  if (type === "diamond") return 1 / (Math.abs(unitX) + Math.abs(unitY));
  return 1 / Math.max(Math.abs(unitX), Math.abs(unitY));
}

/** A container and the label bound to it, which never come apart. */
interface Block {
  readonly ids: string[];
  readonly lead: SceneElement;
}

/**
 * The order the new elements go into the document in.
 *
 * Request order, then three rules on top of it: a label sits immediately after
 * its container, the members of a group sit together, and a frame's children
 * sit immediately before the frame. None of them is what upstream's converter
 * returns, and all three are what Excalidraw's own code assumes.
 */
function order(
  created: readonly SceneElement[],
  skeletons: readonly ElementSkeleton[],
  ids: readonly string[],
): SceneElement[] {
  const byId = new Map(created.map((element) => [element.id, element]));
  const blocks: Block[] = [];
  const placed = new Set<string>();

  for (let index = 0; index < skeletons.length; index += 1) {
    const id = ids[index] ?? "";
    const lead = byId.get(id);
    if (lead === undefined) continue;
    const bound = created.filter((element) => element.containerId === id);
    blocks.push({ ids: [id, ...bound.map((element) => element.id)], lead });
    placed.add(id);
    for (const element of bound) placed.add(element.id);
  }
  // Anything upstream produced that no skeleton asked for by name; there is
  // nothing today, and dropping it silently would be the wrong way to find out.
  for (const element of created) {
    if (!placed.has(element.id)) blocks.push({ ids: [element.id], lead: element });
  }

  const grouped = gather(blocks, (block) => {
    const groups = block.lead.groupIds;
    return Array.isArray(groups) && groups.length > 0 ? String(groups.at(-1)) : null;
  });
  const framed = liftFrames(grouped);

  return framed.flatMap((block) => block.ids.flatMap((id) => byId.get(id) ?? []));
}

/** Pulls blocks sharing a key together, at the position of the first of them. */
function gather(blocks: readonly Block[], keyOf: (block: Block) => string | null): Block[] {
  const result: Block[] = [];
  const taken = new Set<Block>();
  for (const block of blocks) {
    if (taken.has(block)) continue;
    const key = keyOf(block);
    taken.add(block);
    result.push(block);
    if (key === null) continue;
    for (const other of blocks) {
      if (taken.has(other) || keyOf(other) !== key) continue;
      taken.add(other);
      result.push(other);
    }
  }
  return result;
}

/** Moves each frame's children to sit immediately before it. */
function liftFrames(blocks: readonly Block[]): Block[] {
  const result: Block[] = [];
  const taken = new Set<Block>();

  for (const block of blocks) {
    if (taken.has(block)) continue;
    if (block.lead.type === "frame") {
      for (const child of blocks) {
        if (taken.has(child) || child === block) continue;
        if (child.lead.frameId !== block.lead.id) continue;
        taken.add(child);
        result.push(child);
      }
      taken.add(block);
      result.push(block);
      continue;
    }
    // A child waits for its frame; every frame in this call is in `blocks`.
    if (typeof block.lead.frameId === "string") continue;
    taken.add(block);
    result.push(block);
  }

  for (const block of blocks) {
    if (!taken.has(block)) result.push(block);
  }
  return result;
}
