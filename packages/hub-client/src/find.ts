import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { DEFAULT_HOST, DEFAULT_PORT, PROTOCOL_VERSION } from "@co-canvas/protocol";
import { HubClientError } from "./errors.ts";
import type { HubLock } from "./lockfile.ts";
import { clearHubLock, defaultDataDir, readHubLock } from "./lockfile.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, probeHub } from "./probe.ts";

/** A hub that answered its health endpoint. */
export interface HubInfo {
  /** Base URL, e.g. `http://127.0.0.1:4321`. */
  readonly url: string;
  /** Port the hub is listening on. */
  readonly port: number;
  /**
   * Pid of the hub, when a lockfile claimed this port. Absent otherwise: the
   * health response carries no pid and this client will not put its own guess
   * there — after a race the process it started may not be the one listening.
   */
  readonly pid?: number;
}

/** Where to look for a hub. */
export interface FindHubOptions {
  /** Probe only this port. Without it the lockfile's port then `DEFAULT_PORT`. */
  port?: number;
  /** Directory holding `hub.lock`. Defaults to `~/.co-canvas`. */
  dataDir?: string;
  /** Budget for a single health request. */
  probeTimeoutMs?: number;
}

/** Where to look, and what to run when nothing is found. */
export interface FindOrStartHubOptions extends FindHubOptions {
  /**
   * Executable that starts a hub. Resolving it is the caller's business: the
   * packaged binary's path is only knowable once the shipping shape is decided,
   * and guessing it here would bake in an assumption packaging has to unpick.
   */
  command: string;
  /** Arguments for `command`. */
  args?: readonly string[];
  /** Extra environment for the started process. */
  env?: Readonly<Record<string, string>>;
  /** How long the started process has to answer as a healthy hub. */
  startupTimeoutMs?: number;
}

/**
 * Environment variable naming the port a started hub must bind.
 *
 * The port is passed through the environment rather than through arguments
 * because the caller owns the command line and its flag syntax is not this
 * package's to invent; CC-3 has to read this when it wires the hub process up.
 */
export const HUB_PORT_ENV = "CO_CANVAS_PORT";

/** Environment variable naming the data directory a started hub must use. */
export const HUB_DATA_DIR_ENV = "CO_CANVAS_DATA_DIR";

/** How long a started process has to answer as a healthy hub. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/** First gap between health polls; it grows from here. */
const INITIAL_POLL_DELAY_MS = 25;
const MAX_POLL_DELAY_MS = 250;
const POLL_BACKOFF = 1.5;

/**
 * How long to keep looking for a hub after the started process died. Long
 * enough for a lost port race to resolve, far short of the startup budget.
 */
const EXIT_GRACE_MS = 500;

/** How long a process gets to honour `SIGTERM` before `SIGKILL`. */
const TERMINATE_GRACE_MS = 2000;

/**
 * Probes for a running hub. Starts nothing, and writes nothing.
 *
 * Resolves with `null` when nothing answers. Rejects when something answers on
 * the port a hub belongs on and is not a hub this client can use — that is not
 * "no hub is running", and swallowing it would leave the caller to rediscover
 * the same conflict through `findOrStartHub`.
 */
export async function findHub(options: FindHubOptions = {}): Promise<HubInfo | null> {
  const survey = await surveyHub(options);
  if (survey.conflict !== null) throw survey.conflict;
  return survey.found;
}

/**
 * Probes for a running hub and starts one when nothing answers.
 *
 * The started process is detached and survives this one, which is what makes
 * the hub an on-demand singleton rather than a daemon somebody has to install.
 */
export async function findOrStartHub(options: FindOrStartHubOptions): Promise<HubInfo> {
  const survey = await surveyHub(options);

  // The only write this client makes to the lockfile. It retracts a claim the
  // probe has just disproved, which is not the same act as recording a hub:
  // that one belongs to the hub process, after its bind.
  const disproved =
    survey.lock !== null &&
    survey.probed.includes(survey.lock.port) &&
    survey.found?.port !== survey.lock.port;
  if (disproved) await clearHubLock(survey.dataDir);

  if (survey.found !== null) return survey.found;
  if (survey.conflict !== null) throw survey.conflict;
  return await startHub(options, survey);
}

