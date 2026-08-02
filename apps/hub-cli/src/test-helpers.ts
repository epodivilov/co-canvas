import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

/** The CLI's Node entry point, run under type stripping exactly as the `dev` script does. */
export const cliEntry = fileURLToPath(new URL("./main.ts", import.meta.url));

export interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunningCli {
  readonly child: ChildProcess;
  readonly pid: number;
  /** Everything the process has written to stderr so far. */
  stderr(): string;
  /** Everything the process has written to stdout so far. */
  stdout(): string;
  /** Resolves when the process exits, with its code and signal. */
  waitExit(timeoutMs?: number): Promise<ExitResult>;
}

export interface SpawnCliOptions {
  env?: Record<string, string>;
  /** `"ignore"` discards stdout and stderr, exactly as `findOrStartHub` spawns the hub. */
  discardOutput?: boolean;
}

/** Spawns the CLI as its own process, so signals, the lockfile and the log are exercised for real. */
export function spawnCli(args: readonly string[], options: SpawnCliOptions = {}): RunningCli {
  const child = spawn(process.execPath, ["--experimental-strip-types", cliEntry, ...args], {
    stdio: options.discardOutput ? "ignore" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });

  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  return {
    child,
    pid: child.pid as number,
    stderr: () => stderr,
    stdout: () => stdout,
    waitExit(timeoutMs = 8000): Promise<ExitResult> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`process ${child.pid} did not exit in ${timeoutMs}ms`)),
          timeoutMs,
        );
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
    },
  };
}

/** Tracks spawned processes so a test can tear every one down, even on failure. */
export function createCliPool() {
  const running = new Set<RunningCli>();
  return {
    spawn(args: readonly string[], options?: SpawnCliOptions): RunningCli {
      const cli = spawnCli(args, options);
      running.add(cli);
      return cli;
    },
    async stopAll(): Promise<void> {
      for (const cli of [...running]) {
        running.delete(cli);
        if (cli.child.exitCode === null && cli.child.signalCode === null) {
          try {
            cli.child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },
  };
}

/** Hands out throwaway data directories and removes them afterwards. */
export function createDataDirPool() {
  const dirs: string[] = [];
  return {
    async create(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "co-canvas-cli-"));
      dirs.push(dir);
      return dir;
    },
    /** A path under the temp root that does not exist yet, for the "must stay absent" cases. */
    async reserve(): Promise<string> {
      const parent = await mkdtemp(join(tmpdir(), "co-canvas-cli-"));
      dirs.push(parent);
      return join(parent, "data");
    },
    async removeAll(): Promise<void> {
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface HubLockFile {
  pid: number;
  port: number;
  protocol: number;
  startedAt: string;
}

export async function readLock(dataDir: string): Promise<HubLockFile> {
  return JSON.parse(await readFile(join(dataDir, "hub.lock"), "utf8")) as HubLockFile;
}

export async function readLog(dataDir: string): Promise<string> {
  return await readFile(join(dataDir, "hub.log"), "utf8");
}

/** The log so far, or `""` when it does not exist yet — for polling on a line to appear. */
export async function logText(dataDir: string): Promise<string> {
  try {
    return await readFile(join(dataDir, "hub.log"), "utf8");
  } catch {
    return "";
  }
}

/** Asks the OS for a free port, gives it straight back and reports which one it was. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error("no port")) : resolve(port)));
    });
  });
}

/** Occupies a port and holds it until closed, so the CLI meets a foreign listener. */
export async function occupyPort(port: number): Promise<() => Promise<void>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

async function liveRooms(
  port: number,
): Promise<{ slug: string; peers: number; docBytes: number }[]> {
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/__rooms", method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.end();
  });
  return (JSON.parse(body) as { rooms: { slug: string; peers: number; docBytes: number }[] }).rooms;
}

/** Size of a live room's document as `/__rooms` reports it, or `0` when the hub is not holding it. */
export async function roomDocBytes(port: number, slug: string): Promise<number> {
  return (await liveRooms(port)).find((room) => room.slug === slug)?.docBytes ?? 0;
}

/** Total peers the hub reports across every room — the same count idle shutdown watches. */
export async function peerCount(port: number): Promise<number> {
  return (await liveRooms(port)).reduce((sum, room) => sum + room.peers, 0);
}

/**
 * Holds a bare WebSocket open against a room, the way an open browser tab does.
 *
 * Deliberately a raw socket rather than a `y-websocket` client: it does nothing
 * once connected and so cannot reconnect, ping or drop under load, which is what
 * makes it a stable stand-in for "a peer is present" in the idle-timing tests.
 */
export async function openRawPeer(port: number, slug: string): Promise<{ close(): void }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/sync/${slug}`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("peer socket error")));
  });
  return { close: () => socket.close() };
}

/** Whether a co-canvas hub answers `/health` on `port`. */
export function isHealthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ hostname: "127.0.0.1", port, path: "/health", method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { service?: string };
          resolve(res.statusCode === 200 && body.service === "co-canvas-hub");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Resolves once `predicate` holds, throws when it never does. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 6000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await settle(25);
  }
}

export function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the CLI has fully come up: the lockfile is written last in the
 * startup sequence and its signal handlers are armed on the same synchronous
 * turn, so its presence is the honest "ready" signal — `/health` answers a
 * moment earlier, before either exists.
 */
export async function waitForReady(dataDir: string): Promise<number> {
  return waitForLockPort(dataDir);
}

/** Waits until the CLI's lockfile appears and reports the port it recorded. */
export async function waitForLockPort(dataDir: string): Promise<number> {
  let port = 0;
  await waitFor(async () => {
    try {
      port = (await readLock(dataDir)).port;
      return true;
    } catch {
      return false;
    }
  });
  return port;
}

export interface Client {
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;
  close(): void;
}

/** Opens `y-websocket` peers against a running CLI and tears them all down at once. */
export function createClientPool() {
  const clients = new Set<Client>();
  return {
    open(port: number, room: string): Client {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/sync`, room, doc, {
        disableBc: true,
      });
      const client: Client = {
        doc,
        provider,
        close() {
          clients.delete(client);
          provider.destroy();
          doc.destroy();
        },
      };
      clients.add(client);
      return client;
    },
    closeAll(): void {
      for (const client of [...clients]) client.close();
    },
  };
}
