import { DEFAULT_HOST, DEFAULT_PORT } from "@co-canvas/protocol";

/** Everything outside the app that has a say in where the hub is. */
export interface HubUrlSources {
  /** `location.search`, leading `?` and all. */
  search: string;
  /** `location.origin` of the page being served. */
  origin: string;
  /** `VITE_HUB_URL`, if the build or the environment set one. */
  envUrl: string | undefined;
  /** `import.meta.env.DEV`. */
  dev: boolean;
}

/**
 * Where the hub lives during development, when Vite serves the page from a
 * different origin than the hub listens on.
 */
export const DEV_HUB_URL = `ws://${DEFAULT_HOST}:${DEFAULT_PORT}`;

/** Query parameter that points a page at an arbitrary hub. */
const HUB_PARAM = "hub";

/** Path the hub upgrades on. `y-websocket` appends the room name itself. */
const SYNC_PATH = "/sync";

/**
 * Turns any absolute URL into the websocket base to dial, or `null` when it is
 * not one this app can use.
 */
function toWebSocketBase(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const protocol =
    url.protocol === "https:" || url.protocol === "wss:"
      ? "wss:"
      : url.protocol === "http:" || url.protocol === "ws:"
        ? "ws:"
        : null;
  if (protocol === null) return null;

  // A trailing slash would produce `//sync`, which the hub does not route.
  const path = url.pathname.replace(/\/+$/, "");
  return `${protocol}//${url.host}${path}`;
}

/**
 * Resolves the hub, most specific source first: the `hub` query parameter, then
 * `VITE_HUB_URL`, then the loopback hub in development, then the page's own
 * origin.
 *
 * The query parameter exists because a hub started by a test binds whatever
 * port it was given. The development fallback exists because Vite and the hub
 * are separate origins while developing. In production the hub serves the page
 * itself, which makes same-origin the right answer and the only one that
 * survives being reached under another hostname.
 *
 * An override that is not a usable URL — an empty one included — is skipped
 * rather than fatal: a typo in an environment variable should not leave a room
 * with no canvas at all, and the connection indicator reports the outcome
 * either way.
 */
export function resolveHubBaseUrl(sources: HubUrlSources): string {
  const overrides = [
    new URLSearchParams(sources.search).get(HUB_PARAM) ?? undefined,
    sources.envUrl,
    sources.dev ? DEV_HUB_URL : undefined,
  ];

  for (const override of overrides) {
    const base = override === undefined ? null : toWebSocketBase(override);
    if (base !== null) return base;
  }

  // `location.origin` is an absolute URL in every browsing context this app
  // runs in; the fallback only exists to keep the return type honest.
  return toWebSocketBase(sources.origin) ?? DEV_HUB_URL;
}

/** The server URL to hand `WebsocketProvider`, which completes it with a slug. */
export function resolveSyncUrl(sources: HubUrlSources): string {
  return `${resolveHubBaseUrl(sources)}${SYNC_PATH}`;
}

/** Reads the sources out of the running page. */
export function currentHubUrlSources(): HubUrlSources {
  return {
    search: window.location.search,
    origin: window.location.origin,
    envUrl: import.meta.env.VITE_HUB_URL,
    dev: import.meta.env.DEV,
  };
}
