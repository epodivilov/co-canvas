/**
 * The room document's element layer.
 *
 * `yElements` is a `Y.Array` of `Y.Map`s, one per element, each holding the
 * whole element under `el` and a `fractional-indexing` key under `pos`. The
 * z-order is the `pos` sort, not the array order — appending means naming a key
 * after the largest one, wherever in the array that happens to live.
 *
 * This is the layout `y-excalidraw` implements in the browser, and every rule
 * here exists because that binding depends on it.
 */
import { ELEMENTS_KEY } from "@co-canvas/protocol";
import { generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";

/** An Excalidraw element as it is stored: plain data, no class, no undefined. */
export type SceneElement = { id: string; type: string } & Record<string, unknown>;

/** One entry of the array, with the key that decides where it draws. */
export interface StoredEntry {
  readonly pos: string;
  readonly el: SceneElement;
  /** The map itself, so an update can be written into the entry that is there. */
  readonly map: Y.Map<unknown>;
}

/** The room's element array. */
export function elementsOf(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(ELEMENTS_KEY);
}

/** Every entry, in z-order. */
export function readEntries(yElements: Y.Array<Y.Map<unknown>>): StoredEntry[] {
  return yElements
    .toArray()
    .map((map) => ({ pos: String(map.get("pos")), el: map.get("el") as SceneElement, map }))
    .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
}

/** Every element, in z-order. */
export function readScene(yElements: Y.Array<Y.Map<unknown>>): SceneElement[] {
  return readEntries(yElements).map((entry) => entry.el);
}

/**
 * Appends elements after everything already in the room, in the order given.
 *
 * The keys are drawn from the largest `pos` in the room rather than from the
 * last array entry: a room a person has reordered has the two disagreeing, and
 * the sort is the one that decides what draws on top.
 */
export function appendElements(
  yElements: Y.Array<Y.Map<unknown>>,
  elements: readonly SceneElement[],
): void {
  if (elements.length === 0) return;

  const entries = readEntries(yElements);
  const largest = entries.at(-1)?.pos ?? null;
  const positions = generateNKeysBetween(largest, null, elements.length);

  yElements.push(
    elements.map((element, index) => {
      const map = new Y.Map<unknown>();
      map.set("pos", positions[index]);
      map.set("el", plain(element));
      return map;
    }),
  );
}

/**
 * Writes a changed element into the entry that already holds it.
 *
 * In place, and that is the whole point. Removing the entry and pushing a
 * replacement produces array events instead of map events, and the browser's
 * binding keeps the copy already in its scene for any element it did not see
 * change — the document would hold the new element while the screen showed the
 * old one, until somebody reloaded.
 */
export function replaceElement(yElements: Y.Array<Y.Map<unknown>>, element: SceneElement): void {
  for (const entry of yElements.toArray()) {
    const stored = entry.get("el") as SceneElement | undefined;
    if (stored?.id !== element.id) continue;
    entry.set("el", plain(element));
    return;
  }
  throw new Error(`element "${element.id}" is not in this room`);
}

/** Removes every entry naming one of `ids`. */
export function removeElements(yElements: Y.Array<Y.Map<unknown>>, ids: ReadonlySet<string>): void {
  // Back to front, so an earlier index is never invalidated by a later delete.
  for (let index = yElements.length - 1; index >= 0; index -= 1) {
    const stored = yElements.get(index).get("el") as SceneElement | undefined;
    if (stored !== undefined && ids.has(stored.id)) yElements.delete(index, 1);
  }
}

/**
 * The element as plain JSON.
 *
 * Excalidraw's constructors leave `customData: undefined` behind, and a
 * document is a poor place for a key whose value is the absence of one. The
 * round trip also guarantees the value is something Yjs can encode.
 */
function plain(element: SceneElement): SceneElement {
  return JSON.parse(JSON.stringify(element)) as SceneElement;
}
