import { open, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomSlug } from "@co-canvas/protocol";
import { isRoomSlug } from "@co-canvas/protocol";
import { decodeHeader, LOG_HEADER_BYTES } from "./log-format";
import { LOG_SUFFIX, roomsDir } from "./room-log";

/** Name of the derived index sitting beside the `rooms/` directory. */
export const INDEX_FILENAME = "rooms.json";
export const INDEX_TEMP_FILENAME = "rooms.json.tmp";
/** Shape version of the index document. */
export const INDEX_VERSION = 1;

/** What the index records about one board. */
export interface RoomIndexEntry {
  slug: RoomSlug;
  /** When the board was first written, from its log header. */
  createdAt: number;
  /** When it was last written. */
  updatedAt: number;
  /** Size of its log on disk. */
  bytes: number;
}

export function indexPath(dataDir: string): string {
  return join(dataDir, INDEX_FILENAME);
}

/**
 * Rebuilds the index by looking at the logs.
 *
 * Every field the index holds comes from a log file, so this is the whole truth
 * and the index itself is only a cache of it. That is also why the hub rebuilds
 * on every start rather than trusting what it finds: a crash between creating a
 * log and publishing the index would otherwise hide that board for good, and
 * reading the header of each log costs 14 bytes per board.
 */
export async function rebuildRoomIndex(dataDir: string): Promise<Map<RoomSlug, RoomIndexEntry>> {
  const entries = new Map<RoomSlug, RoomIndexEntry>();

  let names: string[];
  try {
    names = await readdir(roomsDir(dataDir));
  } catch {
    return entries;
  }

  for (const name of names) {
    if (!name.endsWith(LOG_SUFFIX)) continue;
    const slug = name.slice(0, -LOG_SUFFIX.length);
    // `alpha.log.tmp` and `alpha.log.corrupt.1700000000000` both fail the suffix
    // test above; the slug test additionally refuses anything a client could
    // never have addressed, so no artefact surfaces as a phantom board.
    if (!isRoomSlug(slug)) continue;

    const path = join(roomsDir(dataDir), name);
    let size: number;
    let modified: number;
    try {
      const stats = await stat(path);
      if (!stats.isFile()) continue;
      size = stats.size;
      modified = Math.round(stats.mtimeMs);
    } catch {
      continue;
    }

    entries.set(slug, {
      slug,
      createdAt: (await readCreatedAt(path)) ?? modified,
      updatedAt: modified,
      bytes: size,
    });
  }

  return entries;
}

/**
 * Reads the creation time out of a log's header without touching its frames.
 *
 * Creation time lives in the header rather than only in the index precisely so
 * that it survives a rebuild — the filesystem's own timestamps do not, since a
 * copied or restored directory carries whatever times the copy produced.
 */
async function readCreatedAt(path: string): Promise<number | null> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(LOG_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, LOG_HEADER_BYTES, 0);
    return decodeHeader(header.subarray(0, bytesRead))?.createdAt ?? null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Publishes the index by renaming a sibling over it, never in place. */
export async function writeRoomIndex(
  dataDir: string,
  entries: Iterable<RoomIndexEntry>,
): Promise<void> {
  const rooms = [...entries].sort((left, right) => left.slug.localeCompare(right.slug));
  const document = JSON.stringify({ version: INDEX_VERSION, rooms }, null, 2);
  const temporary = join(dataDir, INDEX_TEMP_FILENAME);
  await writeFile(temporary, document);
  await rename(temporary, indexPath(dataDir));
}
