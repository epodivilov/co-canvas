import type { ConnectionStatus } from "./connection.ts";

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Offline — edits are kept locally",
  refused: "Room refused",
};

/**
 * Says out loud what the room's link to the hub is doing.
 *
 * Sits along the bottom edge, centred: Excalidraw keeps its own controls in the
 * corners and along the top, and this is the one strip of canvas it leaves free
 * on a desktop layout.
 */
export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <output className="connection-indicator" data-connection-state={status}>
      <span className="connection-indicator__dot" aria-hidden="true" />
      {LABELS[status]}
    </output>
  );
}
