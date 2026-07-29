import type { RoomSlug } from "@co-canvas/protocol";
import * as Y from "yjs";
import type { Room } from "./sync";
import { createRoom } from "./sync";

/** What `/__rooms` reports for a single room. */
export interface RoomSummary {
  slug: RoomSlug;
  peers: number;
  docBytes: number;
}

export interface RoomRegistry {
  /** Returns the room for `slug`, creating it on first use. */
  obtain(slug: RoomSlug): Room;
  /** Snapshot of every live room, cheap enough to call per request. */
  summarise(): RoomSummary[];
  /** Tears every room down and empties the registry. */
  destroyAll(): void;
}

/**
 * Holds every room the hub is serving. Rooms are created lazily and are never
 * evicted while the hub runs — persistence and eviction land in CC-13, and until
 * then a hub's memory is the only place a board lives.
 *
 * They are torn down when the hub stops, because a room owns an `Awareness`
 * whose keepalive interval is only cleared by `destroy()`. Leaving rooms behind
 * would keep the host process's event loop alive long after the hub had released
 * its port.
 */
export function createRoomRegistry(): RoomRegistry {
  const rooms = new Map<RoomSlug, Room>();

  return {
    obtain(slug: RoomSlug): Room {
      const existing = rooms.get(slug);
      if (existing !== undefined) return existing;
      const room = createRoom(slug);
      rooms.set(slug, room);
      return room;
    },

    summarise(): RoomSummary[] {
      return [...rooms.values()].map((room) => ({
        slug: room.slug,
        peers: room.connections.size,
        docBytes: Y.encodeStateAsUpdate(room.doc).byteLength,
      }));
    },

    destroyAll(): void {
      for (const room of rooms.values()) {
        room.awareness.destroy();
        room.doc.destroy();
      }
      rooms.clear();
    },
  };
}
