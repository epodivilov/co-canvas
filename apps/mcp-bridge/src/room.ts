/**
 * The guard every tool that reaches into a room's document goes through.
 *
 * It was CC-16's, private to the drawing tools; `describe_scene` needs the same
 * order for the same reason, and a second copy of a rule about not creating
 * rooms by accident is a rule that drifts.
 */
import type * as Y from "yjs";
import { boardUrl } from "./board.ts";
import type { RoomConnection, RoomConnections } from "./connections.ts";
import type { HubAccess } from "./hub.ts";
import { acquireHub, listHubRooms } from "./hub.ts";
import { assertRoomSlug } from "./slug.ts";

/** What a tool that opens a room needs from the rest of the bridge. */
export interface RoomAccess {
  readonly access: HubAccess;
  /** CC-15's per-room cache. No tool opens a connection of its own. */
  readonly connections: RoomConnections;
}

/**
 * The presence channel a room's connection carries.
 *
 * Derived off the connection's provider rather than imported from
 * `y-protocols` directly, so the tool reaches awareness without the bridge
 * taking a new direct dependency on a package it only sees transitively.
 */
export type RoomAwareness = RoomConnection["provider"]["awareness"];

/** A room's document, the URL a browser opens it at, and its presence channel. */
export interface OpenedRoom {
  readonly doc: Y.Doc;
  readonly url: string;
  /**
   * Remote peers' awareness, including the human's live `selectedElementIds`
   * (CC-19). y-websocket builds this on the doc by default; `get_selection`
   * reads the human's selection off it.
   */
  readonly awareness: RoomAwareness;
}

/**
 * The document behind a board, and the URL it opens at.
 *
 * The room has to exist first. The hub creates a room on first connect, so the
 * check happens before the socket does — otherwise a typo would quietly make a
 * second board and work on that one, which is the same stance `open_room`
 * takes. The slug is refused before the hub is even reached.
 */
export async function openRoom(deps: RoomAccess, slug: string): Promise<OpenedRoom> {
  assertRoomSlug(slug);
  const hub = await acquireHub(deps.access);
  const rooms = await listHubRooms(hub.url);
  if (!rooms.some((room) => room.slug === slug)) {
    throw new Error(
      `no board named "${slug}" is open. Call create_room with slug "${slug}" first.`,
    );
  }
  const connection = await deps.connections.open(hub.url, slug);
  return {
    doc: connection.doc,
    url: boardUrl(hub.url, slug),
    awareness: connection.provider.awareness,
  };
}
