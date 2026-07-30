import type { RoomSlug } from "@co-canvas/protocol";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { currentHubUrlSources, resolveSyncUrl } from "./hub-url";

/**
 * What the page can say about its link to the hub.
 *
 * `refused` is terminal and separate from `disconnected` on purpose: everything
 * else is worth retrying, and this is the one state where retrying is pointless
 * because the hub has said the room name is not one it will ever serve.
 */
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "refused";

/** RFC 6455 policy violation — how the hub turns a room name down. */
const CLOSE_POLICY_VIOLATION = 1008;

/** One room's document, its link to the hub, and the state of that link. */
export interface RoomConnection {
  readonly slug: RoomSlug;
  readonly doc: Y.Doc;
  readonly yElements: Y.Array<Y.Map<unknown>>;
  readonly yAssets: Y.Map<unknown>;
  readonly provider: WebsocketProvider;
  status(): ConnectionStatus;
  /** Registers a status listener and returns its remover. */
  subscribe(listener: (status: ConnectionStatus) => void): () => void;
  /** How many WebSockets this connection has opened since it was created. */
  socketsOpened(): number;
  connect(): void;
  disconnect(): void;
  destroy(): void;
}

/**
 * Opens a room against the hub.
 *
 * The provider is given the hub's `/sync` prefix as its server URL and the slug
 * as its room name; `y-websocket` joins the two, which is what produces the
 * `/sync/{slug}` the hub upgrades on.
 *
 * `BroadcastChannel` is deliberately left enabled. Between a person's own tabs
 * it is a genuine optimisation — it is only a hazard for a test suite that
 * mistakes two tabs for two users, and that is the suite's problem to avoid.
 */
export function createRoomConnection(slug: RoomSlug): RoomConnection {
  const doc = new Y.Doc();
  const yElements = doc.getArray<Y.Map<unknown>>("elements");
  const yAssets = doc.getMap<unknown>("assets");

  // Counted here rather than read off `wsUnsuccessfulReconnects`: that counter
  // resets on every `onopen` and only advances for a socket that never
  // connected — which is exactly not the case a room refused after a completed
  // handshake produces.
  let socketsOpened = 0;
  class CountedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      socketsOpened += 1;
    }
  }

  const provider = new WebsocketProvider(resolveSyncUrl(currentHubUrlSources()), slug, doc, {
    WebSocketPolyfill: CountedWebSocket,
  });

  let status: ConnectionStatus = "connecting";
  const listeners = new Set<(status: ConnectionStatus) => void>();

  function moveTo(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of listeners) listener(next);
  }

  provider.on("status", (event: { status: "connecting" | "connected" | "disconnected" }) => {
    // A refused room is done; the `disconnected` that follows the close is
    // bookkeeping, not news.
    if (status === "refused") return;
    moveTo(event.status);
  });

  provider.on("connection-close", (event: CloseEvent | null) => {
    // `disconnect()` below re-enters this handler once, because the provider
    // emits the event before it clears its socket reference. It arrives with a
    // null event, and the status guard catches anything else.
    if (status === "refused") return;
    if (event === null || event.code !== CLOSE_POLICY_VIOLATION) return;

    moveTo("refused");
    // Without this the provider retries the refused room forever with a backoff
    // capped at 2.5 s, behind an indicator that never leaves "connecting".
    provider.disconnect();
  });

  return {
    slug,
    doc,
    yElements,
    yAssets,
    provider,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    socketsOpened: () => socketsOpened,
    connect() {
      if (status === "refused") return;
      provider.connect();
    },
    disconnect() {
      provider.disconnect();
      // A socket dropped before it ever opened closes without a status event,
      // so the state is set here rather than waited for.
      if (status !== "refused") moveTo("disconnected");
    },
    destroy() {
      listeners.clear();
      provider.destroy();
      doc.destroy();
    },
  };
}
