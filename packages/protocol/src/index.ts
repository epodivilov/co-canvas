/**
 * Wire format version shared by the hub, the web canvas and the MCP bridge.
 * Bump whenever the room document layout changes incompatibly.
 */
export const PROTOCOL_VERSION = 1;

/** Human-typeable identifier of a board, e.g. `auth-redesign`. */
export type RoomSlug = string;
