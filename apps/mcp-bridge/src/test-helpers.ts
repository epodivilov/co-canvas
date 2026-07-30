/**
 * One scenario's world: a temporary data directory, an in-process hub, the
 * fixture commands, and a record of everything that has to be torn down.
 *
 * Nothing here reads ambient configuration. Every hub runs on a port the OS
 * handed out, every data directory is temporary, and every command the bridge
 * might spawn points at a fixture — a scenario that accidentally reached the
 * developer's real hub on port 4321 would be decided by their machine.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket, Server as SocketServer } from "node:net";
import { connect as connectSocket, createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hub } from "@co-canvas/hub";
import { createHub } from "@co-canvas/hub";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import type { CommandSpec } from "./command.ts";
import type { BridgeOptions } from "./server.ts";
import { createBridge } from "./server.ts";

export const FIXTURE_HUB = fileURLToPath(new URL("./__fixtures__/hub.mjs", import.meta.url));
export const FIXTURE_OPENER_RECORD = fileURLToPath(
  new URL("./__fixtures__/opener-record.mjs", import.meta.url),
);
export const FIXTURE_OPENER_STDOUT = fileURLToPath(
  new URL("./__fixtures__/opener-stdout.mjs", import.meta.url),
);
/** The bridge's entry point, for the scenarios that run it as a real process. */
export const ENTRY_POINT = fileURLToPath(new URL("./main.ts", import.meta.url));

/** Environment variable the recording opener fixture reports through. */
export const OPENER_LOG_ENV = "CO_CANVAS_TEST_OPENER_LOG";

export interface HubHandle {
  readonly url: string;
  readonly port: number;
}

export interface RoomPeer {
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;
  close(): void;
}

export interface BridgeClient {
  readonly client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** What `/__rooms` reports, read back over HTTP rather than through the bridge. */
export interface HubRoomReport {
  slug: string;
  peers: number;
  docBytes: number;
}

export interface Harness {
  readonly root: string;
  /** Data directory for hubs and for the hub lockfile. Never `~/.co-canvas`. */
  readonly dataDir: string;
  /** File the recording opener appends to; also the value of `OPENER_LOG_ENV`. */
  readonly openerLog: string;
  /** Where the fixture hub records the pid of a hub the bridge started. */
  readonly hubPidFile: string;
  /** Starts a hub in this process on an OS-assigned port. */
  startHub(): Promise<HubHandle>;
  /** Holds a port with a plain HTTP server that is not a co-canvas hub. */
  occupyPort(): Promise<number>;
  /**
   * A front door for the hub on `targetPort` that holds every byte travelling
   * towards it for `lagMs`.
   *
   * It turns "the bridge answered before its socket reached the hub" from a
   * race the scheduler usually loses into a certainty: everything the bridge
   * says arrives at the real hub `lagMs` late, while the scenario reads the
   * hub's own listing directly and immediately.
   *
   * Per byte rather than per connection, because `undici` pools its sockets:
   * a WebSocket upgrade goes out over the connection an earlier `fetch` left
   * behind, so a proxy that only delayed the dial would let it through at once.
   *
   * Only the client-to-hub direction lags, so a round trip costs `lagMs` rather
   * than twice it and the health probe stays inside hub-client's budget.
   */
  startLaggingProxy(targetPort: number, lagMs: number): Promise<HubHandle>;
  /** Connects an MCP client to a bridge over a linked in-memory transport. */
  connect(overrides?: Partial<BridgeOptions>): Promise<BridgeClient>;
  /** A `y-websocket` peer of `slug`, synced before it is handed back. */
  openPeer(hubUrl: string, slug: string): Promise<RoomPeer>;
  /** Command spec for the fixture hub, told to bind `port`. */
  fixtureHubCommand(port: number): CommandSpec;
  /** Argument lists the recording opener has been handed, oldest first. */
  openerCalls(): Promise<string[][]>;
  /** URLs the recording opener has been handed, oldest first. */
  openedUrls(): Promise<string[]>;
  /** Pids the fixture hub recorded; empty when nothing was ever spawned. */
  startedHubPids(): Promise<number[]>;
  /** Tracks a child so it is killed even if the scenario fails. */
  track(child: ChildProcess): ChildProcess;
  /** Registers something to shut down first, before anything else is torn down. */
  defer(close: () => Promise<void>): void;
  cleanup(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "co-canvas-mcp-bridge-"));
  const dataDir = join(root, "data");
  const openerLog = join(root, "opened.log");
  const hubPidFile = join(root, "started-hubs.log");

  const hubs: Hub[] = [];
  const peers: RoomPeer[] = [];
  const bridges: BridgeClient[] = [];
  const children: ChildProcess[] = [];
  const servers: Server[] = [];
  const proxies: SocketServer[] = [];
  const sockets: Socket[] = [];
  const closers: (() => Promise<void>)[] = [];

