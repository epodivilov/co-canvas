/**
 * Wire format version shared by the hub, the web canvas and the MCP bridge.
 * Bump whenever the room document layout changes incompatibly.
 */
export const PROTOCOL_VERSION = 1;

/** Human-typeable identifier of a board, e.g. `auth-redesign`. */
export type RoomSlug = string;

/**
 * The only shape a room slug may take: lowercase, URL-safe, at most 64 chars,
 * and never empty — the pattern requires a leading character on purpose, so a
 * missing slug can be rejected rather than quietly turned into a shared room.
 */
export const ROOM_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Reports whether `value` can address a room. */
export function isRoomSlug(value: string): boolean {
  return ROOM_SLUG_PATTERN.test(value);
}
