import { unlinkSync } from "node:fs";
import type { Hub, HubOptions } from "@co-canvas/hub";
import { createHub } from "@co-canvas/hub";
import { clearHubLock, hubLockPath, writeHubLock } from "@co-canvas/hub-client";
import { appendHubLog, appendHubLogSync } from "./log-file.ts";
import { HELP_TEXT, parseOptions, type ResolvedOptions } from "./options.ts";

/**
 * The frontend the build ships, used when `--static` is not given. The Node
 * build output points {@link StaticDefault.dir} at the directory it copied the
 * `apps/web` build into; the `bun --compile` binary, which has no directory to
 * read from, hands over {@link StaticDefault.assets} embedded in the executable.
 */
export interface StaticDefault {
  dir?: string;
  assets?: ReadonlyMap<string, Uint8Array>;
}

export interface CliDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  defaultStatic: StaticDefault;
}

/**
 * Runs the hub as a process: resolves its configuration, binds, records itself
 * in the lockfile, serves until a signal or a long idle period, and writes
 * every room out on the way down.
 *
 * Sets `process.exitCode` rather than calling `process.exit()` on the graceful
 * paths. The stop is awaited in full first, so the port is released and every
 * room flushed before the event loop drains and the process ends on its own —
 * calling `process.exit()` from the signal callback instead would abort the
 * process mid-flush and lose exactly the work the graceful stop exists to save.
 */
export async function runHubCli(deps: CliDeps): Promise<void> {
  const parsed = parseOptions(deps.argv, deps.env);

  if (parsed.kind === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`co-canvas hub: ${parsed.message}\n`);
    process.exitCode = 1;
    return;
  }

  const options = parsed.options;
  const hub = createHub(hubOptionsFrom(options, deps.defaultStatic));

  try {
    await hub.start();
  } catch (error) {
    // Refusing to start: the port is held, or the data directory cannot be
    // prepared. The bind runs before the data directory is touched, so a busy
    // port leaves nothing behind — `appendHubLog` swallows the `ENOENT` from a
    // directory that was never created, and only records the failure when the
    // directory already exists from a previous run.
    const message = describeStartupError(error, options);
    process.stderr.write(`co-canvas hub: ${message}\n`);
    await appendHubLog(options.dataDir, `failed to start: ${message}`);
    process.exitCode = 1;
    return;
  }

  const url = hub.url as string;
  const boundPort = Number(new URL(url).port);

  // Written only now, once the port is bound and known: the lockfile carries the
  // pid of this process and the port it actually bound — the real one even when
  // `--port 0` asked the OS to choose.
  await writeHubLock(options.dataDir, { port: boundPort });

  // The last-resort cleanup. Whatever the exit — a signal, idle shutdown, a
  // crash after the bind — the event loop reaching `exit` removes the lockfile,
  // so no `hub.lock` is ever left claiming a process that is gone. The graceful
  // paths remove it earlier and asynchronously; this is the synchronous net
  // under them.
  armLockfileCleanup(options.dataDir);
  installCrashHandlers(options.dataDir);

  // Installed synchronously after the lockfile is written and before the next
  // `await`: a signal cannot slip in between the lock existing and its handler
  // being ready, which would fall through to Node's default and skip the
  // graceful stop. (The lockfile is written first so any later clear happens
  // after the write, never racing it.)
  installShutdown(hub, options);

  const startup = `listening on ${url} (pid ${process.pid}, data ${options.dataDir}, ${describeIdle(options.idleTimeoutMs)})`;
  process.stderr.write(`co-canvas hub ${startup}\n`);
  await appendHubLog(options.dataDir, startup);
}

/** Turns the resolved options into the hub's own options, honouring the static precedence. */
function hubOptionsFrom(options: ResolvedOptions, defaultStatic: StaticDefault): HubOptions {
  const hubOptions: HubOptions = { port: options.port, dataDir: options.dataDir };
  const dir = options.staticDir ?? defaultStatic.dir;
  if (dir !== undefined) {
    hubOptions.staticDir = dir;
  } else if (defaultStatic.assets !== undefined) {
    hubOptions.staticAssets = defaultStatic.assets;
  }
  return hubOptions;
}

/**
 * Wires the deliberate exits — `SIGINT`, `SIGTERM`, idle shutdown — to a single
 * graceful stop, and arms the idle timer.
 */
function installShutdown(hub: Hub, options: ResolvedOptions): void {
  let shuttingDown: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  function clearIdle(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdle(): void {
    if (options.idleTimeoutMs <= 0) return; // 0 disables idle shutdown entirely
    clearIdle();
    idleTimer = setTimeout(() => void shutdown("idle"), options.idleTimeoutMs);
    // The listening server keeps the process alive; this timer must not. An
    // unref'd timer still fires while the process is up but is not itself a
    // reason to stay up — the same reason room eviction timers are unref'd.
    idleTimer.unref();
  }

  function shutdown(reason: string): Promise<void> {
    if (shuttingDown !== null) return shuttingDown;
    shuttingDown = (async () => {
      clearIdle();
      // The lockfile goes before the port is released: it narrows the window in
      // which a client probes a hub that has already decided to exit. It cannot
      // close it — the caller re-acquires a hub on its next tool call.
      await clearHubLock(options.dataDir);
      try {
        await hub.stop();
        await appendHubLog(options.dataDir, `shutdown (${reason})`);
        process.exitCode = 0;
      } catch (error) {
        const message = errorMessage(error);
        process.stderr.write(`co-canvas hub failed to stop cleanly: ${message}\n`);
        await appendHubLog(options.dataDir, `failed to stop cleanly (${reason}): ${message}`);
        process.exitCode = 1;
      }
    })();
    return shuttingDown;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  // An open browser tab is a connected peer, and a peer keeps the hub. The timer
  // is disarmed the moment one connects and re-armed from the moment the last
  // one leaves, so a peer arriving midway through the window postpones the exit
  // rather than being ignored.
  hub.onPeersChanged((totalPeers) => {
    if (totalPeers > 0) clearIdle();
    else armIdle();
  });

  // No peer has connected yet: the countdown starts now.
  armIdle();
}

/**
 * Registers a synchronous lockfile removal on process exit.
 *
 * Exported so the fail-after-bind path can be exercised on its own: a hub that
 * has written its lockfile and then dies must not leave it behind.
 */
export function armLockfileCleanup(dataDir: string): void {
  process.on("exit", () => {
    try {
      unlinkSync(hubLockPath(dataDir));
    } catch {
      // Already gone (the graceful path removed it) or never ours to remove.
    }
  });
}

function installCrashHandlers(dataDir: string): void {
  const onFatal = (error: unknown): void => {
    process.stderr.write(`co-canvas hub crashed: ${errorMessage(error)}\n`);
    appendHubLogSync(dataDir, `crashed: ${errorMessage(error)}`);
    // Exits non-zero and fires `exit`, where the lockfile backstop clears the claim.
    process.exit(1);
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", (reason) => onFatal(reason));
}

function describeIdle(idleTimeoutMs: number): string {
  return idleTimeoutMs <= 0 ? "idle shutdown disabled" : `idle-timeout ${idleTimeoutMs}ms`;
}

function describeStartupError(error: unknown, options: ResolvedOptions): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") return `port ${options.port} is already in use`;
  if (code === "EACCES") return `port ${options.port} cannot be bound: permission denied`;
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
