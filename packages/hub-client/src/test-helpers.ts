import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST } from "@co-canvas/protocol";
import { HubClientError } from "./errors.ts";

/** Behaviours the fake hub fixture can act out; see `__fixtures__/fake-hub.mjs`. */
export type FakeHubMode =
  | "healthy"
  | "healthy-lockfile"
  | "foreign"
  | "protocol-999"
  | "not-found"
  | "never-bind"
  | "exit-nonzero";

export const FAKE_HUB = fileURLToPath(new URL("./__fixtures__/fake-hub.mjs", import.meta.url));
export const SLEEPER = fileURLToPath(new URL("./__fixtures__/sleeper.mjs", import.meta.url));
export const CALLER = fileURLToPath(new URL("./__fixtures__/caller.mjs", import.meta.url));

/**
 * A port nothing is listening on right now.
 *
 * Never `DEFAULT_PORT`: a real hub or a leftover from another run would make the
 * result depend on whatever happens to be running on the machine.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("no port assigned")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Whether `pid` names a live process.
 *
 * `EPERM` means a process owned by someone else — alive, not absent. Treating
 * every throw as "dead" is the classic version of this bug.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Resolves once `predicate` holds, rejects when it never does. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`${message} (waited ${timeoutMs}ms)`);
    await sleep(20);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a TCP connection to `port` is accepted.
 *
 * Deliberately not the package's own `probeHub`: readiness of the fixtures is
 * checked with something the code under test has no part in.
 */
export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: DEFAULT_HOST });
    socket.setTimeout(1000);
    const finish = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

/** A child's pid, or a loud failure — `ChildProcess.pid` is optional. */
export function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("child process has no pid");
  return child.pid;
}

/**
 * Awaits a rejection and hands back the error, so a scenario can assert on its
 * code and message. Fails loudly when the call resolves instead.
 */
export async function rejection(promise: Promise<unknown>): Promise<HubClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HubClientError) return error;
    throw error;
  }
  throw new Error("expected the call to reject, it resolved");
}

/** Pids a fixture appended to `logPath`; `[]` when the log was never written. */
export async function readPids(logPath: string): Promise<number[]> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number(line));
}

interface StartFakeHubOptions {
  mode: FakeHubMode;
  port: number;
  /** Data directory the fixture writes its lockfile into, when its mode does. */
  dataDir?: string;
  /** Where the fixture appends its logs. Defaults to the scenario's ambient log. */
  logDir?: string;
  /** Wait until the port is accepting connections. Off for the non-binding modes. */
  awaitListening?: boolean;
  /** Delay the bind, so the hub can be made to arrive at a chosen moment. */
  bindDelayMs?: number;
}

interface RunCallerOptions {
  port: number;
  dataDir: string;
  mode?: FakeHubMode;
  logDir?: string;
}

export interface CallerOutcome {
  code: number | null;
  stdout: string;
}

/**
 * One scenario's world: its own temporary data directory, its own logs and a
 * list of everything it started, so nothing survives into the next test.
 */
export interface Scenario {
  readonly root: string;
  /** Data directory handed to the client under test. */
  readonly dataDir: string;
  /** Log directory handed to hubs the client starts. */
  readonly logDir: string;
  /**
   * Log directory for hubs the scenario starts by hand. Kept apart so that
   * "nothing was spawned" stays an assertion about the client's behaviour.
   */
  readonly ambientLogDir: string;
  startFakeHub(options: StartFakeHubOptions): Promise<ChildProcess>;
  startSleeper(): Promise<ChildProcess>;
  /** A pid that is certainly nobody's: a process started, killed and reaped. */
  deadPid(): Promise<number>;
  runCaller(options: RunCallerOptions): Promise<CallerOutcome>;
  /** Pids of hubs the client started. */
  spawnedPids(): Promise<number[]>;
  /** Pids of hubs the client started that went on to hold the port. */
  boundPids(): Promise<number[]>;
  spawnedLogPath(): string;
  cleanup(): Promise<void>;
}

/** The `command` / `args` / `env` triple that starts a fake hub in `mode`. */
export interface FakeHubCommand {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
}

export function fakeHubCommand(scenario: Scenario, mode: FakeHubMode = "healthy"): FakeHubCommand {
  return {
    command: process.execPath,
    args: [FAKE_HUB],
    env: { FAKE_HUB_MODE: mode, FAKE_HUB_LOG_DIR: scenario.logDir },
  };
}

export async function createScenario(): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), "co-canvas-hub-client-"));
  const dataDir = join(root, "data");
  const logDir = join(root, "started");
  const ambientLogDir = join(root, "ambient");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(logDir, { recursive: true }),
    mkdir(ambientLogDir, { recursive: true }),
  ]);

  const children: ChildProcess[] = [];

  function track(child: ChildProcess): ChildProcess {
    children.push(child);
    return child;
  }

  const scenario: Scenario = {
    root,
    dataDir,
    logDir,
    ambientLogDir,

    async startFakeHub(options) {
      const child = track(
        spawn(process.execPath, [FAKE_HUB], {
          // stderr is inherited so a fixture that dies of its own accident says
          // why instead of failing the scenario with a bare timeout.
          stdio: ["ignore", "ignore", "inherit"],
          env: {
            ...process.env,
            FAKE_HUB_MODE: options.mode,
            FAKE_HUB_LOG_DIR: options.logDir ?? ambientLogDir,
            CO_CANVAS_PORT: String(options.port),
            CO_CANVAS_DATA_DIR: options.dataDir ?? dataDir,
            FAKE_HUB_BIND_DELAY_MS: String(options.bindDelayMs ?? 0),
          },
        }),
      );
      if (options.awaitListening !== false) {
        await waitFor(
          () => isListening(options.port),
          `fake hub (${options.mode}) never listened on ${options.port}`,
        );
      }
      return child;
    },

    async startSleeper() {
      const child = track(spawn(process.execPath, [SLEEPER], { stdio: "ignore" }));
      await waitFor(() => child.pid !== undefined && isAlive(child.pid), "sleeper never came up");
      return child;
    },

    async deadPid() {
      const child = await scenario.startSleeper();
      const pid = pidOf(child);
      // Waiting for `exit` matters: until this process reaps the child it stays
      // a zombie, and a zombie still answers `kill(pid, 0)`.
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
      await waitFor(() => !isAlive(pid), `pid ${pid} never died`);
      return pid;
    },

    runCaller(options) {
      const child = track(
        spawn(process.execPath, [CALLER], {
          stdio: ["ignore", "pipe", "inherit"],
          env: {
            ...process.env,
            CO_CANVAS_PORT: String(options.port),
            CO_CANVAS_DATA_DIR: options.dataDir,
            FAKE_HUB_MODE: options.mode ?? "healthy",
            FAKE_HUB_LOG_DIR: options.logDir ?? logDir,
          },
        }),
      );
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout: stdout.trim() }));
      });
    },

    spawnedPids: () => readPids(join(logDir, "spawned.log")),
    boundPids: () => readPids(join(logDir, "bound.log")),
    spawnedLogPath: () => join(logDir, "spawned.log"),

    async cleanup() {
      // Hubs the client started are detached: no handle here holds them, so the
      // logs are the only record of what has to be reaped.
      const started = [...(await scenario.spawnedPids()), ...(await scenario.boundPids())];
      const pids = new Set<number>(started);
      for (const child of children) if (child.pid !== undefined) pids.add(child.pid);

      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone, which is the usual case for the race losers.
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };

  return scenario;
}
