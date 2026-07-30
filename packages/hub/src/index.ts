import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HubHealth } from "@co-canvas/protocol";
import {
  DATA_DIR_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  HUB_SERVICE_ID,
  isRoomSlug,
  PROTOCOL_VERSION,
} from "@co-canvas/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { createPersistence } from "./persistence";
import { UnsupportedLogVersionError } from "./room-log";
import { createRoomRegistry } from "./rooms";
import { createStaticHandler } from "./static-files";
import { attachConnection } from "./sync";

/** WebSocket paths under this prefix address a room. Nothing else upgrades. */
const SYNC_PREFIX = "/sync/";
/** RFC 6455 policy violation: the handshake was fine, the slug was not. */
const CLOSE_POLICY_VIOLATION = 1008;
/** RFC 6455 going away, sent to every peer while shutting down. */
const CLOSE_GOING_AWAY = 1001;
/** RFC 6455 internal error: the slug was fine, the room could not be opened. */
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * How long a room with no peers is kept in memory before it is flushed,
 * compacted and released.
 *
 * Long enough that closing a tab and opening it again is free, short enough
 * that a hub left running for days is not holding every board anybody looked at.
 */
export const DEFAULT_IDLE_PERIOD_MS = 60_000;

export interface HubOptions {
  /** TCP port to bind. `0` asks the OS for a free one — read the real port from `url`. */
  port?: number;
  /** Directory holding room data. Created by `start()`, after the port is bound. */
  dataDir?: string;
  /**
   * Directory of prebuilt frontend assets to serve alongside the API.
   * Without it the hub answers 404 on everything but its own endpoints.
   */
  staticDir?: string;
  /** Overrides {@link DEFAULT_IDLE_PERIOD_MS}. */
  idlePeriodMs?: number;
}

export interface Hub {
  /**
   * Starts listening and resolves with the base URL. Idempotent.
   *
   * Rejects when the data directory cannot be created or written: a hub that
   * cannot persist is a cache pretending to be a hub, and running as one would
   * lose a board on the next restart without ever saying so.
   */
  start(): Promise<string>;
  /**
   * Stops listening, disconnects every peer, writes every room out and discards
   * them. Idempotent.
   *
   * Resolves only once the last flush has landed, so a graceful exit closes the
   * debounce window rather than losing whatever was inside it. Rooms do not
   * survive a stop: the `Awareness` each one owns holds a timer that would
   * otherwise keep the host process alive. A hub started again reads them back
   * off disk.
   */
  stop(): Promise<void>;
  /** Base URL while running, `null` otherwise. */
  readonly url: string | null;
  /** Resolved data directory. */
  readonly dataDir: string;
  /** Idle period after which a room with no peers is released. */
  readonly idlePeriodMs: number;
}

function defaultDataDir(): string {
  return join(homedir(), DATA_DIR_NAME);
}

/**
 * Builds a hub instance. Nothing is bound, read or written until `start()` —
 * importing this module has no side effects, so tests can run a hub in-process
 * and the CLI stays a thin wrapper around it.
 *
 * HTTP and WebSocket share one port: the frontend, the introspection endpoints
 * and the room sync channel all live behind a single origin, which keeps the
 * CLI and the desktop shell down to one number to hand around.
 */
