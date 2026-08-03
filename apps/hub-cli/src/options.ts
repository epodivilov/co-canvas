import { defaultDataDir, HUB_DATA_DIR_ENV, HUB_PORT_ENV } from "@co-canvas/hub-client";
import { DEFAULT_PORT } from "@co-canvas/protocol";

/**
 * Default idle timeout: the hub exits after half an hour with no connected
 * peer. This is a *process-turnover* clock, deliberately distinct from the
 * hub library's per-room eviction period (`DEFAULT_IDLE_PERIOD_MS`, 60 s): a
 * measured idle hub costs almost nothing, so the period is chosen so that an
 * updated build can take over rather than to relieve any pressure. Do not merge
 * the two — they answer different questions.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** The configuration a run resolves to, once options, environment and defaults are folded together. */
export interface ResolvedOptions {
  /** Port to bind. `0` asks the OS for a free one. */
  port: number;
  /** Directory holding room data, the lockfile and the log. */
  dataDir: string;
  /** Milliseconds with no connected peer before the hub exits; `0` disables idle shutdown. */
  idleTimeoutMs: number;
  /** Directory of a prebuilt frontend to serve, overriding the one the build ships. */
  staticDir: string | undefined;
}

/** What `parseOptions` produces: a resolved configuration, a request for help, or a refusal. */
export type ParseResult =
  | { readonly kind: "options"; readonly options: ResolvedOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

/** Every option the CLI accepts, one per line, for `--help`. */
export const HELP_TEXT = `co-canvas-hub — run the co-canvas hub as a standalone process

Usage: co-canvas-hub [options]

Options:
  --port <number>        Port to bind (default ${DEFAULT_PORT}, 0 for an OS-assigned one).
                         Also read from ${HUB_PORT_ENV}; the option wins.
  --data-dir <path>      Directory for room data, the lockfile and the log
                         (default ~/.co-canvas). Also read from ${HUB_DATA_DIR_ENV};
                         the option wins.
  --idle-timeout <ms>    Exit after this many milliseconds with no connected peer
                         (default ${DEFAULT_IDLE_TIMEOUT_MS}, 30 minutes). 0 keeps the hub
                         running indefinitely.
  --static <dir>         Serve a prebuilt frontend from this directory instead of
                         the one the build ships.
  --help, -h             Show this help and exit.
`;

/** Options that take a value; the rest are flags. */
const VALUE_OPTIONS = new Set(["--port", "--data-dir", "--idle-timeout", "--static"]);

/**
 * Folds command-line arguments, the environment and the defaults into one
 * resolved configuration, most specific source first.
 *
 * Pure: it reads the arguments and the environment it is handed and returns a
 * verdict, touching neither the filesystem nor the process. A refusal names the
 * cause so the CLI can print it and exit non-zero without ever having created
 * the data directory.
 */
export function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): ParseResult {
  const raw: { port?: string; dataDir?: string; idleTimeout?: string; static?: string } = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;

    if (arg === "--help" || arg === "-h") return { kind: "help" };

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_OPTIONS.has(name)) {
      return { kind: "error", message: `unknown option ${JSON.stringify(arg)}` };
    }

    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined) return { kind: "error", message: `${name} requires a value` };
      value = next;
      index++;
    }

    if (name === "--port") raw.port = value;
    else if (name === "--data-dir") raw.dataDir = value;
    else if (name === "--idle-timeout") raw.idleTimeout = value;
    else raw.static = value;
  }

  const port = resolvePort(raw.port, env[HUB_PORT_ENV]);
  if (port.kind === "error") return port;

  const idleTimeoutMs = resolveIdleTimeout(raw.idleTimeout);
  if (idleTimeoutMs.kind === "error") return idleTimeoutMs;

  const dataDir = raw.dataDir ?? nonEmpty(env[HUB_DATA_DIR_ENV]) ?? defaultDataDir();

  return {
    kind: "options",
    options: {
      port: port.value,
      dataDir,
      idleTimeoutMs: idleTimeoutMs.value,
      staticDir: raw.static,
    },
  };
}

type Resolved = { kind: "value"; value: number } | { kind: "error"; message: string };

/** `--port` beats `CO_CANVAS_PORT` beats {@link DEFAULT_PORT}; a value that is not a port is fatal. */
function resolvePort(option: string | undefined, fromEnv: string | undefined): Resolved {
  if (option !== undefined) return parsePort(option, "--port");
  const env = nonEmpty(fromEnv);
  if (env !== undefined) return parsePort(env, HUB_PORT_ENV);
  return { kind: "value", value: DEFAULT_PORT };
}

function parsePort(raw: string, source: string): Resolved {
  const port = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
    return {
      kind: "error",
      message: `${source} must be a TCP port between 0 and 65535, got ${JSON.stringify(raw)}`,
    };
  }
  return { kind: "value", value: port };
}

function resolveIdleTimeout(option: string | undefined): Resolved {
  if (option === undefined) return { kind: "value", value: DEFAULT_IDLE_TIMEOUT_MS };
  const ms = Number(option);
  if (option.trim() === "" || !Number.isInteger(ms) || ms < 0) {
    return {
      kind: "error",
      message: `--idle-timeout must be a whole number of milliseconds (0 to disable), got ${JSON.stringify(option)}`,
    };
  }
  return { kind: "value", value: ms };
}

/** An environment variable a user set to the empty string is no value at all. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}
