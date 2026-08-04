import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveHubCommand, resolveHubPort, resolveOpenCommand } from "./env.ts";
import { createBridge } from "./server.ts";

// stdout belongs to the MCP stream; anything human-facing goes to stderr.

/**
 * How long the shutdown gets before the process leaves anyway.
 *
 * A socket that does not close cleanly must not turn "the client went away"
 * into a process nobody can see and nobody killed.
 */
const SHUTDOWN_GRACE_MS = 2000;

/**
 * Runs the bridge over stdio until its client goes away, then leaves.
 *
 * The callable the `co-canvas` dispatcher drives for its `mcp` subcommand, and
 * what the bridge's own `bin` runs directly. It reads the environment, connects
 * a stdio transport, and watches end of input so a bridge holding open
 * WebSockets does not outlive the client that spoke to it. It resolves once the
 * process is on its way out.
 */
export async function runBridge(): Promise<void> {
  const hubPort = resolveHubPort(process.env);

  const bridge = createBridge({
    ...(hubPort === undefined ? {} : { hubPort }),
    // Resolved per call, not here: an unbuilt hub belongs in the answer to a tool
    // call, not in a bridge that refuses to start.
    hubCommand: () => resolveHubCommand(process.env),
    openCommand: resolveOpenCommand(process.env),
  });

  await bridge.connect(new StdioServerTransport());

  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // Unreffed: a floor under the exit, not a reason to stay. It fires only if
    // something else is still holding the event loop open.
    setTimeout(() => {
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();

    try {
      await bridge.close();
    } catch (error) {
      process.stderr.write(`co-canvas mcp-bridge: shutdown failed: ${String(error)}\n`);
    }
    process.exit(0);
  }

  // `StdioServerTransport` registers `data` and `error` handlers on stdin and
  // nothing else — its `onclose` fires only from an explicit `close()`. A bridge
  // holding open WebSockets would therefore outlive its client forever, so end of
  // input is watched here rather than left to the transport.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
}
