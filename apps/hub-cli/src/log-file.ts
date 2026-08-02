import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

/** File inside the data directory the hub appends its lifecycle events to. */
export const HUB_LOG_FILENAME = "hub.log";

/** Absolute path of the log inside `dataDir`. */
export function hubLogPath(dataDir: string): string {
  return join(dataDir, HUB_LOG_FILENAME);
}

/**
 * Appends one timestamped line to `hub.log`, never throwing.
 *
 * The data directory is left to `hub.start()` to create, after the port is
 * bound — so a log written before a successful bind would create a directory a
 * losing port race has to leave pristine (R1). See {@link noteLogFailure} for
 * how the two kinds of write failure differ.
 */
export async function appendHubLog(dataDir: string, message: string): Promise<void> {
  try {
    await appendFile(hubLogPath(dataDir), formatLine(message), "utf8");
  } catch (error) {
    noteLogFailure(error);
  }
}

/**
 * The synchronous twin, for the two paths that cannot await: the crash handler
 * and the `process.on("exit")` backstop, both of which run as the process is
 * already on its way down.
 */
export function appendHubLogSync(dataDir: string, message: string): void {
  try {
    appendFileSync(hubLogPath(dataDir), formatLine(message), "utf8");
  } catch (error) {
    noteLogFailure(error);
  }
}

/**
 * Decides what to do with a failed log write. Never throws — logging must not be
 * able to crash the hub.
 *
 * `ENOENT` is the expected, deliberate case: the data directory is absent
 * because the hub has not bound yet, and the log never creates one (R1). It
 * stays silent. Every other code — an existing but unwritable directory, so
 * `EACCES`, `ENOSPC` and the like — is a diagnostic that would otherwise vanish
 * with no trace, which is exactly what R5 exists to prevent. It is surfaced
 * best-effort to stderr: an operator watching sees it, and when stderr is
 * discarded (as `findOrStartHub` spawns the hub) the write is a no-op and the
 * behaviour is identical to swallowing it.
 */
function noteLogFailure(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  try {
    process.stderr.write(`co-canvas hub: could not write ${HUB_LOG_FILENAME}: ${String(error)}\n`);
  } catch {
    // stderr itself is gone — nothing more can be done, and still nothing thrown.
  }
}

function formatLine(message: string): string {
  return `${new Date().toISOString()} ${message}\n`;
}
