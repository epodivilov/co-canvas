import { PROTOCOL_VERSION } from "@co-canvas/protocol";

// Overview and /room/:slug routes land in CC-12 and CC-4.
export function App() {
  return (
    <main>
      <h1>co-canvas</h1>
      <p>protocol v{PROTOCOL_VERSION}</p>
    </main>
  );
}