  const previousOpenerLog = process.env[OPENER_LOG_ENV];
  process.env[OPENER_LOG_ENV] = openerLog;

  /**
   * The default start command: a path that cannot be executed, so a bridge that
   * spawns a hub when the scenario did not expect one fails loudly instead of
   * quietly succeeding against a second hub.
   */
  const neverStart: CommandSpec = { executable: join(root, "no-hub-expected"), args: [] };

  const harness: Harness = {
    root,
    dataDir,
    openerLog,
    hubPidFile,

    async startHub() {
      const hub = createHub({ port: 0, dataDir });
      hubs.push(hub);
      const url = await hub.start();
      return { url, port: Number(new URL(url).port) };
    },

    async occupyPort() {
      // Answers, but never as a co-canvas hub — the shape `findHub` reports as
      // `port-occupied` rather than as "nothing is running".
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("this is not a co-canvas hub");
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return (server.address() as AddressInfo).port;
    },

    async startLaggingProxy(targetPort, lagMs) {
      const proxy = createSocketServer((client) => {
        const upstream = connectSocket({ port: targetPort, host: "127.0.0.1" });
        sockets.push(client, upstream);

        client.on("data", (chunk: Buffer) => {
          setTimeout(() => {
            if (!upstream.destroyed) upstream.write(chunk);
          }, lagMs);
        });
        upstream.on("data", (chunk: Buffer) => {
          if (!client.destroyed) client.write(chunk);
        });

        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        // Long enough for whatever is still in flight to land upstream.
        client.on("close", () => setTimeout(() => upstream.destroy(), lagMs * 2));
        upstream.on("close", () => client.destroy());
      });
      proxies.push(proxy);
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const { port } = proxy.address() as AddressInfo;
      return { url: `http://127.0.0.1:${port}`, port };
    },

    async connect(overrides = {}) {
      const bridge = createBridge({
        hubDataDir: dataDir,
        hubCommand: () => neverStart,
        openCommand: { executable: process.execPath, args: [FIXTURE_OPENER_RECORD] },
        ...overrides,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "cc-15-scenario", version: "0.0.0" });
      await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

      const handle: BridgeClient = {
        client,
        async call(name, args = {}) {
          return (await client.callTool({ name, arguments: args })) as CallToolResult;
        },
        async close() {
          await client.close();
          await bridge.close();
        },
      };
      bridges.push(handle);
      return handle;
    },

    async openPeer(hubUrl, slug) {
      const doc = new Y.Doc();
      // `disableBc` for the same reason the bridge sets it: Node has a global
      // `BroadcastChannel`, and two providers for one slug in one process would
      // sync through it and agree with each other over a dead socket.
      const provider = new WebsocketProvider(syncServerUrl(hubUrl), slug, doc, {
        disableBc: true,
      });
      const peer: RoomPeer = {
        doc,
        provider,
        close() {
          provider.destroy();
          // Destroying the doc destroys the awareness the provider built on it,
          // which is the only thing that clears its keepalive interval.
          doc.destroy();
        },
      };
      peers.push(peer);
      await whenSynced(provider);
      return peer;
    },

    fixtureHubCommand(port) {
      return { executable: process.execPath, args: [FIXTURE_HUB, String(port), hubPidFile] };
    },

    async openerCalls() {
      const lines = await readLines(openerLog);
      return lines.map((line) => JSON.parse(line) as string[]);
    },

    async openedUrls() {
      const calls = await harness.openerCalls();
      return calls.map((args) => args.at(-1) ?? "");
    },

    async startedHubPids() {
      return (await readLines(hubPidFile)).map(Number);
    },

    track(child) {
      children.push(child);
      return child;
    },

    defer(close) {
      closers.push(close);
    },

    async cleanup() {
      for (const close of closers) await close().catch(() => {});
      for (const peer of peers) peer.close();
      for (const bridge of bridges) await bridge.close().catch(() => {});
      for (const hub of hubs) await hub.stop().catch(() => {});
      for (const socket of sockets) socket.destroy();
      for (const proxy of proxies) proxy.close();
      for (const server of servers) server.close();
      for (const child of children) child.kill("SIGKILL");
      // Hubs the bridge started are detached: no handle here holds them, so the
      // pid file is the only record of what has to be reaped.
      for (const pid of await harness.startedHubPids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      if (previousOpenerLog === undefined) delete process.env[OPENER_LOG_ENV];
      else process.env[OPENER_LOG_ENV] = previousOpenerLog;
      await rm(root, { recursive: true, force: true });
    },
  };

  return harness;
}

/**
 * A port nothing is listening on right now.
 *
 * Never `DEFAULT_PORT`: a hub a developer left running would otherwise decide
 * the outcome of every hub-acquisition scenario.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * The bridge entry point running as a real child process with a real MCP client
 * attached over stdio, so the whole framing is exercised end to end.
 */
export async function connectBridgeProcess(
  harness: Harness,
  env: Record<string, string>,
): Promise<BridgeClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY_POINT],
    env: { ...inheritedEnv(), HOME: harness.root, ...env },
    stderr: "inherit",
  });
  const client = new Client({ name: "cc-15-stdio", version: "0.0.0" });
  await client.connect(transport);

  const handle: BridgeClient = {
    client,
    async call(name, args = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    close: () => client.close(),
  };
  harness.defer(() => handle.close());
  return handle;
}

