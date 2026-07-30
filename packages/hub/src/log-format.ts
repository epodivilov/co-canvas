/**
 * On-disk framing for a room's update log.
 *
 * A log is a fixed header followed by length-prefixed binary Yjs updates, one
 * after another. Appending an update costs the size of the edit; rewriting the
 * whole thing costs the size of the board — which is the entire reason the log
 * exists rather than a file holding one snapshot.
 *
 * The version byte here is the *file* format's, deliberately separate from
 * `PROTOCOL_VERSION`: the wire format and the storage format change for
 * different reasons and pinning them together would force a needless migration
 * every time either moves.
 */

/** ASCII marker every log starts with. */
export const LOG_MAGIC = "CCLOG";
/** Version of the layout described in this module. */
export const LOG_VERSION = 1;
/** Magic (5) + version (1) + creation time as big-endian u64 millis (8). */
export const LOG_HEADER_BYTES = 14;
/** Big-endian u32 payload length in front of every frame. */
export const FRAME_PREFIX_BYTES = 4;

export interface LogHeader {
  version: number;
  /** When the room was first written, in epoch milliseconds. */
  createdAt: number;
}

export function encodeHeader(createdAt: number): Buffer {
  const header = Buffer.alloc(LOG_HEADER_BYTES);
  header.write(LOG_MAGIC, 0, "ascii");
  header.writeUInt8(LOG_VERSION, LOG_MAGIC.length);
  header.writeBigUInt64BE(BigInt(Math.trunc(createdAt)), LOG_MAGIC.length + 1);
  return header;
}

/**
 * Reads a log's header, or `null` when these bytes are not a log this build can
 * read — too short, wrong marker, or a version from a future one.
 *
 * A `null` is never treated as "no data": the caller quarantines the file
 * untouched, so a log written by a newer hub survives being opened by an older
 * one.
 */
export function decodeHeader(bytes: Buffer): LogHeader | null {
  if (bytes.length < LOG_HEADER_BYTES) return null;
  if (bytes.subarray(0, LOG_MAGIC.length).toString("ascii") !== LOG_MAGIC) return null;
  const version = bytes.readUInt8(LOG_MAGIC.length);
  if (version !== LOG_VERSION) return null;
  return { version, createdAt: Number(bytes.readBigUInt64BE(LOG_MAGIC.length + 1)) };
}

export function encodeFrame(payload: Uint8Array): Buffer {
  const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
  prefix.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([prefix, payload]);
}

export interface ParsedFrames {
  frames: Uint8Array[];
  /** Offset one byte past the last complete frame. */
  end: number;
  /** Whether anything followed that last complete frame. */
  torn: boolean;
}

/**
 * Splits a log's frames off its header.
 *
 * Anything after the last complete frame — a partial length prefix, or a prefix
 * promising more bytes than the file holds — is reported as a torn tail rather
 * than thrown, because that is what a process killed mid-append leaves and it
 * is recoverable.
 *
 * Buffer reads go through `readUInt32BE` and `subarray` rather than indexing:
 * `noUncheckedIndexedAccess` makes every byte read a `number | undefined`.
 */
export function parseFrames(bytes: Buffer): ParsedFrames {
  const frames: Uint8Array[] = [];
  let offset = LOG_HEADER_BYTES;

  for (;;) {
    if (offset >= bytes.length) return { frames, end: offset, torn: offset > bytes.length };
    if (offset + FRAME_PREFIX_BYTES > bytes.length) return { frames, end: offset, torn: true };

    const length = bytes.readUInt32BE(offset);
    const start = offset + FRAME_PREFIX_BYTES;
    const finish = start + length;
    if (finish > bytes.length) return { frames, end: offset, torn: true };

    frames.push(bytes.subarray(start, finish));
    offset = finish;
  }
}
