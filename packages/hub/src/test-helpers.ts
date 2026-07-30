import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import type { Awareness } from "y-protocols/awareness";
import { encodeAwarenessUpdate } from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

/** Response of a raw GET, kept as bytes so binary assets can be compared exactly. */
export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Issues a GET with `path` handed to the socket verbatim.
 *
 * `fetch()` and `http.request(url)` both run the target through the WHATWG URL
 * parser, which collapses `..` segments before anything leaves the process —
 * a traversal attempt would never reach the hub and the test would pass against
 * a server with no guard at all.
 */
export function rawGet(baseUrl: string, path: string): Promise<RawResponse> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Convenience wrapper for the hub's JSON endpoints. */
export async function getJson(baseUrl: string, path: string): Promise<unknown> {
  const response = await rawGet(baseUrl, path);
  return JSON.parse(response.body.toString("utf8"));
}

/** Resolves once `predicate` holds, throws when it never does. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await settle(10);
  }
}

/** Lets pending I/O drain — only for asserting that something did *not* happen. */
export function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns the hub's base URL into the WebSocket server URL its clients connect to. */
export function syncUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/sync`;
}

export interface Client {
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;
  close(): void;
}

/**
 * Tracks the providers a test opened so they can all be torn down at once —
 * a leaked provider keeps timers alive and hangs the runner.
 */
export function createClientPool() {
  const clients = new Set<Client>();

  return {
    /**
     * Opens a `y-websocket` client against the hub.
     *
     * `disableBc` is not optional: Node has a global `BroadcastChannel`, so two
     * providers in the same process would sync through it and every sync test
     * would pass against a hub that silently discards all traffic.
     */
    open(baseUrl: string, room: string, params?: Record<string, string>): Client {
      const doc = new Y.Doc();
      const options =
        params === undefined ? { disableBc: true } : { disableBc: true, params: { ...params } };
      const provider = new WebsocketProvider(syncUrl(baseUrl), room, doc, options);
      const client: Client = {
        doc,
        provider,
        close() {
          clients.delete(client);
          provider.destroy();
          // Destroying the doc also destroys the awareness the provider built on
          // it, which is the only thing that clears that awareness's keepalive
          // interval. Without it a finished client leaves a timer behind and any
          // measurement of what the hub itself still holds is noise.
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

export type UpgradeOutcome =
  | { kind: "handshake-failed" }
  | { kind: "closed"; code: number }
  | { kind: "open" };

/**
 * Connects a bare WebSocket and reports how the hub answered: a refused
 * handshake and a completed handshake followed by a close frame are different
 * outcomes, and the routing rules distinguish them.
 */
export function upgradeOutcome(baseUrl: string, path: string): Promise<UpgradeOutcome> {
  const target = `${baseUrl.replace(/^http/, "ws")}${path}`;
  return new Promise((resolve) => {
    const socket = new WebSocket(target);
    let opened = false;
    socket.on("open", () => {
      opened = true;
    });
    socket.on("error", () => {
      if (!opened) resolve({ kind: "handshake-failed" });
    });
    socket.on("close", (code: number) => {
      resolve(opened ? { kind: "closed", code } : { kind: "handshake-failed" });
    });
  });
}

export interface RawClient {
  readonly socket: WebSocket;
  /** Frames received so far, oldest first. */
  readonly frames: Uint8Array[];
  send(message: Uint8Array): void;
  /** Forgets everything received so far, so a later assertion starts clean. */
  clear(): void;
  close(): void;
}

/**
 * A WebSocket that says nothing on its own, so a test can drive the wire format
 * by hand and see exactly which frames the hub sends back — something the
 * `y-websocket` provider hides behind its own handshake.
 */
export async function openRawClient(baseUrl: string, path: string): Promise<RawClient> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${path}`);
  const frames: Uint8Array[] = [];
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    frames.push(toBytes(data));
  });
  // `ws` throws on an 'error' event with no listener, so one is always attached.
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    socket,
    frames,
    send: (message) => socket.send(message),
    clear: () => {
      frames.length = 0;
    },
    close: () => socket.close(),
  };
}

/** The hub's outer framing, which the raw-socket scenarios speak by hand. */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Wraps a `y-protocols/sync` payload in the hub's outer message framing. */
export function syncFrame(writePayload: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  writePayload(encoder);
  return encoding.toUint8Array(encoder);
}

/** Wraps a peer's current awareness state in the hub's outer message framing. */
export function awarenessFrame(awareness: Awareness): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [awareness.clientID]));
  return encoding.toUint8Array(encoder);
}

/** Counts the timers currently keeping this process's event loop alive. */
export function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

