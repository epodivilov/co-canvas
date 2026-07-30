import type { RoomSlug } from "@co-canvas/protocol";

/**
 * The board a slug names, on the hub at `hubUrl`.
 *
 * The one place in the process that knows the route. It stays here rather than
 * in `@co-canvas/protocol` because only the bridge ever builds one of these:
 * `apps/web` owns `/room/:slug` and the hub serves the SPA underneath it
 * without needing to know the shape.
 */
export function boardUrl(hubUrl: string, slug: RoomSlug): string {
  return `${hubUrl}/room/${slug}`;
}

/**
 * The server URL a `y-websocket` provider is constructed with.
 *
 * `y-websocket` builds its target as `serverUrl + "/" + roomname`, so the
 * provider gets the `/sync` prefix and the bare slug separately. Handing it the
 * whole path as a room name produces `ws://…/sync//sync/alpha`.
 */
export function syncServerUrl(hubUrl: string): string {
  return `${hubUrl.replace(/^http/, "ws")}/sync`;
}
