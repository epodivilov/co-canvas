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
import { WebSocketServer } from "ws";
import { createRoomRegistry } from "./rooms";
import { createStaticHandler } from "./static-files";
import { attachConnection } from "./sync";

/** WebSocket paths under this prefix address a room. Nothing else upgrades. */
const SYNC_PREFIX = "/sync/";
/** RFC 6455 policy violation: the handshake was fine, the slug was not. */
const CLOSE_POLICY_VIOLATION = 1008;
/** RFC 6455 going away, sent to every peer while shutting down. */
const CLOSE_GOING_AWAY = 1001;

export interface HubOptions {
  /** TCP port to bind. `0` asks the OS for a free one — read the real port from `url`. */
  port?: number;
  /** Directory holding room data. Created lazily by the persistence layer. */
  dataDir?: string;
  /**
   * Directory of prebuilt frontend assets to serve alongside the API.
   * Without it the hub answers 404 on everything but its own endpoints.
   */
  staticDir?: string;
}

export interface Hub {
  /** Starts listening and resolves with the base URL. Idempotent. */
  start(): Promise<string>;
  /**
   * Stops listening, disconnects every peer and discards every room. Idempotent.
   *
   * Rooms do not survive a stop: their contents are held in memory only, and the
   * `Awareness` each one owns holds a timer that would otherwise keep the host
   * process alive. A hub started again serves empty rooms.
   */
  stop(): Promise<void>;
  /** Base URL while running, `null` otherwise. */
  readonly url: string | null;
  /** Resolved data directory. */
  readonly dataDir: string;
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
  const serveStatic =
    options.staticDir === undefined ? null : createStaticHandler(options.staticDir);

  const rooms = createRoomRegistry();
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
      attachConnection(rooms.obtain(slug), webSocket);
    });
  });

  let url: string | null = null;

  async function start(): Promise<string> {
    if (url !== null) return url;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, DEFAULT_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (address === null) throw new Error("hub started but reported no address");

    url = `http://${DEFAULT_HOST}:${address.port}`;
    return url;
  }

  async function stop(): Promise<void> {
    if (url === null) return;

    // `server.close()` stops accepting and waits for connections to end, but an
    // upgraded socket never ends on its own — the peers have to be sent away
    // first or the port would stay bound.
    for (const webSocket of sockets.clients) webSocket.close(CLOSE_GOING_AWAY, "hub stopping");

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    // Rooms go with the hub they belonged to. Each one owns an `Awareness` whose
    // keepalive interval is cleared only by `destroy()`, so a hub that kept its
    // rooms would release the port and still hold the event loop open: the CLI's
    // Ctrl-C handler would appear to do nothing.
    rooms.destroyAll();
    url = null;
  }

  return {
    start,
    stop,
    get url() {
      return url;
    },
    dataDir,
  };
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
