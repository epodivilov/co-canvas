import { describe, expect, it } from "vitest";
import { describeScene } from "./describe.ts";
import { arrow, frame, label, rect, section, sections } from "./scene-helpers.ts";

describe("the description's shape (R2)", () => {
  const scene = [
    frame("frm", 60, 40, 400, 300, "Server side"),
    rect("one", 100, 100, 200, 90, { frameId: "frm" }),
    label("one-label", "one", "Auth"),
    rect("two", 100, 240, 200, 90, { frameId: "frm" }),
    label("two-label", "two", "Store"),
    rect("three", 600, 100, 200, 90, { groupIds: ["grp"] }),
    label("three-label", "three", "Browser"),
    rect("four", 600, 240, 200, 90, { groupIds: ["grp"] }),
    label("four-label", "four", "Overview"),
    arrow(
      "a1",
      300,
      145,
      [
        [0, 0],
        [300, 0],
      ],
      { from: "one", to: "three" },
    ),
    arrow(
      "a2",
      300,
      285,
      [
        [0, 0],
        [300, 0],
      ],
      { from: "two", to: "four" },
    ),
  ];

  it("opens with the scene line, then the grid line, then its sections in order", () => {
    const { text } = describeScene(scene);
    const lines = text.split("\n");

    expect(lines[0]).toMatch(/^SCENE: /);
    expect(lines[1]).toMatch(/^GRID: /);
    expect([...sections(text).keys()]).toEqual(["NODES", "CONTAINERS", "ARROWS", "GEOMETRY"]);
  });

  it("declares the cell size and the full column and row ranges on the grid line", () => {
    const { text } = describeScene(scene);
    const grid = text.split("\n")[1] ?? "";

    expect(grid).toMatch(/^GRID: coarse cells ~\d+x\d+px, columns A\.\.[A-Z]+ /);
    expect(grid).toMatch(/rows 1\.\.\d+ /);
  });

  it("counts on the scene line the node lines and arrow lines that follow", () => {
    const { text } = describeScene(scene);
    const counts = /^SCENE: (\d+) nodes, (\d+) arrows, extent /.exec(text);

    expect(counts).not.toBeNull();
    expect(Number(counts?.[1])).toBe(section(text, "NODES").length);
    expect(Number(counts?.[2])).toBe(section(text, "ARROWS").length);
    expect(section(text, "NODES")).toHaveLength(4);
    expect(section(text, "ARROWS")).toHaveLength(2);
  });

  it("leaves out CONTAINERS when the room holds neither a frame nor a group", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 100, 60),
      rect("two", 200, 0, 100, 60),
      arrow(
        "a1",
        100,
        30,
        [
          [0, 0],
          [100, 0],
        ],
        { from: "one", to: "two" },
      ),
    ]);

    expect(sections(text).has("CONTAINERS")).toBe(false);
    expect(text).not.toContain("CONTAINERS");
    expect([...sections(text).keys()]).toEqual(["NODES", "ARROWS", "GEOMETRY"]);
  });

  it("orders node lines top-to-bottom, then left-to-right within a row", () => {
    const { text } = describeScene([
      rect("bottom-right", 400, 400, 100, 60),
      rect("top-right", 400, 0, 100, 60),
      rect("bottom-left", 0, 400, 100, 60),
      rect("top-left", 0, 0, 100, 60),
    ]);

    expect(section(text, "NODES").map((line) => line.split(" ")[0])).toEqual([
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]);
  });

  it("keeps a node line on one line however its label wraps and whatever it quotes", () => {
    const wrapped = 'a very long "quoted"\nlabel that\nwrapped';
    const { text } = describeScene([
      rect("one", 0, 0, 200, 90),
      label("one-label", "one", 'a very long\n"quoted"\nlabel', wrapped),
      rect("two", 0, 200, 200, 90),
    ]);

    expect(section(text, "NODES")).toHaveLength(2);
    expect(section(text, "NODES")[0]).toContain("one");
    // The sections that follow still parse as their own, which is what a leaked
    // newline would break.
    expect([...sections(text).keys()]).toEqual(["NODES", "ARROWS", "GEOMETRY"]);
    expect(section(text, "GEOMETRY")).toHaveLength(2);
  });
});
