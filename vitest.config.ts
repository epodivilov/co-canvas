import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests are colocated with the code they cover so that each package's
    // `include: ["src"]` keeps typechecking them.
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    server: {
      deps: {
        // Node's own resolver cannot load `@excalidraw/excalidraw` at all: the
        // package imports `open-color.json` without an import attribute.
        // Inlining routes it through Vite's transform pipeline, which is one of
        // only two proven ways to consume it — the other being a bundler, which
        // is how the shipped bridge gets it.
        inline: ["@excalidraw/excalidraw"],
      },
    },
  },
});
