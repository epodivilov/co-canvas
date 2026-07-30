/**
 * Golden fixtures: three whole boards, rendered against a checked-in snapshot.
 *
 * These are not the three scenes gate CC-9 measured. Those live untracked in a
 * locked worktree, outside git, and the format — not those bytes — is what the
 * gate settled. They are built here to the same shape the gate's were: a clean
 * agent-drawn diagram, the same board after a person moved things with a mouse,
 * and one held together by groups. Each is a room document with every field
 * Excalidraw stores, so a snapshot diff is the format drifting rather than a
 * builder changing its mind.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeScene } from "./describe.ts";
import type { SceneElement } from "./elements.ts";
import { idOf, section } from "./scene-helpers.ts";

function fixture(name: string): SceneElement[] {
  const path = new URL(`./__fixtures__/scenes/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as SceneElement[];
}

const NAMES = ["clean", "human-edited", "grouped"] as const;

/** Turns `AB` into its zero-based column index. */
function columnIndex(name: string): number {
  let index = 0;
  for (const character of name) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

describe("golden fixtures (R2, R4, R5, R6)", () => {
  for (const name of NAMES) {
    it(`renders ${name} exactly as the snapshot records it`, async () => {
      const { text } = describeScene(fixture(name));

      await expect(text).toMatchFileSnapshot(`./__snapshots__/${name}.txt`);
    });
  }

  it("keeps every fixture free of NaN and of non-finite numbers (R7)", () => {
    for (const name of NAMES) {
      const { text } = describeScene(fixture(name));

      expect(text, name).not.toContain("NaN");
      expect(text, name).not.toContain("Infinity");
      expect(text, name).not.toContain("undefined");
    }
  });

  it("accounts for every element of every fixture exactly once (R3)", () => {
    for (const name of NAMES) {
      const elements = fixture(name);
      const { text, summary } = describeScene(elements);
      const named = [
        ...section(text, "NODES").map(idOf),
        ...section(text, "ARROWS").map(idOf),
        ...section(text, "CONTAINERS")
          .filter((line) => line.startsWith("frame "))
          .map((line) => line.split(" ")[1] ?? ""),
      ];
      const bound = elements.filter(
        (element) => element.type === "text" && typeof element.containerId === "string",
      );

      expect(new Set(named).size, name).toBe(named.length);
      expect(named.length + bound.length, name).toBe(elements.length);
      expect(summary.elements, name).toBe(elements.length);
    }
  });

  it("shows the human's edits: a bent arrow and a node dragged out of the block (R3)", () => {
    const { text } = describeScene(fixture("human-edited"));

    const bent = section(text, "ARROWS").find((line) => idOf(line) === "flushes");
    expect(bent).toContain("(1 waypoint(s))");
    expect(section(text, "GEOMETRY").find((line) => idOf(line) === "flushes")).toContain(" via (");

    // The dragged node sits outside the block the rest occupy: its own cell,
    // and a column past every one of them.
    const cells = new Map(
      section(text, "NODES").map((line) => [idOf(line), /cell ([A-Z]+)(\d+)/.exec(line)]),
    );
    const outlier = cells.get("overview");
    expect(outlier).not.toBeNull();
    for (const [id, cell] of cells) {
      if (id === "overview") continue;
      expect(cell?.[0], `${id} shares the outlier's cell`).not.toBe(outlier?.[0]);
      expect(columnIndex(cell?.[1] ?? ""), `${id} is not left of the outlier`).toBeLessThan(
        columnIndex(outlier?.[1] ?? ""),
      );
    }
  });

  it("carries the fractional coordinates of a hand-moved board as whole units (R4)", () => {
    const { text } = describeScene(fixture("human-edited"));

    expect(section(text, "GEOMETRY")).toContain("browser  82, 104, 200, 90");
    for (const line of section(text, "GEOMETRY")) {
      expect(line, line).not.toMatch(/\d\.\d/);
    }
  });

  it("reads a wrapped label as the string the person typed (R5)", () => {
    const { text } = describeScene(fixture("human-edited"));
    const hub = section(text, "NODES").find((line) => idOf(line) === "hub");

    expect(hub).toContain('"Hub (y-websocket)"');
  });
});
