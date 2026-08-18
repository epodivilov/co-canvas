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
import { createBoardEndpoints } from "./board-endpoints.ts";
import { isAllowedOrigin } from "./origin-allowlist.ts";
import { createPersistence } from "./persistence.ts";
import { UnsupportedLogVersionError } from "./room-log.ts";
import { createRoomRegistry } from "./rooms.ts";
import type { StaticHandler } from "./static-files.ts";
import {
  createDirectoryAssetSource,
  createEmbeddedAssetSource,
  createStaticHandler,
} from "./static-files.ts";
import { attachConnection, toBytes } from "./sync.ts";

/** WebSocket paths under this prefix address a room. Nothing else upgrades. */
const SYNC_PREFIX = "/sync/";
/** RFC 6455 policy violation: the handshake was fine, the slug was not. */
const CLOSE_POLICY_VIOLATION = 1008;
/** RFC 6455 going away, sent to every peer while shutting down. */
const CLOSE_GOING_AWAY = 1001;
/** RFC 6455 internal error: the slug was fine, the room could not be opened. */
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * How long a going-away close has to complete before the socket is terminated.
 *
 * Node finishes `server.close()` once each peer answers the closing handshake,
 * which is immediate for a well-behaved client, so this grace is not spent.
 * Bun's `node:http` never tears an upgraded socket down on a graceful close, and
 * a genuinely unresponsive peer would strand `server.close()` on Node too — so
 * after the grace the sockets are terminated and the port comes back regardless.
 */
const RELEASE_GRACE_MS = 250;

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
   * Without it — and without {@link staticAssets} — the hub answers 404 on
   * everything but its own endpoints.
   */
  staticDir?: string;
  /**
   * Prebuilt frontend assets held in memory, keyed by their relative POSIX path
   * (`index.html`, `assets/app.js`). The shape the single-file `bun --compile`
   * binary carries its frontend in, since it has no directory to read from.
   * Ignored when {@link staticDir} is also given.
   */
  staticAssets?: ReadonlyMap<string, Uint8Array>;
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
  /** Peers currently connected across every room. */
  totalPeers(): number;
  /**
   * Subscribes to the total peer count, called on every join and leave; returns
   * a function that unsubscribes.
   *
   * This is the signal the CLI's idle shutdown runs on: a hub with no peers for
   * long enough is a process nobody is using, and an open browser tab is a peer
   * that keeps it. Exposed as a push rather than a poll so the timer can be
   * armed and disarmed exactly on the transitions, not on a clock of its own.
   */
  onPeersChanged(listener: (totalPeers: number) => void): () => void;
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
  const serveStatic = resolveStaticHandler(options);

  // Subscribers to the total peer count. A `Set` of listeners rather than a
  // single callback so that observing peers is a capability of the hub, not a
  // slot one owner claims — the CLI wires idle shutdown to it without stopping
  // anything else from watching.
  const peerListeners = new Set<(totalPeers: number) => void>();
  const persistence = createPersistence(dataDir);
  // The port the hub actually bound, known only once `start()` has listened. The
  // Origin gate pins same-origin to this loopback port rather than the request's
  // `Host`, so a rebinding page whose `Host` and `Origin` merely agree with each
  // other cannot pass itself off as the hub's own UI. `null` until the hub has
  // started, when no same-origin request can arrive anyway.
  let boundPort: number | null = null;
  const boardEndpoints = createBoardEndpoints(persistence, () => boundPort);
  const rooms = createRoomRegistry({
    persistence,
    idlePeriodMs,
    onPeersChanged: (totalPeers) => {
      for (const listener of peerListeners) listener(totalPeers);
    },
  });
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

    // The overview's data plane: the persisted board list and the create /
    // rename / archive / restore operations. Matched here, ahead of the static
    // fallback, so they answer as JSON rather than as the SPA's index.html.
    if (await boardEndpoints(request, response, pathname)) return;

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

    // The load-bearing hardening: the sync channel has no per-room auth, so a
    // browser on any site — which can still reach loopback — would otherwise get
    // full read+write of a board it names. CORS does not gate WebSockets, so the
    // Origin has to be checked on the upgrade itself. A present, foreign Origin
    // is refused before the handshake completes; a missing one is a non-browser
    // client (the MCP bridge, any Node `ws`) and is left to connect.
    const origin = request.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, boundPort)) {
      // Answering the upgrade with a plain 4xx leaves the handshake incomplete,
      // so the page sees a failed connection rather than an open socket. The
      // socket is owned here, so it is closed rather than left to leak.
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
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
      // opens by announcing its own state vector. Under Node's `ws` the receiver
      // could be paused until the room was ready; Bun's native WebSocket has no
      // receiver to pause (`webSocket.pause` is not a function), so instead the
      // frames that arrive during the load are buffered and replayed once the
      // connection is attached. Either way the peer's first message — the one
      // that makes it converge — is never dropped, and the socket's receiver is
      // never held, so a peer that closed mid-load still finishes its handshake
      // and `server.close()` does not wait on it forever.
      const backlog: Uint8Array[] = [];
      let closed = false;
      const onEarlyMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
        backlog.push(toBytes(data));
      };
      const onEarlyClose = (): void => {
        closed = true;
      };
      webSocket.on("message", onEarlyMessage);
      webSocket.once("close", onEarlyClose);

      rooms.obtain(slug).then(
        (room) => {
          webSocket.off("message", onEarlyMessage);
          webSocket.off("close", onEarlyClose);
          // A peer that went away while the room was being read has nothing to
          // attach to; its socket is already on its way out and is left to
          // finish its closing handshake.
          if (closed || webSocket.readyState !== WebSocket.OPEN) return;
          attachConnection(room, webSocket, backlog);
        },
        (error: unknown) => {
          webSocket.off("message", onEarlyMessage);
          webSocket.off("close", onEarlyClose);
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
      let settled = false;
      let forceClose: NodeJS.Timeout | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (forceClose !== undefined) clearTimeout(forceClose);
        if (error) reject(error);
        else resolve();
      };

      // Node calls this once every going-away handshake has finished — normally
      // at once for a well-behaved peer. Bun's node:http never calls it for an
      // upgraded socket at all.
      server.close((error) => finish(error ?? undefined));

      // When the grace is up the graceful close did not land: a peer that will
      // not answer on Node, or an upgraded socket Bun will not report closed.
      // Dropping every remaining connection frees the port on both runtimes —
      // `server.close()` has already stopped the server listening — so stop()
      // resolves rather than waiting forever. On the normal Node path this timer
      // is cleared before it fires and the close stays fully graceful.
      forceClose = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, RELEASE_GRACE_MS);
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
      boundPort = address.port;
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
      boundPort = null;
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
    totalPeers: () => rooms.totalPeers(),
    onPeersChanged(listener) {
      peerListeners.add(listener);
      return () => peerListeners.delete(listener);
    },
  };
}

/**
 * Turns the static options into a handler, or `null` when the hub serves no
 * frontend. A directory wins over an embedded map: a `--static` override is a
 * developer deliberately pointing the hub at a build on disk.
 */
function resolveStaticHandler(options: HubOptions): StaticHandler | null {
  if (options.staticDir !== undefined) {
    return createStaticHandler(createDirectoryAssetSource(options.staticDir));
  }
  if (options.staticAssets !== undefined) {
    return createStaticHandler(createEmbeddedAssetSource(options.staticAssets));
  }
  return null;
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
