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
}

/**
 * Holds every room the process has seen. Rooms are created lazily and never
 * evicted — persistence and eviction land in CC-13, and until then a hub's
 * memory is the only place a board lives.
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
  };
}
