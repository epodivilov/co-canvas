import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_NAME, PROTOCOL_VERSION } from "@co-canvas/protocol";

/** File inside the data directory where a running hub records itself. */
export const HUB_LOCK_FILENAME = "hub.lock";

/**
 * What a running hub claims about itself.
 *
 * The pid is advisory: it is written by a process that was alive at the time and
 * may since have died and had its number reused. Only the health endpoint says
 * whether the hub is there, so nothing in this package ever signals this pid.
 */
export interface HubLock {
  /** Pid of the hub process at the time it bound its port. */
  pid: number;
  /** Port the hub bound. */
  port: number;
  /** Wire format the hub speaks. */
  protocol: number;
  /** ISO-8601 timestamp of the successful bind. */
  startedAt: string;
}

/** The parts a hub has to supply; the rest is filled in from the current process. */
export interface HubLockClaim {
  port: number;
  pid?: number;
  protocol?: number;
  startedAt?: string;
}

/** `~/.co-canvas` — the default home of the lockfile and of room data. */
export function defaultDataDir(): string {
  return join(homedir(), DATA_DIR_NAME);
}

/** Absolute path of the lockfile inside `dataDir`. */
export function hubLockPath(dataDir: string): string {
  return join(dataDir, HUB_LOCK_FILENAME);
}

/**
 * Records a live hub.
 *
 * Only the hub process itself may call this, and only once its port is bound: a
 * client that wrote a claim after spawning would record a pid it does not own,
 * and would keep recording it when that child lost the port race and died — a
 * file confidently describing a corpse.
 */
export async function writeHubLock(dataDir: string, claim: HubLockClaim): Promise<HubLock> {
  const entry: HubLock = {
    pid: claim.pid ?? process.pid,
    port: claim.port,
    protocol: claim.protocol ?? PROTOCOL_VERSION,
    startedAt: claim.startedAt ?? new Date().toISOString(),
  };

  await mkdir(dataDir, { recursive: true });
  // Written aside and renamed into place: a reader that catches the file
  // mid-write would parse half a JSON object, and `readHubLock` would report no
  // hub at all for a hub that is running perfectly well.
  const target = hubLockPath(dataDir);
  const staging = `${target}.${entry.pid}.tmp`;
  await writeFile(staging, `${JSON.stringify(entry)}\n`, "utf8");
  await rename(staging, target);
  return entry;
}

/**
 * Reads the recorded hub, or `null` when there is nothing usable to read.
 *
 * Absent, empty, truncated and hand-edited files all mean the same thing to a
 * caller — no claim — and none of them is worth an exception: this is asked on
 * the way to "should I start a hub", which has an answer either way.
 */
export async function readHubLock(dataDir: string): Promise<HubLock | null> {
  let text: string;
  try {
    text = await readFile(hubLockPath(dataDir), "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return toHubLock(parsed);
}

/** Removes the lockfile. Succeeds when there is none. */
export async function clearHubLock(dataDir: string): Promise<void> {
  try {
    await unlink(hubLockPath(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function toHubLock(value: unknown): HubLock | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const { pid, port, protocol, startedAt } = record;
  if (!isPositiveInteger(pid) || !isPort(port)) return null;
  if (typeof protocol !== "number" || !Number.isInteger(protocol)) return null;
  if (typeof startedAt !== "string" || startedAt === "") return null;

  return { pid, port, protocol, startedAt };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65535;
}
