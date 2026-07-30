import { describe, expect, it } from "vitest";
import { describeScene } from "./describe.ts";
import { arrow, el, frame, idOf, label, note, rect, section } from "./scene-helpers.ts";

describe("labels (R5)", () => {
  it("folds a bound text into its container and lists it nowhere else", () => {
    const { text } = describeScene([rect("one", 0, 0, 200, 90), label("one-label", "one", "Auth")]);

    expect(section(text, "NODES")).toHaveLength(1);
    expect(section(text, "NODES")[0]).toContain('"Auth"');
    expect(section(text, "NODES").map(idOf)).not.toContain("one-label");
    expect(section(text, "GEOMETRY").map(idOf)).not.toContain("one-label");
  });

  it("reads a wrapped label as the string the person typed", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 120, 90),
      label("one-label", "one", "Payment\nGateway\nService", "Payment Gateway Service"),
    ]);

    expect(section(text, "NODES")[0]).toContain('"Payment Gateway Service"');
    expect(section(text, "NODES")[0]).not.toContain("Payment\nGateway");
  });

  it("labels a standalone text with its own content", () => {
    const { text } = describeScene([note("loose", 100, 100, "remember to split this")]);

    expect(section(text, "NODES")[0]).toContain('"remember to split this"');
  });

  it("marks an element with no label rather than inventing or emptying one", () => {
    const { text } = describeScene([rect("bare", 0, 0, 100, 60)]);

    expect(section(text, "NODES")[0]).toContain("(no label)");
    expect(section(text, "NODES")[0]).not.toContain('""');
  });

  it("marks a frame nobody named rather than writing the word null", () => {
    const { text } = describeScene([
      frame("frm", 0, 0, 300, 200, null),
      rect("one", 20, 20, 100, 60, { frameId: "frm" }),
    ]);
    const frameLine = section(text, "CONTAINERS")[0] ?? "";
    const nodeLine = section(text, "NODES")[0] ?? "";

    expect(frameLine).toContain("(no name)");
    expect(frameLine).not.toContain("null");
    expect(nodeLine).toContain("frame=(no name)");
    expect(nodeLine).not.toContain("null");
  });

  it("describes a text whose container is gone as a node of its own", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 200, 90),
      el({
        id: "orphan",
        type: "text",
        x: 400,
        y: 0,
        width: 120,
        height: 25,
        text: "stranded",
        originalText: "stranded",
        containerId: "a-rectangle-that-was-deleted",
      }),
    ]);

    expect(section(text, "NODES").map(idOf)).toEqual(["one", "orphan"]);
    expect(section(text, "NODES")[1]).toContain('"stranded"');
    expect(section(text, "GEOMETRY").map(idOf)).toContain("orphan");
  });

  it("reads a label bound to an arrow as that arrow's label", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 100, 60),
      rect("two", 400, 0, 100, 60),
      arrow(
        "a",
        100,
        30,
        [
          [0, 0],
          [300, 0],
        ],
        { from: "one", to: "two" },
      ),
      label("a-label", "a", "on flush"),
    ]);

    expect(section(text, "ARROWS")[0]).toContain('"on flush"');
    expect(section(text, "NODES").map(idOf)).toEqual(["one", "two"]);
  });
});

describe("arrow ends (R5)", () => {
  const two = [
    rect("one", 0, 0, 100, 60),
    label("one-label", "one", "Auth"),
    rect("two", 400, 0, 100, 60),
    label("two-label", "two", "Store"),
  ];

  it("names both labels of an arrow bound at both ends", () => {
    const { text } = describeScene([
      ...two,
      arrow(
        "a",
        100,
        30,
        [
          [0, 0],
          [300, 0],
        ],
        { from: "one", to: "two" },
      ),
    ]);

    expect(section(text, "ARROWS")[0]).toContain('"Auth" -> "Store"');
  });

  it("marks the loose end of an arrow bound at one end only", () => {
    const { text } = describeScene([
      ...two,
      arrow(
        "a",
        100,
        30,
        [
          [0, 0],
          [300, 0],
        ],
        { to: "two" },
      ),
    ]);

    expect(section(text, "ARROWS")[0]).toContain('(unbound) -> "Store"');
    expect(section(text, "GEOMETRY")).toContain("a  from (100,30) to (400,30)");
  });

  it("marks both ends of an arrow bound to nothing at all", () => {
    const { text } = describeScene([
      arrow("a", 100, 30, [
        [0, 0],
        [300, 0],
      ]),
    ]);

    expect(section(text, "ARROWS")[0]).toContain("(unbound) -> (unbound)");
  });

  it("names the id of an end bound to a shape that carries no label", () => {
    const { text } = describeScene([
      rect("anonymous-one", 0, 0, 100, 60),
      rect("anonymous-two", 400, 0, 100, 60),
      arrow(
        "a",
        100,
        30,
        [
          [0, 0],
          [300, 0],
        ],
        { from: "anonymous-one", to: "anonymous-two" },
      ),
    ]);

    // Two unlabelled shapes must not read as the same anonymous end.
    expect(section(text, "ARROWS")[0]).toContain("anonymous-one -> anonymous-two");
  });

  it("marks an end bound to an element that is no longer in the room", () => {
    const { text } = describeScene([
      rect("one", 0, 0, 100, 60),
      label("one-label", "one", "Auth"),
      arrow(
        "a",
        100,
        30,
        [
          [0, 0],
          [300, 0],
        ],
        { from: "one", to: "deleted-long-ago" },
      ),
    ]);

    expect(section(text, "ARROWS")[0]).toContain('"Auth" -> (unbound)');
  });

  it("names a frame's members by label, falling back to the id of an unlabelled one", () => {
    const { text } = describeScene([
      frame("frm", 0, 0, 400, 400, "Server side"),
      rect("named", 20, 20, 100, 60, { frameId: "frm" }),
      label("named-label", "named", "Hub"),
      rect("nameless", 20, 200, 100, 60, { frameId: "frm" }),
    ]);

    expect(section(text, "CONTAINERS")[0]).toContain("contains Hub, nameless");
  });

  it("says a frame holding nothing is empty", () => {
    const { text } = describeScene([
      frame("frm", 0, 0, 400, 400, "Server side"),
      rect("outside", 600, 0, 100, 60),
    ]);

    expect(section(text, "CONTAINERS")[0]).toContain("contains (empty)");
  });
});
