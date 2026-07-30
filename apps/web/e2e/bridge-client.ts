import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

/**
 * The MCP bridge as the harness that ships it would run it: the built bundle,
 * spawned as a child process, spoken to over stdio.
 *
 * Nothing here imports the bridge's source. Playwright transpiles but does not
 * bundle, and `@excalidraw/excalidraw` cannot be loaded by Node's own resolver
 * at all — so the only way these scenarios can reach the conversion path is
 * through the bundle `pnpm build` produces.
 */
export interface BridgeClient {
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** Path of the built bridge, with a message a person can act on when it is missing. */
export function builtBridgeEntry(): string {
  const entry = createRequire(import.meta.url).resolve("@co-canvas/mcp-bridge/dist/main.js");
  if (!existsSync(entry)) {
    throw new Error(`${entry} does not exist — run \`pnpm build\` before \`pnpm test:e2e\``);
  }
  return entry;
}

/** Spawns the built bridge, pointed at `hubPort` and at a home of its own. */
export async function startBridge(hubPort: number): Promise<BridgeClient> {
  // A private home, so `@co-canvas/hub-client` looks for its lockfile here
  // rather than in the developer's `~/.co-canvas`.
  const home = await mkdtemp(join(tmpdir(), "co-canvas-e2e-bridge-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtBridgeEntry()],
    env: {
      ...env,
      HOME: home,
      CO_CANVAS_HUB_PORT: String(hubPort),
      // Nothing here opens a browser; a command that cannot run makes an
      // accidental `open_room` fail loudly instead of launching one.
      CO_CANVAS_OPEN_CMD: JSON.stringify([join(home, "no-opener-expected")]),
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "cc-16-e2e", version: "0.0.0" });
  await client.connect(transport);

  return {
    async call(name, args) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async close() {
      await client.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** A plain Yjs reader of a room, for asserting on what is actually stored. */
export interface RoomObserver {
  scene(): Record<string, unknown>[];
  close(): void;
}

export async function observeRoom(hubUrl: string, slug: string): Promise<RoomObserver> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(
    `${hubUrl.replace(/^http/, "ws")}/sync`,
    slug,
    doc,
    // Node has a global `BroadcastChannel`; two providers for one slug in one
    // process would agree with each other over a dead socket.
    { disableBc: true, WebSocketPolyfill: WebSocket },
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("observer never synced")), 15_000);
    provider.once("sync", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return {
    scene() {
      return doc
        .getArray<Y.Map<unknown>>("elements")
        .toArray()
        .map((entry) => ({
          pos: String(entry.get("pos")),
          el: entry.get("el") as Record<string, unknown>,
        }))
        .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0))
        .map((entry) => entry.el);
    },
    close() {
      provider.destroy();
      doc.destroy();
    },
  };
}

/** All the text a tool result carries. */
export function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