export function createHub(options: HubOptions = {}): Hub {
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = options.dataDir ?? defaultDataDir();
  const idlePeriodMs = options.idlePeriodMs ?? DEFAULT_IDLE_PERIOD_MS;
  const serveStatic =
    options.staticDir === undefined ? null : createStaticHandler(options.staticDir);

  const persistence = createPersistence(dataDir);
  const rooms = createRoomRegistry({ persistence, idlePeriodMs });
  const sockets = new WebSocketServer({ noServer: true });

  const server = createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("internal error");
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = requestPathname(request.url);

    // The endpoints are matched before the static handler on purpose: once a
    // static directory is configured its SPA fallback would answer them with
    // HTML and the API would silently disappear.

    // Lets hub-client tell our hub apart from whatever else grabbed the port.
    if (pathname === "/health") {
      const health: HubHealth = { service: HUB_SERVICE_ID, protocol: PROTOCOL_VERSION };
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(health));
      return;
    }

    // Debugging aid: which boards are live, who is on them, how big they got.
    if (pathname === "/__rooms") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ rooms: rooms.summarise() }));
      return;
    }

    if (serveStatic !== null && (await serveStatic(pathname, response))) return;

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }

  server.on("upgrade", (request, socket, head) => {
    const pathname = requestPathname(request.url);
    if (!pathname.startsWith(SYNC_PREFIX)) {
      // An `upgrade` listener owns the socket: simply returning leaks it.
      socket.destroy();
      return;
    }

    const slug = pathname.slice(SYNC_PREFIX.length);
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      // Validated after the handshake so the client reads a close code instead
      // of an opaque reset. No slug is ever substituted for a missing one: a
      // bare `/sync/` is an error, not an unnamed room everyone shares.
      if (!isRoomSlug(slug)) {
        webSocket.close(CLOSE_POLICY_VIOLATION, "invalid room slug");
        return;
      }

      // Reading the room off disk takes a turn of the event loop, and a client
      // opens by announcing its own state vector. Nothing listens for that
      // message yet, so the socket is held back until the room is ready rather
      // than allowed to drop the one message that makes the peer converge.
      webSocket.pause();
      rooms.obtain(slug).then(
        (room) => {
          if (webSocket.readyState === WebSocket.OPEN) attachConnection(room, webSocket);
          // Resumed either way. A peer that went away while the room was being
          // read still has a closing handshake to finish, and a paused receiver
          // never reads the reply that completes it — which would leave
          // `server.close()` waiting on a socket that is never going to end.
          webSocket.resume();
        },
        (error: unknown) => {
          webSocket.resume();
          webSocket.close(CLOSE_INTERNAL_ERROR, roomFailureReason(error));
        },
      );
    });
  });

  let url: string | null = null;

  /** Sends every peer away and gives the port back. */
  async function releasePort(): Promise<void> {
    // `server.close()` stops accepting and waits for connections to end, but an
    // upgraded socket never ends on its own — the peers have to be sent away
    // first or the port would stay bound.
    for (const webSocket of sockets.clients) webSocket.close(CLOSE_GOING_AWAY, "hub stopping");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async function start(): Promise<string> {
    if (url !== null) return url;

    // The bind comes first, before a single byte of the data directory is read
    // or written. `packages/hub-client` settles the "who runs the hub" race by
    // starting one per caller and letting everyone who loses the port die on
    // EADDRINUSE; two processes that had both prepared the data directory
    // before one of them lost would have appended into the same log, and
    // interleaved appends do not parse. Preparing first would also report a
    // directory error to a caller whose only real problem was arriving second.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, DEFAULT_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });

    try {
      const address = server.address() as AddressInfo | null;
      if (address === null) throw new Error("hub started but reported no address");
      await persistence.prepare();
      url = `http://${DEFAULT_HOST}:${address.port}`;
      return url;
    } catch (error) {
      // Nothing is left holding the port: the next attempt, here or in another
      // process, has to be able to bind it.
      await releasePort();
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (url === null) return;

    await releasePort();

    try {
      // Rooms go with the hub they belonged to. Each one owns an `Awareness`
      // whose keepalive interval is cleared only by `destroy()`, so a hub that
      // kept its rooms would release the port and still hold the event loop
      // open: the CLI's Ctrl-C handler would appear to do nothing. Every room
      // is written out first — the snapshot can only come from a live document.
      await rooms.shutdown();
      await persistence.settle();
    } finally {
      url = null;
    }
  }

  return {
    start,
    stop,
    get url() {
      return url;
    },
    dataDir,
    idlePeriodMs,
  };
}

/**
 * What to tell a peer whose room could not be opened.
 *
 * A version the hub cannot read is worth naming — it is the one failure here a
 * user can act on, by running the build that wrote the log. Anything else is
 * kept vague on the wire and stays a server-side concern. The reason field of a
 * close frame is capped at 123 bytes, so it is trimmed well inside that.
 */
function roomFailureReason(error: unknown): string {
  if (error instanceof UnsupportedLogVersionError) return error.message.slice(0, 120);
  return "room unavailable";
}

/**
 * Everything in the request target before the query string, exactly as it
 * arrived.
 *
 * Deliberately not `new URL(target, base).pathname`: that collapses `..`
 * segments, which would hand the static handler an innocent-looking path and
 * hide a traversal attempt instead of letting it be refused.
 */
function requestPathname(target: string | undefined): string {
  if (target === undefined) return "/";
  const queryStart = target.indexOf("?");
  return queryStart === -1 ? target : target.slice(0, queryStart);
}
