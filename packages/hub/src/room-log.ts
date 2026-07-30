import { appendFile, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomSlug } from "@co-canvas/protocol";
import * as Y from "yjs";
import {
  decodeHeader,
  encodeFrame,
  encodeHeader,
  LOG_HEADER_BYTES,
  parseFrames,
} from "./log-format";

/** Subdirectory of the data directory holding one log per board. */
export const ROOMS_DIR_NAME = "rooms";
/** Suffix that makes a file a board. Nothing else in the directory counts. */
export const LOG_SUFFIX = ".log";
/** Compaction scratch, renamed over the log to publish it. */
export const TEMP_SUFFIX = ".log.tmp";
/** Prefix of the untouched original kept when a log is unreadable. */
export const CORRUPT_INFIX = ".log.corrupt.";

export function roomsDir(dataDir: string): string {
  return join(dataDir, ROOMS_DIR_NAME);
}

export function roomLogPath(dataDir: string, slug: RoomSlug): string {
  return join(roomsDir(dataDir), `${slug}${LOG_SUFFIX}`);
}

function tempPath(dataDir: string, slug: RoomSlug): string {
  return join(roomsDir(dataDir), `${slug}${TEMP_SUFFIX}`);
}

function corruptPath(dataDir: string, slug: RoomSlug, at: number): string {
  return join(roomsDir(dataDir), `${slug}${CORRUPT_INFIX}${at}`);
}

/** How a log arrived: intact, with a tail cut off, or salvaged from a rejection. */
export type LogRepair = "none" | "truncated" | "quarantined";

export interface LoadedRoomLog {
  createdAt: number;
  /** Everything the log adds up to, ready to apply. `null` when it holds nothing. */
  state: Uint8Array | null;
  /** Size of the log on disk once any repair is done. */
  bytes: number;
  /** Frames the log holds once any repair is done. */
  frames: number;
  /** Payload bytes beyond what a snapshot of the same content would cost. */
  appended: number;
  /** What a snapshot of this content costs — the baseline compaction measures against. */
  snapshotBytes: number;
  repair: LogRepair;
}

export interface Replay {
  /** State of the frames that applied cleanly, or `null` when none did. */
  state: Uint8Array | null;
  /** Index of the first frame the CRDT rejected, or `-1` when all applied. */
  rejectedAt: number;
}

/**
 * Turns a log's frames into the document state they describe.
 *
 * A rejected `Y.applyUpdate` can leave its target already mutated — measured
 * over the truncation offsets of one update, a minority of them bake dozens of
 * foreign keys into the document before throwing. So the good prefix is replayed
 * into a *fresh* document and the one that saw the bad frame is discarded;
 * keeping the contaminated document would write half a rejected update into the
 * board permanently, because recovery rewrites the log from whatever it decides
 * the state is.
 *
 * Frames after the rejected one are dropped rather than tried: the log is a
 * sequence, and skipping a hole in the middle of it would open the room in a
 * state no client ever had.
 */
