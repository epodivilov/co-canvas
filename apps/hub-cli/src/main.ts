#!/usr/bin/env node
import { createHub } from "@co-canvas/hub";

// Argument parsing and idle shutdown land in CC-3; for now this is the thinnest
// possible process wrapper around the library.
const hub = createHub();
const url = await hub.start();

process.stderr.write(`co-canvas hub listening on ${url} (data: ${hub.dataDir})\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void hub.stop();
  });
}
