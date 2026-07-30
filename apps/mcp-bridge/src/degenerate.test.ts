import { describe, expect, it } from "vitest";
import { describeScene } from "./describe.ts";
import {
  arrow,
  box,
  el,
  frame,
  label,
  linear,
  note,
  radians,
  rect,
  section,
} from "./scene-helpers.ts";

describe("degenerate scenes (R7)", () => {
  it("says an empty board is empty, with no coordinates and no grid", () => {
    const { text, summary } = describeScene([]);

    expect(text.split("\n")).toHaveLength(1);
    expect(text.toLowerCase()).toContain("empty");
    expect(text).not.toContain("GRID");
    expect(text).not.toMatch(/\d/);
    expect(summary).toEqual({ elements: 0, nodes: 0, arrows: 0, extent: null });
  });

  it("puts a lone element in the first cell, with the extent around its box", () => {
    const { text, summary } = describeScene([rect("only", 340, 180, 200, 100)]);

    expect(summary.extent).toEqual({ minX: 340, minY: 180, maxX: 540, maxY: 280 });
    expect(text).toContain("extent 340,180 .. 540,280");
    expect(section(text, "NODES")[0]).toContain("cell A1");
    expect(section(text, "GEOMETRY")).toEqual(["only  340, 180, 200, 100"]);
  });

  it("survives an element of no width and no height", () => {
    const { text, summary } = describeScene([
      rect("flat", 100, 100, 0, 0),
      rect("other", 300, 100, 120, 80),
    ]);

    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(section(text, "GEOMETRY")).toContain("flat  100, 100, 0, 0");
    expect(summary.extent).toEqual({ minX: 100, minY: 100, maxX: 420, maxY: 180 });
  });

  it("survives a scene made only of an element of no width and no height", () => {
    const { text, summary } = describeScene([rect("flat", 0, 0, 0, 0)]);

    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(summary.extent).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(section(text, "NODES")[0]).toContain("cell A1");
  });

  it("survives a frame with no name and nothing in it", () => {
    const { text } = describeScene([frame("frm", 0, 0, 300, 200, null)]);

    expect(text).not.toContain("NaN");
    expect(text).not.toContain("null");
    expect(section(text, "NODES")).toHaveLength(0);
    expect(section(text, "CONTAINERS")[0]).toContain("(no name)");
  });

  it("survives an element whose stored geometry is missing or not a number", () => {
    const { text, summary } = describeScene([
      el({ id: "broken", type: "rectangle" }),
      el({ id: "worse", type: "ellipse", x: "nonsense", y: null, width: undefined, height: {} }),
    ]);

    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(summary.extent).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it("survives a linear element with no points at all", () => {
    const { text } = describeScene([
      el({ id: "stub", type: "arrow", x: 40, y: 60, points: [] }),
      rect("one", 200, 0, 100, 60),
    ]);

    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(section(text, "GEOMETRY")).toContain("stub  from (40,60) to (40,60)");
  });

  it("holds no NaN and no Infinity on any scene in this plan", () => {
    const scenes: Parameters<typeof describeScene>[0][] = [
      [],
      [rect("one", 0, 0, 100, 60)],
      [rect("flat", 0, 0, 0, 0)],
      [rect("turned", 0, 0, 100, 100, { angle: radians(45) })],
      [note("loose", -400, 300, 'a "quoted"\nnote')],
      [
        frame("frm", 0, 0, 400, 400, null),
        rect("one", 20, 20, 100, 60, { frameId: "frm", groupIds: ["g"] }),
        label("one-label", "one", "Hub"),
        arrow("a", 120, 50, [
          [0, 0],
          [0, 0],
        ]),
        linear("line", "rule", 0, 0, [[0, 0]]),
        box("freedraw", "stroke", 0, 0, 0, 0, { points: [] }),
        box("image", "im", -100, -100, 0, 0),
      ],
      Array.from({ length: 40 }, (_, n) => rect(`n${n}`, n * 130, 0, 100, 60)),
    ];

    for (const scene of scenes) {
      const { text } = describeScene(scene);
      expect(text, JSON.stringify(scene).slice(0, 120)).not.toContain("NaN");
      expect(text, JSON.stringify(scene).slice(0, 120)).not.toContain("Infinity");
      expect(text).not.toContain("undefined");
    }
  });
});
