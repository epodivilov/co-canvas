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

// Exiting hard on purpose: the scenario that watches this process disappear is
// asserting that the hub it started is not tied to it, and a hard exit is the
// least forgiving version of that. It also skips the wait for the probe's
// keep-alive socket to time out.
process.stdout.write(`${info.url}\n`, () => {
  process.exit(0);
});
