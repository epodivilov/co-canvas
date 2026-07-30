import { describe, expect, it } from "vitest";
import { describeScene } from "./describe.ts";
import {
  arrow,
  box,
  el,
  frame,
  idOf,
  label,
  linear,
  note,
  rect,
  section,
} from "./scene-helpers.ts";

/** One of every element type a room can hold, plus a bound label. */
const EVERY_TYPE = [
  rect("r", 0, 0, 100, 60),
  label("r-label", "r", "Auth"),
  box("ellipse", "e", 200, 0, 100, 60),
  box("diamond", "d", 400, 0, 100, 60),
  note("t", 600, 0, "loose note"),
  linear("line", "l", 0, 200, [
    [0, 0],
    [120, 40],
  ]),
  box("freedraw", "fd", 200, 200, 90, 70, {
    points: [
      [0, 0],
      [45, 20],
      [90, 70],
    ],
  }),
  box("image", "im", 400, 200, 120, 90, { fileId: "file-1", status: "saved" }),
  box("embeddable", "emb", 600, 200, 200, 120, { link: "https://example.com" }),
  arrow("a", 100, 30, [
    [0, 0],
    [100, 0],
  ]),
  frame("frm", 0, 400, 300, 200, "Server side"),
];

/** Ids on the node, arrow and frame lines — every line that names an element. */
function describedIds(text: string): string[] {
  return [
    ...section(text, "NODES").map(idOf),
    ...section(text, "ARROWS").map(idOf),
    // A frame line reads `frame <id> …`, so its id is the second token.
    ...section(text, "CONTAINERS")
      .filter((line) => line.startsWith("frame "))
      .map((line) => line.split(" ")[1] ?? ""),
  ];
}

describe("what the description covers (R3)", () => {
  it("accounts for every element exactly once, with the bound text folded into its container", () => {
    const { text, summary } = describeScene(EVERY_TYPE);
    const ids = describedIds(text);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("r-label");
    expect(new Set(ids)).toEqual(new Set(["r", "e", "d", "t", "l", "fd", "im", "emb", "a", "frm"]));
    // Every element accounted for: the described ones plus the one bound text.
    expect(ids.length + 1).toBe(EVERY_TYPE.length);
    expect(summary.elements).toBe(EVERY_TYPE.length);
  });

  it("names each node's own type, the ones no agent tool produces included", () => {
    const { text } = describeScene(EVERY_TYPE);
    const types = new Map(
      section(text, "NODES").map((line) => [idOf(line), line.split(/\s{2,}/)[2] ?? ""]),
    );

    expect(types.get("r")).toBe("rectangle");
    expect(types.get("e")).toBe("ellipse");
    expect(types.get("d")).toBe("diamond");
    expect(types.get("t")).toBe("text");
    expect(types.get("l")).toBe("line");
    expect(types.get("fd")).toBe("freedraw");
    expect(types.get("im")).toBe("image");
    expect(types.get("emb")).toBe("embeddable");
  });

  it("describes an iframe and a magicframe rather than dropping them", () => {
    const { text } = describeScene([
      rect("r", 0, 0, 100, 60),
      box("iframe", "ifr", 200, 0, 200, 120),
      el({ id: "mf", type: "magicframe", x: 0, y: 200, width: 300, height: 200, name: "Magic" }),
    ]);

    expect(describedIds(text)).toContain("ifr");
    expect(describedIds(text)).toContain("mf");
    expect(section(text, "GEOMETRY").map(idOf)).toContain("ifr");
    expect(section(text, "GEOMETRY").map(idOf)).toContain("mf");
  });

  it("gives a person's freehand stroke over a diagram a node line and a box", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 200, 100),
      label("one-label", "one", "Auth"),
      rect("two", 400, 0, 200, 100),
      label("two-label", "two", "Store"),
      box("freedraw", "scribble", 120, 40, 320, 90, {
        points: [
          [0, 0],
          [160, 50],
          [320, 90],
        ],
      }),
    ]);

    const stroke = section(text, "NODES").find((line) => idOf(line) === "scribble");
    expect(stroke).toBeDefined();
    expect(stroke).toContain("freedraw");
    expect(section(text, "GEOMETRY")).toContain("scribble  120, 40, 320, 90");
  });

  it("states a frame's contents from both sides", () => {
    const { text } = describeScene([
      frame("frm", 0, 0, 400, 400, "Server side"),
      rect("in-one", 20, 20, 100, 60, { frameId: "frm" }),
      label("in-one-label", "in-one", "Hub"),
      rect("in-two", 20, 200, 100, 60, { frameId: "frm" }),
      label("in-two-label", "in-two", "Log"),
      rect("out-one", 600, 20, 100, 60),
      rect("out-two", 600, 200, 100, 60),
    ]);
    const nodes = new Map(section(text, "NODES").map((line) => [idOf(line), line]));

    expect(nodes.get("in-one")).toContain('frame="Server side"');
    expect(nodes.get("in-two")).toContain('frame="Server side"');
    expect(nodes.get("out-one")).not.toContain("frame=");
    expect(nodes.get("out-two")).not.toContain("frame=");

    const frameLine = section(text, "CONTAINERS").find((line) => line.startsWith("frame "));
    expect(frameLine).toContain("contains Hub, Log");
  });

  it("states a group's members from both sides", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 100, 60, { groupIds: ["pair"] }),
      label("one-label", "one", "Alpha"),
      rect("two", 200, 0, 100, 60, { groupIds: ["pair"] }),
      label("two-label", "two", "Beta"),
      rect("three", 400, 0, 100, 60),
    ]);
    const nodes = new Map(section(text, "NODES").map((line) => [idOf(line), line]));

    expect(nodes.get("one")).toContain("group=pair");
    expect(nodes.get("two")).toContain("group=pair");
    expect(nodes.get("three")).not.toContain("group=");
    expect(section(text, "CONTAINERS")).toContain("group pair: Alpha, Beta");
  });

  it("names both groups of a node that belongs to two nested ones", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 100, 60, { groupIds: ["inner", "outer"] }),
      rect("two", 200, 0, 100, 60, { groupIds: ["outer"] }),
    ]);
    const nodeLine = section(text, "NODES").find((line) => idOf(line) === "one");

    expect(nodeLine).toContain("group=inner,outer");
    expect(section(text, "CONTAINERS")).toHaveLength(2);
  });

  it("leaves a tombstoned element out of the description entirely", () => {
    const { text, summary } = describeScene([
      rect("kept", 0, 0, 100, 60),
      rect("gone", 200, 0, 100, 60, { isDeleted: true }),
    ]);

    expect(describedIds(text)).toEqual(["kept"]);
    expect(summary.elements).toBe(1);
  });
});
