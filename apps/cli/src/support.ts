/**
 * Shared plumbing for the `co-canvas` package's own tests.
 *
 * Everything here drives the package the way a harness would: the built `bin`
 * as a child process spoken to over stdio, and — for the packed-tarball gate —
 * an install of `npm pack`'s output into a directory that holds none of this
 * repo. Nothing imports the dispatcher or the bridge as source: the whole point
 * is to exercise the artifacts a publish would ship.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

/** The room tools every entry point must expose, in the order assertions read them. */
export const ROOM_TOOLS = [
  "add_elements",
  "create_room",
  "delete_elements",
  "describe_scene",
  "get_selection",
  "list_rooms",
  "open_room",
  "update_elements",
] as const;

/** This package's directory, resolved from the file rather than the CWD vitest runs in. */
export const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The built dispatcher, with a message a person can act on when it is missing. */
export function builtCliEntry(): string {
  const entry = join(CLI_DIR, "dist", "main.js");
  if (!existsSync(entry)) {
    throw new Error(
      `${entry} does not exist — run \`pnpm build\` before the co-canvas package tests`,
    );
  }
  return entry;
}

/**
 * `process.env` for a spawned child, with the holes `undefined` values would
 * punch in it removed — and `NODE_PATH` stripped.
 *
 * vitest injects `NODE_PATH` pointing at this repo's pnpm store. A `co-canvas`
 * child that kept it would resolve `@co-canvas/*` up that path, so the packed
 * package's own self-contained hub — the thing R2/R4 exist to pin — would never
 * be exercised and a regression to workspace resolution would pass unnoticed. A
 * real install has no `NODE_PATH`; neither may these children.
 */
export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NODE_PATH;
  return env;
}

/** A port nothing is listening on right now. Never the protocol's default. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion with no stdin, capturing both streams and the exit code. */
export function runToCompletion(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...inheritedEnv(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export interface StdoutCapture {
  /** Every non-blank line the process wrote on stdout. */
  lines: string[];
  /** Those that are not a JSON-RPC 2.0 message — a polluted stream if non-empty. */
  nonJson: string[];
  /** Tool names from the `tools/list` response, or `[]` if it never answered. */
  tools: string[];
}

/**
 * Drives the MCP handshake over a child's stdio at the wire level and returns
 * everything it wrote on stdout.
 *
 * Raw rather than through the SDK client: the SDK skips a stdout line it cannot
 * parse and carries on, so a banner leaking into the stream would go unnoticed
 * by a scenario that only checked whether the next response arrived. This is the
 * check that does not.
 */
export async function captureMcpStdout(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<StdoutCapture> {
  const child = spawn(command, args, {
    env: { ...inheritedEnv(), ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines: string[] = [];
  const seen = new Set<number>();
  let tools: string[] = [];
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") {
        lines.push(line);
        const message = tryJson(line);
        if (message !== undefined && typeof message.id === "number") {
          seen.add(message.id);
          const result = message.result as { tools?: { name: string }[] } | undefined;
          if (message.id === 2 && result?.tools !== undefined) {
            tools = result.tools.map((tool) => tool.name).sort();
          }
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  const send = (payload: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cc-6-raw", version: "0.0.0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  try {
    await waitFor(
      () => seen.has(1) && seen.has(2),
      15_000,
      "the handshake and tools/list to answer",
    );
  } finally {
    child.stdin.end();
    await whenClosed(child);
  }

  const nonJson = lines.filter((line) => tryJson(line) === undefined);
  return { lines, nonJson, tools };
}

export interface McpSession {
  readonly client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * Connects a real MCP client to a child process over stdio.
 *
 * `cwd` is worth setting to a directory outside this repo when the child is the
 * installed package: it stops Node walking up the monorepo tree to resolve a
 * module the clean install must not have.
 */
export async function connectMcp(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    env: { ...inheritedEnv(), ...env },
    stderr: "inherit",
    ...(cwd === undefined ? {} : { cwd }),
  });
  const client = new Client({ name: "cc-6-client", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async call(name, callArgs = {}) {
      return (await client.callTool({ name, arguments: callArgs })) as CallToolResult;
    },
    async listTools() {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    },
    close: () => client.close(),
  };
}

/** All the text a tool result carries. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Kills a hub the bridge spawned, read from the lockfile it left in `home`.
 *
 * The bridge starts the bundled hub detached, so nothing here holds a handle to
 * it; the lockfile hub-client writes under `~/.co-canvas` carries the pid, which
 * is the only record a test has to reap it by.
 */
export function killHubFromLock(home: string): void {
  const lock = join(home, ".co-canvas", "hub.lock");
  if (!existsSync(lock)) return;
  try {
    const { pid } = JSON.parse(readFileSync(lock, "utf8")) as { pid?: number };
    if (typeof pid === "number") process.kill(pid, "SIGTERM");
  } catch {
    // Already gone, or never a pid we could read.
  }
}

/** Resolves when `predicate` holds, polling until `timeoutMs` elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function whenClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });
}

function tryJson(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value !== null && typeof value === "object" && value.jsonrpc === "2.0") return value;
    return undefined;
  } catch {
    return undefined;
  }
}
