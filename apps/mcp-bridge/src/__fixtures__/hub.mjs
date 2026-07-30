#!/usr/bin/env node
/**
 * A real hub in a real process, so the hub-acquisition scenarios drive
 * `findOrStartHub` against something that actually binds a port, answers
 * `/health` and serves `/sync/{slug}` — the three things a tool call needs.
 *
 * The port arrives on argv rather than through `CO_CANVAS_PORT`, because until
 * CC-3 gives `apps/hub-cli` a `--port` flag the real binary can only ever bind
 * the default one, and a scenario that used the default would be decided by
 * whatever the developer left running.
 *
 *   argv[2]             port to bind
 *   argv[3]             file to append this pid to, so a scenario can reap a
 *                       hub `findOrStartHub` detached from it
 *   CO_CANVAS_DATA_DIR  data directory, written by `findOrStartHub`
 */
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

// `@co-canvas/hub` ships TypeScript source whose relative imports carry no
// extension — fine for tsc and for vite, but Node's resolver does not guess.
// Retrying a failed relative resolution with `.ts` is the smallest thing that
// lets a plain `node` process load the real hub instead of a hand-written
// imitation that could agree with a broken bridge.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { createHub } = await import("@co-canvas/hub");

const port = Number(process.argv[2] ?? "0");
const pidFile = process.argv[3];
const dataDir = process.env.CO_CANVAS_DATA_DIR;

const hub = createHub(dataDir === undefined ? { port } : { port, dataDir });
await hub.start();

// Written after the bind, so its presence means "a hub was started here" and
// its absence means nothing was spawned at all.
if (pidFile !== undefined) appendFileSync(pidFile, `${process.pid}\n`);

// This process is detached from the scenario that started it, so a cleanup that
// never ran would leave it holding the port for the rest of the test run.
setTimeout(() => {
  process.exit(0);
}, 60_000).unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void hub.stop().then(() => {
      process.exit(0);
    });
  });
}
