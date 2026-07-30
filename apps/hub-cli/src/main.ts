#!/usr/bin/env node
import { createHub } from "@co-canvas/hub";

// Argument parsing and idle shutdown land in CC-3; for now this is the thinnest
// possible process wrapper around the library.
const hub = createHub();
const url = await hub.start();

process.stderr.write(`co-canvas hub listening on ${url} (data: ${hub.dataDir})\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // `stop()` now writes every room out before it resolves, and Node keeps the
    // process alive while those writes are outstanding. What it cannot survive
    // is the rejection going unhandled: that would abort the process mid-flush
    // and cost exactly the work the graceful stop exists to save.
    hub.stop().catch((error: unknown) => {
      process.exitCode = 1;
      process.stderr.write(`co-canvas hub failed to stop cleanly: ${String(error)}\n`);
    });
  });
}
