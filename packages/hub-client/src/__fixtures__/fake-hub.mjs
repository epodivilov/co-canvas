#!/usr/bin/env node
/**
 * Stand-in for the real hub, so the scenarios drive actual processes instead of
 * mocks: the real hub cannot write a lockfile until CC-3 lands, and a mocked
 * spawn would prove nothing about detachment, port races or stale locks.
 *
 * Plain `.mjs` on purpose — no type-stripping dependency, and it still imports
 * the workspace packages by name through the pnpm symlink.
 *
 * Configured entirely through the environment, because that is how
 * `findOrStartHub` talks to the process it starts:
 *   FAKE_HUB_MODE     which of the behaviours below to act out
 *   FAKE_HUB_LOG_DIR  where to append `spawned.log` / `bound.log`
 *   CO_CANVAS_PORT    port to bind
 *   CO_CANVAS_DATA_DIR  data directory, for the lockfile-writing mode
 *   FAKE_HUB_BIND_DELAY_MS  how long to wait before binding, so a scenario can
 *                     put a hub's arrival after another process has given up
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { writeHubLock } from "@co-canvas/hub-client";
import { DEFAULT_HOST, HUB_SERVICE_ID, PROTOCOL_VERSION } from "@co-canvas/protocol";

const mode = process.env.FAKE_HUB_MODE ?? "healthy";
const port = Number(process.env.CO_CANVAS_PORT ?? "0");
const dataDir = process.env.CO_CANVAS_DATA_DIR ?? "";
const logDir = process.env.FAKE_HUB_LOG_DIR ?? dataDir;
const bindDelayMs = Number(process.env.FAKE_HUB_BIND_DELAY_MS ?? "0");

/**
 * Appends this pid to one of the logs. `appendFileSync` on a small line is a
 * single O_APPEND write, which is what makes the race scenario's counting
 * trustworthy across processes.
 */
function log(file) {
  if (logDir === "") return;
  appendFileSync(join(logDir, file), `${process.pid}\n`);
}

// On entry, before anything can fail: the scenarios count starts, not successes.
log("spawned.log");

if (mode === "exit-nonzero") {
  process.exit(3);
}

if (mode === "never-bind") {
  // Alive, silent, holding no port. The safety net keeps a leaked fixture from
  // outliving the test run by more than a minute.
  setTimeout(() => {
    process.exit(0);
  }, 60_000);
} else {
  serve();
}

function healthPayload() {
  if (mode === "foreign") return { service: "some-other-tool", protocol: PROTOCOL_VERSION };
  if (mode === "protocol-999") return { service: HUB_SERVICE_ID, protocol: 999 };
  return { service: HUB_SERVICE_ID, protocol: PROTOCOL_VERSION };
}

function serve() {
  const server = createServer((request, response) => {
    if (mode !== "not-found" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(healthPayload()));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  // Losing the port race is the designed outcome for every caller but one, so a
  // loser has to die quietly rather than hang around half-started.
  server.on("error", (error) => {
    process.exit(error.code === "EADDRINUSE" ? 2 : 1);
  });

  const listen = () => {
    server.listen(port, DEFAULT_HOST, () => {
      // Only ever written by the process that actually holds the port.
      log("bound.log");
      if (mode === "healthy-lockfile") {
        // The honest simulation of CC-3: the hub records itself, after the bind.
        writeHubLock(dataDir, { port }).catch(() => process.exit(1));
      }
    });
  };
  if (bindDelayMs > 0) setTimeout(listen, bindDelayMs);
  else listen();

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }

  setTimeout(() => {
    process.exit(0);
  }, 60_000).unref();
}