interface Survey {
  dataDir: string;
  lock: HubLock | null;
  /** Ports actually probed, in order. */
  probed: number[];
  /** The port a hub belongs on: the explicit one, or the default. */
  primaryPort: number;
  found: HubInfo | null;
  /** What is sitting on `primaryPort` instead of a usable hub, if anything. */
  conflict: HubClientError | null;
}

async function surveyHub(options: FindHubOptions): Promise<Survey> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const lock = await readHubLock(dataDir);
  const primaryPort = options.port ?? DEFAULT_PORT;

  const survey: Survey = { dataDir, lock, probed: [], primaryPort, found: null, conflict: null };

  for (const port of candidatePorts(options.port, lock)) {
    survey.probed.push(port);
    const probe = await probeHub(port, probeTimeoutMs);
    if (probe.kind === "hub") {
      survey.found = describe(port, lock);
      break;
    }
    // A conflict only matters on the port a hub belongs on. The lockfile's port
    // is a hint about where one used to be, and a stranger sitting there now is
    // no reason to refuse the caller a hub on the port they asked for.
    if (port !== primaryPort) continue;
    if (probe.kind === "foreign") survey.conflict = portOccupied(port);
    if (probe.kind === "protocol-mismatch")
      survey.conflict = protocolMismatch(port, probe.protocol);
  }

  return survey;
}

/**
 * Ports to probe, in order.
 *
 * An explicit port is the whole list: the caller has said where their hub is,
 * and probing anything else would find a different one. Without one, the
 * lockfile's port comes first so that a hub started by hand somewhere else is
 * found rather than duplicated.
 */
function candidatePorts(explicit: number | undefined, lock: HubLock | null): number[] {
  if (explicit !== undefined) return [explicit];
  if (lock !== null && lock.port !== DEFAULT_PORT) return [lock.port, DEFAULT_PORT];
  return [DEFAULT_PORT];
}

function describe(port: number, lock: HubLock | null): HubInfo {
  const url = `http://${DEFAULT_HOST}:${port}`;
  return lock !== null && lock.port === port ? { url, port, pid: lock.pid } : { url, port };
}

type StartOutcome =
  | { kind: "healthy" }
  | { kind: "mismatch"; protocol: number }
  | { kind: "timeout" }
  | { kind: "spawn-failed"; error: Error }
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "cancelled" };

async function startHub(options: FindOrStartHubOptions, survey: Survey): Promise<HubInfo> {
  // Always the primary port. A port read from the lockfile is a hint about where
  // a hub was, never a target to start on: honouring it would resurrect a hub on
  // a port the caller has since moved away from.
  const port = survey.primaryPort;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const args = [...(options.args ?? [])];
  const description = [options.command, ...args].join(" ");

  let child: ChildProcess;
  try {
    child = spawn(options.command, args, {
      detached: true,
      // `detached` alone does not outlive this process: inherited or piped stdio
      // ties the two together through file descriptors, and a referenced handle
      // keeps this event loop alive. `ignore` is the safe choice while the hub
      // has no log file of its own.
      stdio: "ignore",
      env: {
        ...process.env,
        ...options.env,
        [HUB_PORT_ENV]: String(port),
        [HUB_DATA_DIR_ENV]: survey.dataDir,
      },
    });
  } catch (error) {
    // Not every refusal to run a command arrives through the `error` event: an
    // argument `spawn` rejects out of hand — an empty command, most plausibly a
    // hub command read from an environment variable that is set but blank —
    // throws from this call instead. A caller cannot tell the two apart and
    // should not have to, so both leave through the same code.
    throw new HubClientError(
      "spawn-failed",
      `failed to start the hub with command \`${description}\``,
      { cause: error },
    );
  }
  child.unref();

  const cancellation = { cancelled: false };
  const health = pollHealth(port, probeTimeoutMs, Date.now() + startupTimeoutMs, cancellation);
  const fate = watchChild(child);

  try {
    let outcome = await Promise.race([health, fate]);

    if (outcome.kind === "exited") {
      // Losing the port race is a designed outcome, not a failure: the OS grants
      // the port to one process, everyone else's hub dies on EADDRINUSE, and
      // every caller has to converge on the survivor. The winner is already
      // serving by the time a loser dies, so this waits a moment rather than the
      // whole startup budget — which is also what keeps a genuine early exit
      // from being reported ten seconds late.
      const exited = outcome;
      outcome = await Promise.race([health, sleep(EXIT_GRACE_MS).then((): StartOutcome => exited)]);
    }

    switch (outcome.kind) {
      case "healthy":
        return await describeStarted(port, survey.dataDir);
      case "mismatch":
        await stopChild(child);
        throw protocolMismatch(port, outcome.protocol);
      case "spawn-failed":
        throw new HubClientError(
          "spawn-failed",
          `failed to start the hub with command \`${description}\``,
          { cause: outcome.error },
        );
      case "exited":
        await stopChild(child);
        throw new HubClientError(
          "start-failed",
          `command \`${description}\` ${exitReason(outcome)} before answering as a co-canvas hub` +
            ` on port ${port} (startup timeout ${startupTimeoutMs}ms)`,
        );
      // `cancelled` cannot reach here — the flag is only set once this call has
      // settled — but grouping it with the timeout keeps the union exhaustive.
      case "timeout":
      case "cancelled":
        await stopChild(child);
        throw new HubClientError(
          "start-failed",
          `command \`${description}\` did not answer as a co-canvas hub on port ${port}` +
            ` within ${startupTimeoutMs}ms`,
        );
    }
  } finally {
    cancellation.cancelled = true;
  }
}