/** Reads the hub's own room listing, without going through the bridge. */
export async function hubRooms(hubUrl: string): Promise<HubRoomReport[]> {
  const response = await fetch(`${hubUrl}/__rooms`);
  const body = (await response.json()) as { rooms: HubRoomReport[] };
  return body.rooms;
}

/** Peers the hub reports for `slug`; `0` when it holds no such room. */
export async function hubPeers(hubUrl: string, slug: string): Promise<number> {
  const rooms = await hubRooms(hubUrl);
  return rooms.find((room) => room.slug === slug)?.peers ?? 0;
}

/** The `service` field of the hub's health endpoint, or `null` when nothing answers. */
export async function hubHealth(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await response.json()) as { service?: string };
    return body.service ?? null;
  } catch {
    return null;
  }
}

/** All the text a tool result carries, joined — the summary a text-only harness shows. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
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
    await settle(20);
  }
}

/** Lets pending I/O drain — only for asserting that something did *not* happen. */
export function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syncServerUrl(hubUrl: string): string {
  return `${hubUrl.replace(/^http/, "ws")}/sync`;
}

function whenSynced(provider: WebsocketProvider): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off("sync", onSync);
      reject(new Error("peer never synced"));
    }, 5000);
    function onSync(state: boolean): void {
      if (!state) return;
      clearTimeout(timer);
      provider.off("sync", onSync);
      resolve();
    }
    provider.on("sync", onSync);
  });
}

async function readLines(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.trim() !== "");
}

/**
 * The bridge entry point running as a real child process, driven by hand over
 * newline-delimited JSON-RPC.
 *
 * Hand-rolled rather than driven through `StdioClientTransport` because the
 * transport owns the child it spawned and closing it signals the process —
 * which is exactly what R7's "exits on its own, without being signalled" must
 * not do. Parsing every stdout line as JSON is also the strictest possible
 * reading of "stdout carries MCP protocol messages and nothing else".
 */
/** As much of a JSON-RPC response as these scenarios look at. */
export interface RpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

export interface RawBridgeProcess {
  readonly child: ChildProcess;
  initialize(): Promise<void>;
  request(method: string, params: unknown): Promise<RpcResponse>;
  /**
   * Lines the child wrote on stdout that are not JSON.
   *
   * The SDK's own client skips a line it cannot parse and carries on, so a
   * polluted stream would go unnoticed by a scenario that only checked whether
   * the next response arrived. This is the assertion that does not.
   */
  stdoutViolations(): string[];
  closeStdin(): void;
  whenExited(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnBridgeProcess(
  harness: Harness,
  env: Record<string, string>,
): RawBridgeProcess {
  const child = harness.track(
    spawn(process.execPath, [ENTRY_POINT], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...inheritedEnv(),
        // A private home, so `@co-canvas/hub-client` looks for its lockfile in
        // this scenario's directory rather than in the developer's.
        HOME: harness.root,
        ...env,
      },
    }),
  );

  const pending = new Map<number, (message: RpcResponse) => void>();
  const violations: string[] = [];
  let buffer = "";
  let failure: Error | null = null;

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") deliver(line);
      newline = buffer.indexOf("\n");
    }
  });

  function deliver(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      violations.push(line);
      failure ??= new Error(`stdout carried something that is not a JSON-RPC message: ${line}`);
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    pending.get(id)?.(message);
    pending.delete(id);
  }

  let nextId = 0;

  function send(payload: Record<string, unknown>): void {
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  const api: RawBridgeProcess = {
    child,

    async initialize() {
      await api.request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "cc-15-raw", version: "0.0.0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },

    request(method, params) {
      nextId += 1;
      const id = nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(failure?.message ?? `no response to ${method} within 15000ms`));
        }, 15_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          if (failure !== null) reject(failure);
          else resolve(message);
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },

    stdoutViolations: () => [...violations],

    closeStdin() {
      child.stdin?.end();
    },

    whenExited(timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`the bridge did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
    },
  };

  return api;
}

/** `process.env` with the holes `undefined` values would punch in it removed. */
export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The JSON array form both command environment variables take. */
export function commandEnvValue(command: CommandSpec): string {
  return JSON.stringify([command.executable, ...command.args]);
}
