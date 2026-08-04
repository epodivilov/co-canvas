import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomSlug } from "@co-canvas/protocol";
import { isRoomSlug } from "@co-canvas/protocol";

/**
 * Name of the durable metadata document sitting beside `rooms.json`.
 *
 * Unlike `rooms.json`, this is *not* a cache of the logs: a board's title and
 * archived flag live nowhere in the Yjs log, so if they lived only in the
 * log-derived index the hub's rebuild-on-start would erase them. This file is
 * the one place they survive that rebuild.
 */
export const METADATA_FILENAME = "rooms-metadata.json";
export const METADATA_TEMP_FILENAME = "rooms-metadata.json.tmp";
/** Shape version of the metadata document. */
export const METADATA_VERSION = 1;

/** The human metadata one board carries, absent from its log. */
export interface RoomMetadata {
  /** The title a person gave the board, or `null` when it has none. */
  title: string | null;
  /** Whether the board has been archived out of the default overview. */
  archived: boolean;
}

function metadataPath(dataDir: string): string {
  return join(dataDir, METADATA_FILENAME);
}

/**
 * Reads the metadata store, keyed by slug.
 *
 * Total on purpose, like the index rebuild: a missing file, invalid JSON, or a
 * malformed entry yields an empty (or partial) map rather than an error. The
 * logs and the index are the durability path for a board's *existence*; this
 * file only decorates them, so a store this build cannot read should degrade to
 * "no titles, nothing archived" rather than refuse to start the hub.
 */
export async function readRoomMetadata(dataDir: string): Promise<Map<RoomSlug, RoomMetadata>> {
  const entries = new Map<RoomSlug, RoomMetadata>();

  let raw: string;
  try {
    raw = await readFile(metadataPath(dataDir), "utf8");
  } catch {
    return entries;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return entries;
  }

  const rooms = (parsed as { rooms?: unknown }).rooms;
  if (rooms === null || typeof rooms !== "object") return entries;

  for (const [slug, value] of Object.entries(rooms as Record<string, unknown>)) {
    // A key no client could ever have addressed is not a board, so any metadata
    // filed under it is an artefact and dropped.
    if (!isRoomSlug(slug)) continue;
    if (value === null || typeof value !== "object") continue;
    const record = value as { title?: unknown; archived?: unknown };
    entries.set(slug, {
      title: typeof record.title === "string" ? record.title : null,
      archived: record.archived === true,
    });
  }

  return entries;
}

/**
 * Publishes the metadata store by renaming a sibling over it, never in place —
 * the same tmp-then-rename `rooms.json` uses, so a concurrent list read never
 * observes a half-written store.
 */
export async function writeRoomMetadata(
  dataDir: string,
  entries: Map<RoomSlug, RoomMetadata>,
): Promise<void> {
  const rooms: Record<string, RoomMetadata> = {};
  for (const slug of [...entries.keys()].sort()) {
    const metadata = entries.get(slug);
    if (metadata !== undefined) rooms[slug] = metadata;
  }
  const document = JSON.stringify({ version: METADATA_VERSION, rooms }, null, 2);
  const temporary = join(dataDir, METADATA_TEMP_FILENAME);
  await writeFile(temporary, document);
  await rename(temporary, metadataPath(dataDir));
}
