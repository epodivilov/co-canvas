import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Package is ESM-only, so plain `.js` is unambiguous and keeps `bin` readable.
  fixedExtension: false,
  deps: {
    alwaysBundle: [
      // Workspace packages ship as source, so they get inlined instead of
      // resolved at runtime.
      /^@co-canvas\//,
      // Excalidraw and its React peers have to end up inside the bundle, and
      // that is not a preference: nothing can import `@excalidraw/excalidraw`
      // through Node's own resolver, because it imports `open-color.json`
      // without an import attribute. Being devDependencies already puts them
      // here; saying so keeps a later move into `dependencies` from quietly
      // turning the shipped bridge into one that cannot draw.
      /^@excalidraw\//,
      /^react(-dom)?(\/|$)/,
    ],
  },
  dts: false,
  clean: true,
});
