/**
 * The scenario that keeps the stub canvas throwing.
 *
 * It lives alone in its own file because it needs an Excalidraw whose text
 * metrics provider has never been registered, and registration is process-wide
 * module state — vitest gives each file its own module registry, and nothing
 * else here may import the conversion path.
 */
import { describe, expect, it } from "vitest";
import { installDomStubs } from "./dom-stubs.ts";

describe("the stub canvas", () => {
  it("fails loudly rather than measuring text itself (R2)", async () => {
    installDomStubs();
    // Imported directly, without the bridge's own runtime: this is what
    // Excalidraw does when no metrics provider has been registered, and it
    // measures through `document.createElement("canvas")` — i.e. through the
    // stub. A stub that answered would hand back geometry derived from
    // something that is not a font, silently.
    const excalidraw = await import("@excalidraw/excalidraw");

    expect(() =>
      excalidraw.convertToExcalidrawElements(
        [
          {
            type: "rectangle",
            id: "r1",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            label: { text: "Auth" },
          },
        ],
        { regenerateIds: false },
      ),
    ).toThrow(/measure/i);
  });
});
