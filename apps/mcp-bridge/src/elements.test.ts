/**
 * The document layer on its own, against a plain `Y.Doc`.
 *
 * What it covers is the one thing no room scenario reaches: a room whose array
 * order and z-order disagree, which is what a person reordering elements in the
 * browser produces.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { SceneElement } from "./elements.ts";
import { appendElements, elementsOf, readEntries } from "./elements.ts";

function rectangle(id: string): SceneElement {
  return { id, type: "rectangle", x: 0, y: 0, width: 10, height: 10 };
}

describe("appending to a room", () => {
  it("keys off the largest position, not the last array entry", () => {
    const doc = new Y.Doc();
    const yElements = elementsOf(doc);
    appendElements(yElements, [rectangle("one"), rectangle("two")]);

    // A reorder in the browser rewrites `pos` and leaves the array alone, so
    // the entry holding the largest key stops being the last one.
    const entries = yElements.toArray();
    entries[0]?.set("pos", "a3");
    entries[1]?.set("pos", "a2");

    appendElements(yElements, [rectangle("three")]);

    const stored = readEntries(yElements);
    expect(stored.map((entry) => entry.el.id)).toEqual(["two", "one", "three"]);
    // Keying off the array tail would have generated a key after "a2" — which
    // is where "one" already sits, so the new element would not have been on top.
    const appended = stored.at(-1)?.pos ?? "";
    expect(appended > "a3", `appended at ${appended}, which is not above a3`).toBe(true);
  });

  it("gives every appended element a distinct position, in the order given", () => {
    const doc = new Y.Doc();
    const yElements = elementsOf(doc);

    appendElements(yElements, [rectangle("a"), rectangle("b"), rectangle("c")]);

    const stored = readEntries(yElements);
    expect(stored.map((entry) => entry.el.id)).toEqual(["a", "b", "c"]);
    expect(new Set(stored.map((entry) => entry.pos)).size).toBe(3);
  });
});
