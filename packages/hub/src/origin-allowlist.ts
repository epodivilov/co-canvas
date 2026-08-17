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
 * Whether a browser request carrying `origin` may talk to the hub.
 *
 * The hub binds loopback, but a browser can still reach loopback, and neither
 * the sync channel nor the board API has any per-room auth — so any page a user
 * visits could open a socket to a board it names or read the board list. This
 * gate refuses a present, foreign `Origin`.
 *
 * Two origins pass. The hub's own: production serves the SPA itself, so the page
 * and its socket share an origin, recognised by reflecting the `host` the client
 * actually dialed (a browser sets `Host` to the server and `Origin` to the page;
 * a foreign page cannot forge either for a real cross-origin request, so a match
 * is genuinely same-origin). And the dev web origin: Vite serves the page
 * cross-origin during `pnpm dev`.
 *
 * A request with **no** `Origin` is not judged here — that is a non-browser
 * client (the MCP bridge, any Node `ws`), which a browser drive-by cannot
 * impersonate; callers allow it explicitly.
 */
export function isAllowedOrigin(origin: string, host: string | undefined): boolean {
  if (DEV_WEB_ORIGINS.has(origin)) return true;
  if (host !== undefined && (origin === `http://${host}` || origin === `https://${host}`)) {
    return true;
  }
  return false;
}
