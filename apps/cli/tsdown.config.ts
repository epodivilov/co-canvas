import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

/** The workspace source this package bundles, aliased so no `@co-canvas/*` dep is declared. */
const from = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The published `co-canvas` version, read from this package's own manifest so a
 * Changesets bump is the only edit — nothing to keep in sync in `server.ts`.
 * A filesystem read rather than a JSON import: `verbatimModuleSyntax` is on, and
 * this stays a plain config value with no import-attribute plumbing.
 */
const { version } = JSON.parse(readFileSync(from("./package.json"), "utf8")) as {
  version?: unknown;
};
if (typeof version !== "string" || version === "") {
  throw new Error(
    "apps/cli/package.json has no `version` string to bake into __CO_CANVAS_VERSION__;" +
      " a missing version would emit a malformed `define`. Set a version before building.",
  );
}

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Package is ESM-only, so plain `.js` is unambiguous and keeps `bin` readable.
  fixedExtension: false,
  // The bridge factory and the workspace packages it pulls in are resolved to
  // source here rather than through a `dependencies` entry, so the published
  // manifest carries no `workspace:*` anywhere — the bridge stays private and is
  // inlined into this bundle instead.
  alias: {
    "@co-canvas/mcp-bridge": from("../mcp-bridge/src/index.ts"),
    "@co-canvas/hub-client": from("../../packages/hub-client/src/index.ts"),
    "@co-canvas/protocol": from("../../packages/protocol/src/index.ts"),
  },
  deps: {
    alwaysBundle: [
      // The aliased bridge source and its workspace deps ship inlined.
      /^@co-canvas\//,
      // Excalidraw and its React peers must end up inside the bundle: nothing can
      // import `@excalidraw/excalidraw` through Node's own resolver, because it
      // imports `open-color.json` without an import attribute. The genuinely
      // external deps — the MCP SDK, yjs, y-websocket, fractional-indexing, zod —
      // stay external and are the package's only runtime `dependencies`.
      /^@excalidraw\//,
      /^react(-dom)?(\/|$)/,
    ],
  },
  // Replaces the `__CO_CANVAS_VERSION__` token in the bundled bridge source with
  // this package's version, so its `serverInfo.version` reports the shipped
  // release instead of a placeholder (CC-27). A `define` value is substituted
  // verbatim, so it must be a JSON-stringified string.
  define: {
    __CO_CANVAS_VERSION__: JSON.stringify(version),
  },
  dts: false,
  clean: true,
});
