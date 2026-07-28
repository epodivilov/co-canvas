import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Package is ESM-only, so plain `.js` is unambiguous and keeps `bin` readable.
  fixedExtension: false,
  // Workspace packages ship as source, so they get inlined instead of resolved at runtime.
  deps: { alwaysBundle: [/^@co-canvas\//] },
  dts: false,
  clean: true,
});
