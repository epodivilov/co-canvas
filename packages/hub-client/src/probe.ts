import { DEFAULT_HOST, HUB_SERVICE_ID, PROTOCOL_VERSION } from "@co-canvas/protocol";

/** What answered — or did not answer — on a port. */
export type HubProbe =
  /** A co-canvas hub speaking the wire format this client was built against. */
  | { readonly kind: "hub" }
  /** A co-canvas hub speaking something else. */
  | { readonly kind: "protocol-mismatch"; readonly protocol: number }
  /** Someone answered HTTP, and it is not a hub we can talk to. */
  | { readonly kind: "foreign" }
  /** Nothing answered. */
  | { readonly kind: "absent" };

/** How long a single health request may take before the port counts as silent. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1000;

/**
 * Asks `127.0.0.1:port` what it is. Never rejects.
 *
 * Two rules make this reliable, and both are the opposite of the obvious
 * implementation:
 *
 * 1. *Any* failure to get a response means "nothing is here". The rejection
 *    shape varies with the host form — a `TypeError` wrapping an `Error` with
 *    `code: "ECONNREFUSED"` for `127.0.0.1`, an `AggregateError` for
 *    `localhost`, no code at all for a privileged port — so branching on the
 *    code would work in development and quietly stop working elsewhere.
 * 2. An occupant is identified by a *successful* response that is not a matching
 *    health payload. That rule holds no matter how the failures are shaped.
 *
 * The timeout is not optional either: a service that accepts the connection and
 * then says nothing would otherwise hang every caller of this package forever.
 */
export async function probeHub(
  port: number,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<HubProbe> {
  let response: Response;
  try {
    response = await fetch(`http://${DEFAULT_HOST}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "absent" };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    // Headers arrived, the body did not. Something is holding the port, and it
    // is not a hub this client can use.
    return { kind: "foreign" };
  }
  if (!response.ok) return { kind: "foreign" };

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { kind: "foreign" };
  }
  if (typeof payload !== "object" || payload === null) return { kind: "foreign" };

  const { service, protocol } = payload as Record<string, unknown>;
  if (service !== HUB_SERVICE_ID) return { kind: "foreign" };
  if (typeof protocol !== "number") return { kind: "foreign" };
  if (protocol !== PROTOCOL_VERSION) return { kind: "protocol-mismatch", protocol };
  return { kind: "hub" };
}
