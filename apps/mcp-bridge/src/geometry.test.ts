import { describe, expect, it } from "vitest";
import { describeScene } from "./describe.ts";
import {
  arrow,
  box,
  frame,
  idOf,
  label,
  linear,
  note,
  radians,
  rect,
  section,
} from "./scene-helpers.ts";

describe("the geometry appendix (R4)", () => {
  it("carries a box rounded to whole scene units", () => {
    const { text } = describeScene([rect("one", 100.4, 240.6, 200.5, 89.49)]);

    expect(section(text, "GEOMETRY")).toContain("one  100, 241, 201, 89");
  });

  it("carries an arrow's absolute endpoints and every point in between", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 100, 60),
      rect("two", 600, 400, 100, 60),
      arrow(
        "bent",
        100,
        30,
        [
          [0, 0],
          [200, 60],
          [400, 260],
          [500, 400],
        ],
        { from: "one", to: "two" },
      ),
    ]);

    expect(section(text, "GEOMETRY")).toContain(
      "bent  from (100,30) to (600,430)  via (300,90) (500,290)",
    );
    expect(section(text, "ARROWS")[0]).toContain("(2 waypoint(s))");
  });

  it("says nothing about waypoints on a straight arrow", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 100, 60),
      arrow("straight", 100, 30, [
        [0, 0],
        [200, 0],
      ]),
    ]);

    expect(section(text, "ARROWS")[0]).not.toContain("waypoint");
    expect(section(text, "GEOMETRY")).toContain("straight  from (100,30) to (300,30)");
  });

  it("describes a line as a node whose appendix line carries its ends, not a box", () => {
    const { text } = describeScene([
      linear("line", "rule", 40, 60, [
        [0, 0],
        [300, 120],
      ]),
    ]);

    expect(section(text, "NODES").map(idOf)).toEqual(["rule"]);
    expect(section(text, "ARROWS")).toHaveLength(0);
    expect(section(text, "GEOMETRY")).toEqual(["rule  from (40,60) to (340,180)"]);
  });

  it("gives a three-hundred-point freedraw stroke one node line and one box", () => {
    const points = Array.from({ length: 300 }, (_, n) => [n, Math.round(Math.sin(n) * 40) + 40]);
    const { text } = describeScene([box("freedraw", "stroke", 10, 20, 299, 80, { points })]);

    expect(section(text, "NODES")).toHaveLength(1);
    expect(section(text, "GEOMETRY")).toEqual(["stroke  10, 20, 299, 80"]);
    // A stroke described point by point would put the payload back above the
    // raw dump the format exists to beat: two header lines and three sections
    // is the whole of it.
    expect(text.split("\n")).toHaveLength(10);
    expect(text).not.toContain("(0,");
  });

  it("gives every named element an appendix line and names nothing else there", () => {
    const scene = [
      frame("frm", 0, 0, 400, 400, "Server side"),
      rect("one", 20, 20, 100, 60, { frameId: "frm" }),
      label("one-label", "one", "Hub"),
      note("loose", 600, 20, "note"),
      box("freedraw", "stroke", 600, 200, 90, 70),
      arrow("a", 120, 50, [
        [0, 0],
        [480, 0],
      ]),
    ];
    const { text } = describeScene(scene);

    const named = [
      ...section(text, "NODES").map(idOf),
      ...section(text, "ARROWS").map(idOf),
      ...section(text, "CONTAINERS")
        .filter((line) => line.startsWith("frame "))
        .map((line) => line.split(" ")[1] ?? ""),
    ];
    const appendix = section(text, "GEOMETRY").map(idOf);

    expect(new Set(appendix)).toEqual(new Set(named));
    expect(appendix).toHaveLength(named.length);
    expect(appendix).not.toContain("one-label");
  });

  it("declares a rotation in whole degrees rather than radians", () => {
    const { text } = describeScene([rect("turned", 0, 0, 200, 100, { angle: radians(120) })]);

    expect(section(text, "NODES")[0]).toContain("rot=120");
  });

  it("says nothing about rotation on an element nobody turned", () => {
    const { text } = describeScene([rect("flat", 0, 0, 200, 100)]);

    expect(section(text, "NODES")[0]).not.toContain("rot=");
  });

  it("turns a rotated line's points instead of marking it with rot=", () => {
    // `rot=` exists so a stored box is not read as an outline, and a linear
    // element's appendix line is never a box — its points already say where it
    // runs. Marking it too would state the turn twice, and an agent applying
    // the angle to points that already carry it would double it.
    const flat = describeScene([
      linear("line", "rule", 0, -50, [
        [0, 0],
        [100, 0],
      ]),
      rect("box", 0, 0, 100, 60, { angle: radians(90) }),
    ]);
    const turned = describeScene([
      linear(
        "line",
        "rule",
        0,
        -50,
        [
          [0, 0],
          [100, 0],
        ],
        { angle: radians(90) },
      ),
      rect("box", 0, 0, 100, 60, { angle: radians(90) }),
    ]);

    expect(section(flat.text, "GEOMETRY")).toContain("rule  from (0,-50) to (100,-50)");
    expect(section(turned.text, "GEOMETRY")).toContain("rule  from (50,-100) to (50,0)");
    expect(section(turned.text, "NODES").find((line) => idOf(line) === "rule")).not.toContain(
      "rot=",
    );
    // The rectangle beside it does declare its turn, so the absence above is
    // this rule rather than a renderer that forgot rotation altogether.
    expect(section(turned.text, "NODES").find((line) => idOf(line) === "box")).toContain("rot=90");
    expect(turned.summary.extent?.minY).toBe(-100);
  });

  it("keeps a rotated element inside the stated extent", () => {
    // A square turned 45° reaches further than its stored box in both axes.
    const { text, summary } = describeScene([
      rect("turned", 0, 0, 100, 100, { angle: radians(45) }),
    ]);
    const half = (100 * Math.SQRT2) / 2;

    expect(summary.extent).toEqual({
      minX: Math.round(50 - half),
      minY: Math.round(50 - half),
      maxX: Math.round(50 + half),
      maxY: Math.round(50 + half),
    });
    expect(text).toContain("extent -21,-21 .. 121,121");
  });

  it("includes a standalone text in the extent", () => {
    const { text, summary } = describeScene([
      note("loose", -400, 300, "remember to split this"),
      rect("one", 0, 0, 200, 100),
    ]);

    expect(summary.extent?.minX).toBe(-400);
    expect(text).toContain("extent -400,0 ..");
  });

  it("leaves a bound label out of the extent", () => {
    const wide = label("one-label", "one", "Auth", "Auth", {
      x: -900,
      y: -900,
      width: 100,
      height: 25,
    });
    const { summary } = describeScene([rect("one", 0, 0, 200, 100), wide]);

    expect(summary.extent).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
  });

  it("stretches the extent around an arrow whose points run behind its own origin", () => {
    const { summary } = describeScene([
      rect("one", 0, 0, 100, 60),
      arrow("back", 0, 0, [
        [0, 0],
        [-200, -150],
      ]),
    ]);

    expect(summary.extent).toEqual({ minX: -200, minY: -150, maxX: 100, maxY: 60 });
  });
});
