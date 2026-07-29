import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Tests are colocated with the code they cover so that each package's
    // `include: ["src"]` keeps typechecking them.
    include: ["{apps,packages}/*/src/**/*.test.ts"],
  },
});
