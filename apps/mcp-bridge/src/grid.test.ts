import { describe, expect, it } from "vitest";
import { describeScene } from "./describe.ts";
import { arrow, box, frame, idOf, label, note, rect, section } from "./scene-helpers.ts";

/** The cell a node or frame line names, e.g. `A1`, or a frame's `B1..C4`. */
function cellOf(line: string): string {
  return /cells? ([A-Z]+\d+(?:\.\.[A-Z]+\d+)?)/.exec(line)?.[1] ?? "";
}

/** The column and row ranges the grid line declares. */
function gridRanges(text: string): { columns: string; rows: number } {
  const line = text.split("\n")[1] ?? "";
  return {
    columns: /columns A\.\.([A-Z]+) /.exec(line)?.[1] ?? "",
    rows: Number(/rows 1\.\.(\d+) /.exec(line)?.[1] ?? "0"),
  };
}

/** Turns `AB` into its zero-based column index. */
function columnIndex(name: string): number {
  let index = 0;
  for (const character of name) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

describe("the coarse grid (R6)", () => {
  it("keeps column names alphabetic past the twenty-sixth column", () => {
    // Forty columns: cells floor at 120px wide, so forty 100px nodes spaced
    // 130px apart span forty of them.
    const wide = Array.from({ length: 40 }, (_, n) => rect(`n${n}`, n * 130, 0, 100, 60));
    const { text } = describeScene(wide);
    const { columns } = gridRanges(text);

    expect(columns).toBe("AN");
    for (const line of section(text, "NODES")) {
      expect(cellOf(line), line).toMatch(/^[A-Z]+\d+$/);
    }
    // The spike emits `}1`, `i1`, `j1` and `l1` here.
    expect(section(text, "NODES").map(cellOf)).toContain("AA1");
    expect(section(text, "NODES").map(cellOf)).toContain("AB1");
    expect(section(text, "NODES").map(cellOf)).toContain("AN1");
  });

  it("keeps every cell it names inside the ranges it declares", () => {
    const scenes = [
      [rect("one", 0, 0, 100, 60)],
      [
        frame("frm", -300, -200, 900, 700, "Wide"),
        rect("one", 0, 0, 100, 60, { frameId: "frm" }),
        note("loose", 800, 900, "far away"),
        arrow("a", 0, 0, [
          [0, 0],
          [-400, -300],
        ]),
      ],
      Array.from({ length: 30 }, (_, n) => rect(`n${n}`, n * 71, n * 43, 40, 30)),
    ];

    for (const scene of scenes) {
      const { text } = describeScene(scene);
      const { columns, rows } = gridRanges(text);
      const named = [...section(text, "NODES"), ...section(text, "CONTAINERS")].flatMap((line) => {
        const cell = cellOf(line);
        return cell === "" ? [] : cell.split("..");
      });

      expect(named.length).toBeGreaterThan(0);
      for (const cell of named) {
        const parsed = /^([A-Z]+)(\d+)$/.exec(cell);
        expect(parsed, `${cell} is not a cell name`).not.toBeNull();
        expect(columnIndex(parsed?.[1] ?? "")).toBeLessThanOrEqual(columnIndex(columns));
        expect(Number(parsed?.[2])).toBeGreaterThanOrEqual(1);
        expect(Number(parsed?.[2])).toBeLessThanOrEqual(rows);
      }
    }
  });

  it("assigns cells at the cell size the grid line states", () => {
    // Two nodes exactly one declared cell width apart land one column apart.
    const first = describeScene([rect("a", 0, 0, 200, 100), rect("b", 1000, 0, 200, 100)]);
    const cellWidth = Number(/coarse cells ~(\d+)x/.exec(first.text.split("\n")[1] ?? "")?.[1]);

    expect(cellWidth).toBeGreaterThan(0);
    const { text } = describeScene([rect("a", 0, 0, 200, 100), rect("b", cellWidth, 0, 200, 100)]);
    const cells = new Map(section(text, "NODES").map((line) => [idOf(line), cellOf(line)]));

    expect(cells.get("a")).toBe("A1");
    expect(cells.get("b")).toBe("B1");
  });

  it("assigns a node the cell its centre falls in, not the cells its box touches", () => {
    // Every node is 200x100, so the cell size — and with it the boundary the
    // pair straddles — is the same in the probe and in the scene proper.
    const probe = describeScene([rect("a", 0, 0, 200, 100), rect("b", 400, 0, 200, 100)]);
    const cellWidth = Number(/coarse cells ~(\d+)x/.exec(probe.text.split("\n")[1] ?? "")?.[1]);
    const { text } = describeScene([
      // Two corners, so the extent is wide enough to hold several columns.
      rect("origin", 0, 0, 200, 100),
      rect("corner", 1000, 400, 200, 100),
      // Both boxes cross the boundary at `cellWidth`; their centres do not.
      rect("left", cellWidth - 120, 300, 200, 100),
      rect("right", cellWidth - 80, 300, 200, 100),
    ]);
    const cells = new Map(section(text, "NODES").map((line) => [idOf(line), cellOf(line)]));

    expect(cells.get("left")).toBe("A3");
    expect(cells.get("right")).toBe("B3");
  });

  it("names the full range of cells a frame spans", () => {
    const { text } = describeScene([
      frame("frm", 0, 0, 900, 700, "Server side"),
      rect("one", 40, 40, 200, 100, { frameId: "frm" }),
      label("one-label", "one", "Hub"),
      rect("two", 40, 500, 200, 100, { frameId: "frm" }),
      label("two-label", "two", "Log"),
    ]);
    const range = cellOf(section(text, "CONTAINERS")[0] ?? "");
    const [from, to] = range.split("..");

    expect(from).toBeDefined();
    expect(to).toBeDefined();
    expect(from).not.toBe(to);
    expect(columnIndex((/^([A-Z]+)/.exec(to ?? "") ?? [])[1] ?? "")).toBeGreaterThan(0);
  });

  it("sizes its cells from the nodes the scene holds", () => {
    const small = describeScene([
      rect("a", 0, 0, 40, 20),
      rect("b", 200, 0, 40, 20),
      box("ellipse", "c", 0, 200, 40, 20),
    ]);
    const large = describeScene([
      rect("a", 0, 0, 600, 400),
      rect("b", 2000, 0, 600, 400),
      box("ellipse", "c", 0, 2000, 600, 400),
    ]);
    const cellSize = (text: string) =>
      (/coarse cells ~(\d+)x(\d+)px/.exec(text.split("\n")[1] ?? "") ?? []).slice(1).map(Number);

    // The floor holds for tiny elements; a scene of big ones gets big cells.
    expect(cellSize(small.text)).toEqual([120, 80]);
    expect(cellSize(large.text)[0]).toBe(Math.round(600 * 1.3));
    expect(cellSize(large.text)[1]).toBe(Math.round(400 * 1.6));
  });
});
