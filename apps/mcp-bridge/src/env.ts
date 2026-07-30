/**
 * The bridge's own environment variables, and how the entry point turns them
 * into the options the server factory takes.
 *
 * All three say what the *bridge should ask for*. That is a different statement
 * from `CO_CANVAS_PORT` and `CO_CANVAS_DATA_DIR`, which `@co-canvas/hub-client`
 * writes into the environment of a hub it starts and which the hub reads as
 * facts about itself. The same number can travel through both, but only one of
 * them is a request.
 */
import { createRequire } from "node:module";
import type { CommandSpec } from "./command.ts";
import { parseCommandSpec } from "./command.ts";
import { platformOpenCommand } from "./opener.ts";

/** Port the bridge asks for a hub on, instead of the protocol's default. */
export const HUB_PORT_ENV = "CO_CANVAS_HUB_PORT";
/** Command the bridge starts a hub with, as a JSON array. */
export const HUB_CMD_ENV = "CO_CANVAS_HUB_CMD";
/** Command the bridge opens a board URL with, as a JSON array. */
export const OPEN_CMD_ENV = "CO_CANVAS_OPEN_CMD";

/** The requested hub port, or `undefined` to leave the choice to hub-client. */
export function resolveHubPort(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[HUB_PORT_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;

  const port = Number(raw);
  // Loud rather than ignored: a typo here would otherwise send every tool call
  // to the default port and look like the hub had moved.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${HUB_PORT_ENV} must be a TCP port number, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * The command that starts a hub.
 *
 * Called when a hub is actually needed rather than at startup, because the
 * default resolution can fail — an `apps/hub-cli` nobody has built yet has no
 * entry point to name — and that failure belongs in the answer to a tool call.
 * A bridge that refused to start over it would also lose the ability to find a
 * hub that is already running, which needs no command at all.
 */
export function resolveHubCommand(env: NodeJS.ProcessEnv): CommandSpec {
  const raw = env[HUB_CMD_ENV];
  if (raw !== undefined && raw.trim() !== "") return parseCommandSpec(raw);
  return { executable: process.execPath, args: [hubCliEntry()] };
}

/** The command that opens a board URL. */
export function resolveOpenCommand(env: NodeJS.ProcessEnv): CommandSpec {
  const raw = env[OPEN_CMD_ENV];
  if (raw !== undefined && raw.trim() !== "") return parseCommandSpec(raw);
  return platformOpenCommand();
}

/**
 * Path of the built hub entry point.
 *
 * `createRequire().resolve` rather than `import.meta.resolve`: the former
 * throws `MODULE_NOT_FOUND` when the file is not there, which is the actionable
 * "build it, or name your own command" error. The latter hands back a `file://`
 * URL for a path that does not exist, turning an unbuilt `dist` into a spawn
 * failure several seconds and one confusing message later.
 *
 * How the hub finally ships is CC-6's decision; this default is provisional and
 * deliberately overridable.
 */
function hubCliEntry(): string {
  try {
    return createRequire(import.meta.url).resolve("@co-canvas/hub-cli/dist/main.js");
  } catch (error) {
    throw new Error(
      "cannot find the co-canvas hub entry point (@co-canvas/hub-cli/dist/main.js)." +
        ` Build the workspace with \`pnpm build\`, or name a hub command in ${HUB_CMD_ENV}` +
        " as a JSON array of the executable and its arguments",
      { cause: error },
    );
  }
}
