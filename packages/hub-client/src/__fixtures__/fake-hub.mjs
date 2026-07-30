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
 *   FAKE_HUB_BIND_AFTER_EXIT  pid log to wait on before binding, so a scenario
 *                     can put a hub's arrival after another process has died
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { join } from "node:path";
import { writeHubLock } from "@co-canvas/hub-client";
import { DEFAULT_HOST, HUB_SERVICE_ID, PROTOCOL_VERSION } from "@co-canvas/protocol";

const mode = process.env.FAKE_HUB_MODE ?? "healthy";
const port = Number(process.env.CO_CANVAS_PORT ?? "0");
const dataDir = process.env.CO_CANVAS_DATA_DIR ?? "";
const logDir = process.env.FAKE_HUB_LOG_DIR ?? dataDir;
const bindAfterExit = process.env.FAKE_HUB_BIND_AFTER_EXIT ?? "";

/** How often to look at the watched process, and how long to keep looking. */
const EXIT_POLL_MS = 5;
const EXIT_WAIT_MS = 10_000;

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

function createModeServer() {
  if (mode === "mute") {
    // Accepts the connection and then says nothing at all, ever. This is the
    // shape a probe without a timeout waits on forever, and the one thing an
    // HTTP-level fixture cannot imitate.
    return createSocketServer((socket) => {
      socket.on("error", () => {});
    });
  }
  return createServer((request, response) => {
    if (mode !== "not-found" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(healthPayload()));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
}

/** Last pid appended to `FAKE_HUB_BIND_AFTER_EXIT`, or null while it has none. */
function watchedPid() {
  let text;
  try {
    text = readFileSync(bindAfterExit, "utf8");
  } catch {
    return null;
  }
  const last = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1);
  return last === undefined ? null : Number(last);
}

/** Whether `pid` still names a process. `EPERM` is somebody else's, so alive. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Calls `ready` once the process named by `FAKE_HUB_BIND_AFTER_EXIT` is gone.
 *
 * The pid vanishing is the moment its parent reaped it, which is the same turn
 * of that parent's loop as its `exit` event — so a scenario that wants this hub
 * to arrive after some other process died gets an ordering rather than a bet on
 * how long two unrelated Node processes take to boot. A zombie still answers
 * signal 0, and waiting through that is the point: it is the reaping, not the
 * dying, that the watcher on the other side can act on.
 *
 * Polling is crude, but a detached process this fixture holds no handle on has
 * no other channel, and 5ms is an order of magnitude tighter than anything the
 * scenarios resolve. Never arriving is a wiring mistake, so it says so on
 * stderr rather than waiting quietly until some outer timeout blames the wrong
 * thing.
 */
function awaitWatchedExit(ready) {
  const deadline = Date.now() + EXIT_WAIT_MS;
  const poll = () => {
    const pid = watchedPid();
    if (pid !== null && !alive(pid)) {
      ready();
      return;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        `fake hub: no process from ${bindAfterExit} exited within ${EXIT_WAIT_MS}ms\n`,
      );
      process.exit(1);
    }
    setTimeout(poll, EXIT_POLL_MS);
  };
  poll();
}

function serve() {
  const server = createModeServer();

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
  if (bindAfterExit === "") listen();
  else awaitWatchedExit(listen);

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
