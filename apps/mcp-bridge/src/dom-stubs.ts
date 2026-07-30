/**
 * The browser globals `@excalidraw/excalidraw` touches while its modules
 * evaluate, and nothing more.
 *
 * The package is a React component library. Importing it runs React's DOM
 * feature probes and Excalidraw's own font registration at module scope, so
 * these have to exist *before* the import — which is why the import is dynamic
 * and lives behind {@link loadExcalidraw}.
 *
 * Every stub here is the minimum that lets `convertToExcalidrawElements` run:
 * nothing renders, nothing is painted, and no canvas is ever real. Excalidraw
 * versions are pinned exactly because this list is tied to module-scope
 * behaviour upstream is free to change in a patch release.
 */

/** Message the stub canvas fails with. Named so a scenario can match on it. */
export const STUB_MEASURE_TEXT_ERROR =
  "co-canvas: the headless canvas stub cannot measure text." +
  " Excalidraw's text metrics provider was never registered, so it fell back to a canvas" +
  " that is not one — see loadExcalidraw().";

/**
 * A `CanvasRenderingContext2D` that can be probed but never used.
 *
 * `measureText` throws on purpose, and that is a design decision rather than an
 * oversight. With no metrics provider registered, Excalidraw measures text
 * through whatever `createElement("canvas").getContext("2d")` returns: a stub
 * answering `{ width: 0 }` yields invisible zero-width labels, and one
 * answering `{}` yields `NaN` widths and containers that grow without bound.
 * Both are silent. Throwing turns the same mistake into a stack trace on the
 * first conversion.
 */
function stubContext(): Record<string, unknown> {
  return {
    // Read with `in` during a feature probe, so it has to be present and the
    // context itself has to be an object rather than null.
    filter: "none",
    measureText(): never {
      throw new Error(STUB_MEASURE_TEXT_ERROR);
    },
  };
}

function stubElement(): Record<string, unknown> {
  return {
    // React's DOM probes read `style` and call `setAttribute` at module scope;
    // neither is optional.
    style: {},
    classList: {},
    setAttribute(): void {},
    appendChild(): void {},
    getContext: stubContext,
  };
}

/**
 * Installs the stubs, once.
 *
 * Idempotent and additive: a global that already exists — because a scenario
 * runs under jsdom, say — is left alone.
 */
export function installDomStubs(): void {
  const globals = globalThis as unknown as Record<string, unknown>;

  const define = (name: string, value: unknown): void => {
    if (globals[name] === undefined) globals[name] = value;
  };

  define("window", globalThis);
  define("location", { origin: "http://localhost" });
  define("devicePixelRatio", 1);
  define("Element", class StubElement {});
  define("FontFace", class StubFontFace {});
  define("document", { createElement: stubElement });
}
