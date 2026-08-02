import { PROTOCOL_VERSION } from "@co-canvas/protocol";
import { RoomView } from "./room/RoomView.tsx";
import { parseRoute } from "./routes.ts";

/**
 * Dispatches on the pathname the page was served under. There is no client-side
 * navigation yet — every route change is a page load — so the path is read once
 * per render and nothing subscribes to it.
 */
export function App() {
  const route = parseRoute(window.location.pathname);
  if (route.kind === "room") return <RoomView slug={route.slug} />;
  return <Placeholder />;
}

/** The board overview lands in CC-4. */
function Placeholder() {
  return (
    <main className="placeholder">
      <h1>co-canvas</h1>
      <p>protocol v{PROTOCOL_VERSION}</p>
      <p>Open a board at /room/&lt;name&gt;.</p>
    </main>
  );
}