/**
 * Hands out throwaway data directories and removes them afterwards.
 *
 * Every hub in the suite needs one: without an explicit `dataDir` a hub falls
 * back to `~/.co-canvas`, so running the tests would write into the developer's
 * real home directory and collide with a hub they actually use.
 */
export function createDataDirPool() {
  const dirs: string[] = [];

  return {
    async create(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "co-canvas-hub-"));
      dirs.push(dir);
      return dir;
    },
    async removeAll(): Promise<void> {
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Asks the OS for a port, gives it straight back and reports which one it was. */
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

// The on-disk log format, decoded here independently of the code under test so
// that a bug in the codec cannot make its own tests pass. Kept in sync with the
// layout the spec fixes: `CCLOG`, a version byte, a big-endian u64 creation
// timestamp, then big-endian u32 length-prefixed Yjs updates.
export const LOG_MAGIC = "CCLOG";
export const LOG_HEADER_BYTES = 14;

export interface DecodedLog {
  magic: string;
  version: number;
  createdAt: number;
  frames: Buffer[];
  /** Bytes after the last complete frame — a torn tail, if the file has one. */
  trailing: number;
  bytes: number;
}

export function decodeLog(bytes: Buffer): DecodedLog {
  if (bytes.length < LOG_HEADER_BYTES) throw new Error(`log too short: ${bytes.length} bytes`);
  const frames: Buffer[] = [];
  let offset = LOG_HEADER_BYTES;
  for (;;) {
    if (offset + 4 > bytes.length) break;
    const length = bytes.readUInt32BE(offset);
    if (offset + 4 + length > bytes.length) break;
    frames.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return {
    magic: bytes.subarray(0, 5).toString("ascii"),
    version: bytes.readUInt8(5),
    createdAt: Number(bytes.readBigUInt64BE(6)),
    frames,
    trailing: bytes.length - offset,
    bytes: bytes.length,
  };
}

/** Builds a log file's bytes, so a scenario can put damaged input on disk. */
export function encodeLog(createdAt: number, frames: readonly Uint8Array[]): Buffer {
  const header = Buffer.alloc(LOG_HEADER_BYTES);
  header.write(LOG_MAGIC, 0, "ascii");
  header.writeUInt8(1, 5);
  header.writeBigUInt64BE(BigInt(createdAt), 6);
  const parts = [header];
  for (const frame of frames) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(frame.byteLength, 0);
    parts.push(prefix, Buffer.from(frame));
  }
  return Buffer.concat(parts);
}

export function logPath(dataDir: string, slug: string): string {
  return join(dataDir, "rooms", `${slug}.log`);
}

export async function readLog(dataDir: string, slug: string): Promise<DecodedLog> {
  return decodeLog(await readFile(logPath(dataDir, slug)));
}

/** The `board` map a log's frames add up to, as a plain object. */
export function logBoard(log: DecodedLog): Record<string, unknown> {
  const doc = new Y.Doc();
  try {
    for (const frame of log.frames) Y.applyUpdate(doc, frame);
    return doc.getMap("board").toJSON();
  } finally {
    doc.destroy();
  }
}

export interface IndexEntry {
  slug: string;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

export function indexPath(dataDir: string): string {
  return join(dataDir, "rooms.json");
}

/** Reads `rooms.json` as the overview UI eventually will. */
export async function readIndex(dataDir: string): Promise<IndexEntry[]> {
  const parsed: unknown = JSON.parse(await readFile(indexPath(dataDir), "utf8"));
  const rooms = (parsed as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) throw new Error(`rooms.json holds no room list: ${String(rooms)}`);
  return rooms as IndexEntry[];
}

interface LiveRoom {
  slug: string;
  peers: number;
  docBytes: number;
}

/** What `/__rooms` reports, i.e. the rooms the hub is holding in memory. */
export async function liveRooms(baseUrl: string): Promise<LiveRoom[]> {
  const body = (await getJson(baseUrl, "/__rooms")) as { rooms: LiveRoom[] };
  return body.rooms;
}

/** Size of a live room's document, or `0` when the hub is not holding it. */
export async function roomDocBytes(baseUrl: string, slug: string): Promise<number> {
  return (await liveRooms(baseUrl)).find((room) => room.slug === slug)?.docBytes ?? 0;
}

/** Records the update events a sequence of edits produces, one entry per edit. */
export function recordUpdates(edits: readonly ((doc: Y.Doc) => void)[]): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  const collect = (update: Uint8Array) => updates.push(update);
  doc.on("update", collect);
  try {
    for (const edit of edits) edit(doc);
    return updates;
  } finally {
    doc.off("update", collect);
    doc.destroy();
  }
}

/** Normalises whatever `ws` hands to a `message` listener into plain bytes. */
export function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
