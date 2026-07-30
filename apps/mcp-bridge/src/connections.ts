import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { syncServerUrl } from "./board.ts";

/**
 * How long a room connection has to complete its first sync.
 *
 * Generous, because the hub may have just been started by this same call, and
 * bounded, because `y-websocket` reconnects forever on its own and a tool call
 * that never returns is worse than one that says why.
 */
const SYNC_TIMEOUT_MS = 10_000;

/** One live connection to a room, held for the lifetime of the process. */
export interface RoomConnection {
  readonly slug: string;
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;
}

export interface RoomConnections {
  /** The connection for `slug`, opening and syncing one on first use. */
  open(hubUrl: string, slug: string): Promise<RoomConnection>;
  /** Tears every connection down. */
  closeAll(): void;
}

/**
 * Caches one connection per room.
 *
 * Cached by slug and shared by every tool call, which is what keeps the hub
 * reporting a single peer for a board an agent has touched repeatedly — and
 * what CC-16 and CC-17 will read and write through.
 *
 * The cache holds the in-flight promise rather than the settled connection, so
 * two calls that race for the same room end up on one socket instead of two.
 */
export function createRoomConnections(): RoomConnections {
  const connections = new Map<string, Promise<RoomConnection>>();

  return {
    open(hubUrl, slug) {
      const existing = connections.get(slug);
      if (existing !== undefined) return existing;

      const opening = connect(hubUrl, slug).catch((error: unknown) => {
        // A failed attempt must not become the cached answer for the rest of
        // the process's life; the next call gets to try again.
        connections.delete(slug);
        throw error;
      });
      connections.set(slug, opening);
      return opening;
    },

    closeAll() {
      const opening = [...connections.values()];
      connections.clear();
      for (const pending of opening) {
        void pending.then(
          (connection) => {
            connection.provider.destroy();
            // Destroying the doc destroys the awareness the provider built on
            // it, which is the only thing that clears its keepalive interval —
            // and therefore the only thing that lets the process exit.
            connection.doc.destroy();
          },
          () => {
            // Never opened, so there is nothing to close.
          },
        );
      }
    },
  };
}

async function connect(hubUrl: string, slug: string): Promise<RoomConnection> {
  const doc = new Y.Doc();
  // `disableBc` is not optional: Node has a global `BroadcastChannel`, so two
  // providers for one slug inside a process sync through it and a broken socket
  // path looks like a working one.
  const provider = new WebsocketProvider(syncServerUrl(hubUrl), slug, doc, { disableBc: true });

  try {
    await whenSynced(provider, slug);
  } catch (error) {
    provider.destroy();
    doc.destroy();
    throw error;
  }

  return { slug, doc, provider };
}

/**
 * Resolves once the room's initial sync has completed.
 *
 * Constructing a provider only opens a socket; the hub does not hold the room
 * until the upgrade lands, so a `create_room` that returned here would race its
 * own caller's next question about the hub.
 */
function whenSynced(provider: WebsocketProvider, slug: string): Promise<void> {
  if (provider.synced) return Promise.resolve();

  return new Promise((resolve, reject) => {
    function onSync(state: boolean): void {
      if (!state) return;
      clearTimeout(timer);
      provider.off("sync", onSync);
      resolve();
    }

    const timer = setTimeout(() => {
      provider.off("sync", onSync);
      reject(new Error(`the hub did not sync room "${slug}" within ${SYNC_TIMEOUT_MS}ms`));
    }, SYNC_TIMEOUT_MS);

    provider.on("sync", onSync);
  });
}
