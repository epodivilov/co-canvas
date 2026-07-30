/**
 * Excalidraw's own element converter, running in a plain Node process.
 *
 * Three things have to happen in this order and no other: the DOM stubs go in,
 * then the package is imported, then the text metrics provider is registered.
 * The stubs come first because the failures they cover are at module scope, and
 * the provider comes last because `setCustomTextMetricsProvider` is itself an
 * export of the module being imported.
 *
 * The import is dynamic so that ordering is enforced by construction rather
 * than by a comment, and it is loaded on first use so that a bridge running
 * unbundled still serves every tool that does not draw.
 */
import { installDomStubs } from "./dom-stubs.ts";
import type { SceneElement } from "./elements.ts";
import { measureLineWidth } from "./text-width.ts";

/** What the bridge asks Excalidraw to do. */
export interface ExcalidrawRuntime {
  /**
   * Turns upstream skeletons into complete elements, keeping the ids given.
   *
   * Upstream regenerates ids unless told not to; here the agent's own ids are
   * the point, so it is told not to.
   */
  convert(skeletons: readonly unknown[]): SceneElement[];
}

let runtime: Promise<ExcalidrawRuntime> | null = null;

/** The runtime, built once per process. */
export function loadExcalidraw(): Promise<ExcalidrawRuntime> {
  runtime ??= build();
  return runtime;
}

async function build(): Promise<ExcalidrawRuntime> {
  installDomStubs();

  const excalidraw = await import("@excalidraw/excalidraw");
  excalidraw.setCustomTextMetricsProvider({ getLineWidth: measureLineWidth });

  return {
    convert(skeletons) {
      return excalidraw.convertToExcalidrawElements(
        skeletons as Parameters<typeof excalidraw.convertToExcalidrawElements>[0],
        { regenerateIds: false },
      ) as unknown as SceneElement[];
    },
  };
}