function exitReason(outcome: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (outcome.signal !== null) return `was killed by ${outcome.signal}`;
  return `exited with code ${outcome.code ?? "unknown"}`;
}

/** Reports the first thing that happens to the started process. */
function watchChild(child: ChildProcess): Promise<StartOutcome> {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ kind: "spawn-failed", error }));
    child.once("exit", (code, signal) => resolve({ kind: "exited", code, signal }));
  });
}

/** Polls the health endpoint with a growing gap until it answers or time runs out. */
async function pollHealth(
  port: number,
  probeTimeoutMs: number,
  deadline: number,
  cancellation: { cancelled: boolean },
): Promise<StartOutcome> {
  let delay = INITIAL_POLL_DELAY_MS;
  for (;;) {
    const probe = await probeHub(port, probeTimeoutMs);
    if (cancellation.cancelled) return { kind: "cancelled" };
    if (probe.kind === "hub") return { kind: "healthy" };
    if (probe.kind === "protocol-mismatch") return { kind: "mismatch", protocol: probe.protocol };
    if (Date.now() >= deadline) return { kind: "timeout" };

    await sleep(delay);
    if (cancellation.cancelled) return { kind: "cancelled" };
    delay = Math.min(Math.round(delay * POLL_BACKOFF), MAX_POLL_DELAY_MS);
  }
}

/**
 * Reads back the pid of the hub now on `port`, if it recorded one.
 *
 * The pid comes from the lockfile rather than from the child handle on purpose:
 * after a lost race the process this call started is dead and the hub answering
 * is somebody else's.
 */
async function describeStarted(port: number, dataDir: string): Promise<HubInfo> {
  return describe(port, await readHubLock(dataDir));
}

/** Terminates a process this call started, so no failure leaves one behind. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  const stopped = await Promise.race([exited.then(() => true), sleep(TERMINATE_GRACE_MS)]);
  if (stopped === true) return;

  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([exited, sleep(TERMINATE_GRACE_MS)]);
}

function portOccupied(port: number): HubClientError {
  return new HubClientError(
    "port-occupied",
    `port ${port} is held by a service that does not answer /health as a co-canvas hub;` +
      " free that port or name another one with the `port` option",
  );
}

function protocolMismatch(port: number, protocol: number): HubClientError {
  return new HubClientError(
    "protocol-mismatch",
    `the co-canvas hub on port ${port} speaks protocol ${protocol},` +
      ` this client speaks protocol ${PROTOCOL_VERSION}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
