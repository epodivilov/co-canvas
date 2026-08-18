/**
 * The Vite dev server's origins.
 *
 * In development the overview and canvas are served by Vite while the hub
 * listens on its own port, so the browser's WebSocket and board-API requests are
 * cross-origin and carry one of these as their `Origin`. Both loopback hostnames
 * a developer might use are listed. Kept in step with `apps/web/vite.config.ts`,
 * which fixes the dev port at 5173.
 */
const DEV_WEB_ORIGINS: ReadonlySet<string> = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

/**
 * Whether the hub's own same-origin UI produced `origin`.
 *
 * Pinned to loopback literals on the hub's actual bound port, **not** derived
 * from the request's `Host` header. Reflecting `Host` would only assert "the
 * Origin's authority equals the Host the client sent", which a DNS-rebinding
 * attacker satisfies without forging anything: a page served from
 * `http://attacker.example:PORT`, once `attacker.example` is rebound to
 * `127.0.0.1`, sends an `Origin` and a `Host` that agree with each other and
 * would pass an equality check — while being a foreign origin. Anchoring to
 * loopback literals closes that: `127.0.0.1` is an IP literal an attacker cannot
 * rebind, and browsers and the OS resolve `localhost` to loopback by rule, so
 * neither can ever be an attacker's authority.
 */
function isHubOwnOrigin(origin: string, hubPort: number): boolean {
  return origin === `http://127.0.0.1:${hubPort}` || origin === `http://localhost:${hubPort}`;
}

/**
 * Whether a browser request carrying `origin` may talk to the hub.
 *
 * The hub binds loopback, but a browser can still reach loopback, and neither
 * the sync channel nor the board API has any per-room auth — so any page a user
 * visits could open a socket to a board it names or read the board list. This
 * gate refuses a present, foreign `Origin`.
 *
 * Two origins pass. The hub's own — production serves the SPA itself, so the
 * page and its socket share the hub's loopback origin ({@link isHubOwnOrigin},
 * pinned to the bound port). And the dev web origin — Vite serves the page
 * cross-origin during `pnpm dev`. `hubPort` is the port the hub actually bound;
 * it is `null` before the hub has started, when no same-origin request can
 * arrive anyway.
 *
 * A request with **no** `Origin` is not judged here — that is a non-browser
 * client (the MCP bridge, any Node `ws`), which a browser drive-by cannot
 * impersonate; callers allow it explicitly.
 */
export function isAllowedOrigin(origin: string, hubPort: number | null): boolean {
  if (DEV_WEB_ORIGINS.has(origin)) return true;
  if (hubPort !== null && isHubOwnOrigin(origin, hubPort)) return true;
  return false;
}
