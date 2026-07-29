#!/usr/bin/env node
/**
 * Calls `findOrStartHub` from a process of its own and prints the URL it got.
 *
 * Two scenarios need this: proving that a started hub outlives the process that
 * asked for it, and racing several callers against each other. Neither can be
 * observed from inside the test runner.
 */
import { fileURLToPath } from "node:url";
import { findOrStartHub } from "@co-canvas/hub-client";

const fakeHub = fileURLToPath(new URL("./fake-hub.mjs", import.meta.url));

const info = await findOrStartHub({
  command: process.execPath,
  args: [fakeHub],
  port: Number(process.env.CO_CANVAS_PORT),
  dataDir: process.env.CO_CANVAS_DATA_DIR,
  env: {
    FAKE_HUB_MODE: process.env.FAKE_HUB_MODE ?? "healthy",
    FAKE_HUB_LOG_DIR: process.env.FAKE_HUB_LOG_DIR ?? "",
  },
});

if (process.env.CALLER_EXIT === "natural") {
  // Falls off the end of its own event loop with nothing forcing the issue.
  // This is the version that notices a child handle left referenced: the hub
  // outlives its parent by an hour, and a parent still holding it would wait.
  process.stdout.write(`${info.url}\n`);
} else {
  // A hard exit is the least forgiving version of the fd question — the parent
  // vanishes without unwinding anything, so a hub sharing its stdio or its
  // process group has no chance to be let go of gracefully.
  process.stdout.write(`${info.url}\n`, () => {
    process.exit(0);
  });
}
