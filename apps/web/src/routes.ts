import type { RoomSlug } from "@co-canvas/protocol";

/** Where a pathname sends the app. */
export type Route = { kind: "room"; slug: RoomSlug } | { kind: "placeholder" };

const ROOM_PREFIX = "/room/";

/**
 * Reads a route out of a pathname.
 *
 * The slug is handed on exactly as it arrived, however unlikely it looks. The
 * hub is the single authority on what a room may be called, and a client-side
 * check would make its refusal — and the terminal error the room view shows for
 * it — a path no browser could ever reach.
 *
 * `/room/` carries no slug and so is not a room: it falls through to the same
 * placeholder as any unknown path rather than opening a connection to a room
 * with an empty name.
 */
export function parseRoute(pathname: string): Route {
  if (!pathname.startsWith(ROOM_PREFIX)) return { kind: "placeholder" };
  const slug = pathname.slice(ROOM_PREFIX.length);
  if (slug === "") return { kind: "placeholder" };
  return { kind: "room", slug };
}
