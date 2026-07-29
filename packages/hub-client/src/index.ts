/**
 * The one place that answers "is a co-canvas hub already running, and if not,
 * start one".
 *
 * A library with no CLI and no side effects on import: the MCP bridge and the
 * desktop shell both need this logic, and written twice it would drift.
 *
 * Relative imports inside this package carry their `.ts` extension because the
 * package ships as source and real processes — the fixtures, and later the MCP
 * bridge running under `node --experimental-strip-types` — load it through plain
 * Node, whose resolver does not guess extensions.
 */
export { HubClientError, type HubClientErrorCode } from "./errors.ts";
export {
  DEFAULT_STARTUP_TIMEOUT_MS,
  type FindHubOptions,
  type FindOrStartHubOptions,
  findHub,
  findOrStartHub,
  HUB_DATA_DIR_ENV,
  HUB_PORT_ENV,
  type HubInfo,
} from "./find.ts";
export {
  clearHubLock,
  defaultDataDir,
  HUB_LOCK_FILENAME,
  type HubLock,
  type HubLockClaim,
  hubLockPath,
  readHubLock,
  writeHubLock,
} from "./lockfile.ts";
export { DEFAULT_PROBE_TIMEOUT_MS, type HubProbe, probeHub } from "./probe.ts";