export function replayFrames(frames: readonly Uint8Array[]): Replay {
  const scratch = new Y.Doc();
  let applied = 0;
  let rejectedAt = -1;

  try {
    for (const [index, frame] of frames.entries()) {
      try {
        Y.applyUpdate(scratch, frame);
      } catch {
        // Never matched on the error: the same corruption surfaces as both
        // `Unexpected end of array` and a TypeError from lib0's lookup table,
        // so anything thrown means the same thing here.
        rejectedAt = index;
        break;
      }
      applied = index + 1;
    }
    if (rejectedAt === -1) {
      return { state: applied === 0 ? null : Y.encodeStateAsUpdate(scratch), rejectedAt };
    }
  } finally {
    scratch.destroy();
  }

  const clean = new Y.Doc();
  try {
    for (const frame of frames.slice(0, applied)) Y.applyUpdate(clean, frame);
    return { state: applied === 0 ? null : Y.encodeStateAsUpdate(clean), rejectedAt };
  } finally {
    clean.destroy();
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Writes a whole log to the scratch sibling and renames it over the target. */
export async function publishLog(
  dataDir: string,
  slug: RoomSlug,
  createdAt: number,
  state: Uint8Array | null,
): Promise<number> {
  const parts = [encodeHeader(createdAt)];
  if (state !== null && state.byteLength > 0) parts.push(encodeFrame(state));
  const bytes = Buffer.concat(parts);

  // Never truncate-then-write the live path: a process that died between the
  // two would leave the board as an empty file, and a reader that arrived in
  // between would see one.
  await writeFile(tempPath(dataDir, slug), bytes);
  await rename(tempPath(dataDir, slug), roomLogPath(dataDir, slug));
  return bytes.length;
}

/** Adds one frame to the end of a log and reports the bytes it cost. */
export async function appendToLog(
  dataDir: string,
  slug: RoomSlug,
  payload: Uint8Array,
): Promise<number> {
  const frame = encodeFrame(payload);
  await appendFile(roomLogPath(dataDir, slug), frame);
  return frame.length;
}

/**
 * Opens a room's log, repairing it in place when it needs it.
 *
 * A torn tail is cut off the file, not merely skipped in memory: skipping it
 * and then appending would bury the garbage in the middle of the log, where the
 * next open cannot tell it from a rejected frame.
 */
export async function loadRoomLog(
  dataDir: string,
  slug: RoomSlug,
  now: number = Date.now(),
): Promise<LoadedRoomLog> {
  const path = roomLogPath(dataDir, slug);

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    // A board nobody has opened before. Its log is published empty so that the
    // board exists on disk — and therefore in the index — from the moment it is
    // named, rather than only once somebody draws on it.
    await writeFile(path, encodeHeader(now));
    return {
      createdAt: now,
      state: null,
      bytes: LOG_HEADER_BYTES,
      frames: 0,
      appended: 0,
      snapshotBytes: 0,
      repair: "none",
    };
  }

  const header = decodeHeader(bytes);
  if (header === null) return await quarantine(dataDir, slug, bytes, now, now, null);

  const parsed = parseFrames(bytes);
  const replay = replayFrames(parsed.frames);

  if (replay.rejectedAt !== -1) {
    return await quarantine(dataDir, slug, bytes, header.createdAt, now, replay.state);
  }

  if (parsed.torn) await truncate(path, parsed.end);

  const snapshotBytes = replay.state?.byteLength ?? 0;
  const payloadBytes = parsed.frames.reduce((total, frame) => total + frame.byteLength, 0);
  return {
    createdAt: header.createdAt,
    state: replay.state,
    bytes: parsed.end,
    frames: parsed.frames.length,
    // What the log costs over the snapshot it could be collapsed to. Carrying
    // it across a restart is what stops a log that is already bloated from
    // waiting for another 64 KiB before anyone notices.
    appended: Math.max(0, payloadBytes - snapshotBytes),
    snapshotBytes,
    repair: parsed.torn ? "truncated" : "none",
  };
}

/**
 * Preserves an unreadable log untouched and republishes it from what could be
 * salvaged, so the room stays writable instead of being lost or reopened onto a
 * file that will fail again.
 */
async function quarantine(
  dataDir: string,
  slug: RoomSlug,
  original: Buffer,
  createdAt: number,
  now: number,
  state: Uint8Array | null,
): Promise<LoadedRoomLog> {
  await writeFile(corruptPath(dataDir, slug, now), original);
  const bytes = await publishLog(dataDir, slug, createdAt, state);
  const snapshotBytes = state?.byteLength ?? 0;
  return {
    createdAt,
    state,
    bytes,
    frames: snapshotBytes > 0 ? 1 : 0,
    appended: 0,
    snapshotBytes,
    repair: "quarantined",
  };
}
