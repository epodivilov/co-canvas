/**
 * Wire format version shared by the hub, the web canvas and the MCP bridge.
 * Bump whenever the room document layout changes incompatibly.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Port the hub binds unless a caller names another one.
 *
 * Fixed rather than negotiated: `http://127.0.0.1:4321/room/{slug}` is meant to
 * be stable enough to bookmark, so a busy port is an error to report rather than
 * something to route around.
 */
export const DEFAULT_PORT = 4321;

/** Loopback only. Nothing in co-canvas listens on a routable interface. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * `service` field of the hub's health response, and the only way a client can
 * tell our hub apart from whatever else happens to hold the port.
 */
export const HUB_SERVICE_ID = "co-canvas-hub";

/**
 * Name of the per-user data directory. A bare name, not a path: this module is
 * bundled into the browser by `apps/web`, so it cannot reach for `node:os` to
 * join it with a home directory. Every node-side consumer does that itself.
 */
export const DATA_DIR_NAME = ".co-canvas";

/** Body of `GET /health`, the contract between the hub and its clients. */
export interface HubHealth {
  service: typeof HUB_SERVICE_ID;
  protocol: number;
}

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
