/**
 * The compatibility layer on its own: no hub, no sockets, no document. What
 * these scenarios grade is whether Excalidraw's own converter runs inside a
 * plain Node process and hands back elements a browser would accept.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { convertSkeletons } from "./convert.ts";
import { elementSkeletonSchema } from "./skeleton.ts";
import { measureLineWidth } from "./text-width.ts";

/** Every field a rectangle element declares, per Excalidraw's own types. */
const RECTANGLE_FIELDS = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "index",
  "roundness",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
] as const;

async function convert(skeletons: unknown[]): Promise<Record<string, unknown>[]> {
  const parsed = z.array(elementSkeletonSchema).parse(skeletons);
  const result = await convertSkeletons(parsed, []);
  return result.created as unknown as Record<string, unknown>[];
}

describe("the headless conversion", () => {
  it("returns a complete Excalidraw element, not the skeleton it was given (R1)", async () => {
    const [rectangle] = await convert([
      { type: "rectangle", id: "r1", x: 10, y: 20, width: 120, height: 80 },
    ]);

    expect(rectangle).toBeDefined();
    for (const field of RECTANGLE_FIELDS) {
      expect(rectangle, `rectangle is missing ${field}`).toHaveProperty(field);
    }
    expect(typeof rectangle?.seed).toBe("number");
    expect(typeof rectangle?.versionNonce).toBe("number");
    expect(typeof rectangle?.version).toBe("number");
    expect(typeof rectangle?.updated).toBe("number");
    expect(rectangle).toMatchObject({ id: "r1", type: "rectangle", x: 10, y: 20 });
  });

  it("measures a label with the bridge's own width function (R2)", async () => {
    const elements = await convert([
      { type: "rectangle", id: "r1", x: 0, y: 0, width: 200, height: 100, label: { text: "Auth" } },
    ]);

    const text = elements.find((element) => element.type === "text");
    expect(text).toBeDefined();
    const expected = measureLineWidth("Auth", "20px Excalifont");
    expect(expected).toBeGreaterThan(0);
    expect(text?.width).toBe(expected);
  });
});
