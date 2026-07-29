/**
 * Every failure this package raises deliberately, tagged so callers can react to
 * the situation rather than to a message they would have to pattern-match.
 *
 * - `port-occupied` — something answers on the port a hub would be started on,
 *   and it is not a co-canvas hub.
 * - `protocol-mismatch` — a co-canvas hub answers, speaking a wire format this
 *   client was not built against.
 * - `spawn-failed` — the command could not be executed at all; the underlying
 *   error is on `cause`.
 * - `start-failed` — the command ran but never became a healthy hub, either by
 *   exiting or by staying silent until the startup budget ran out.
 */
export type HubClientErrorCode =
  | "port-occupied"
  | "protocol-mismatch"
  | "spawn-failed"
  | "start-failed";

/** Error carrying a `code` from the closed set above. */
export class HubClientError extends Error {
  readonly code: HubClientErrorCode;

  constructor(code: HubClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HubClientError";
    this.code = code;
  }
}
