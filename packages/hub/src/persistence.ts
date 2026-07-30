import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import type { RoomSlug } from "@co-canvas/protocol";
import * as Y from "yjs";
import type { RoomIndexEntry } from "./room-index";
import { rebuildRoomIndex, writeRoomIndex } from "./room-index";
import { appendToLog, loadRoomLog, publishLog, roomsDir } from "./room-log";

/**
 * Quiet period after the last edit before a room's buffer reaches disk.
 *
 * This is a data-loss window by design: a `SIGKILL` inside it costs whatever
 * was drawn during it. Appending every update instead would close the window
 * and grow the log several times faster, and every graceful exit — `stop()`,
 * eviction — flushes the buffer anyway.
 */
export const DEBOUNCE_MS = 250;
/** Hard ceiling on the debounce, so continuous drawing still reaches disk. */
export const MAX_DEBOUNCE_MS = 2000;
/** Floor under compaction: below this the rewrite costs more than it saves. */
export const COMPACT_MIN_APPENDED_BYTES = 64 * 1024;
/** Appends have to outgrow the snapshot by this factor as well as clearing the floor. */
export const COMPACT_GROWTH_FACTOR = 2;

/**
 * Origin marker on the updates the loader applies.
 *
 * Without it the update handler would append everything it had just read
 * straight back into the log, doubling the file on every hub restart.
 */
export const LOAD_ORIGIN = Symbol("co-canvas/persistence/load");

/** The disk side of one live room. */
export interface RoomStore {
  /**
   * Writes the buffer out, collapses the log to a snapshot when it is worth it
   * and stops following the document.
   *
   * Must run while the document is still alive: the snapshot can only be taken
   * from it, and `Y.Doc.destroy()` takes that away.
   */
  close(): Promise<void>;
}

export interface Persistence {
  readonly dataDir: string;
  /** Creates the data directory, proves it writable and rebuilds the index. */
  prepare(): Promise<void>;
  /**
   * Loads what `slug` holds on disk into `doc` and starts persisting it.
   *
   * Resolves only once the document carries the persisted state, so a caller
   * that awaits this can serve the connection without ever showing a peer an
   * empty board that fills in a moment later.
   */
  openRoom(slug: RoomSlug, doc: Y.Doc): Promise<RoomStore>;
  /** Publishes anything the index still owes. */
  settle(): Promise<void>;
}

interface LogState {
  createdAt: number;
  bytes: number;
  frames: number;
  appended: number;
  snapshotBytes: number;
}

export function createPersistence(dataDir: string): Persistence {
  const entries = new Map<RoomSlug, RoomIndexEntry>();

  // The index is a cache of the logs, so its writes are coalesced rather than
  // ordered against them: a flush that lands while a write is in flight simply
  // marks the index dirty again.
  let indexTask: Promise<void> = Promise.resolve();
  let indexDirty = false;

  async function writeIfDirty(): Promise<void> {
    if (!indexDirty) return;
    indexDirty = false;
    await writeRoomIndex(dataDir, entries.values());
  }

  function touchIndex(entry: RoomIndexEntry): void {
    entries.set(entry.slug, entry);
    indexDirty = true;
    // A failed index write is not data loss — the logs are the truth and the
    // next start rebuilds from them — so it must not surface as an unhandled
    // rejection from a chain nobody awaits.
    indexTask = indexTask.then(writeIfDirty, writeIfDirty).catch(() => {});
  }

  async function prepare(): Promise<void> {
    await mkdir(roomsDir(dataDir), { recursive: true });
    // Proved usable now rather than at the first stroke of a drawing session:
    // a hub that cannot persist is a cache pretending to be a hub.
    await access(roomsDir(dataDir), constants.W_OK);

    entries.clear();
    for (const [slug, entry] of await rebuildRoomIndex(dataDir)) entries.set(slug, entry);
    // Also the writability probe for the data directory itself.
    await writeRoomIndex(dataDir, entries.values());
  }

  async function openRoom(slug: RoomSlug, doc: Y.Doc): Promise<RoomStore> {
    const loaded = await loadRoomLog(dataDir, slug);

    const state: LogState = {
      createdAt: loaded.createdAt,
      bytes: loaded.bytes,
      frames: loaded.frames,
      appended: loaded.appended,
      snapshotBytes: loaded.snapshotBytes,
    };

    const known = entries.get(slug);
    touchIndex({
      slug,
      createdAt: state.createdAt,
      // Opening a log is not writing to it, so a plain load keeps whatever the
      // index already knew about the last write.
      updatedAt: loaded.repair === "none" ? (known?.updatedAt ?? state.createdAt) : Date.now(),
      bytes: state.bytes,
    });

    const pending: Uint8Array[] = [];
    let quiet: NodeJS.Timeout | null = null;
    let ceiling: NodeJS.Timeout | null = null;
    let closed = false;
    let chain: Promise<void> = Promise.resolve();

    function serialise(task: () => Promise<void>): Promise<void> {
      // One writer per log: an append interleaved with a compaction would
      // publish a snapshot that silently dropped it.
      const result = chain.then(task, task);
      chain = result.then(
        () => {},
        () => {},
      );
      return result;
    }

    function disarm(): void {
      if (quiet !== null) clearTimeout(quiet);
      if (ceiling !== null) clearTimeout(ceiling);
      quiet = null;
      ceiling = null;
    }

    function fire(): void {
      disarm();
      // Nothing awaits a timer. A failed write leaves the batch buffered for
      // the next attempt — `close()` is the path that reports failures.
      void serialise(persist).catch(() => {});
    }

    function arm(): void {
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(fire, DEBOUNCE_MS);
      if (ceiling === null) ceiling = setTimeout(fire, MAX_DEBOUNCE_MS);
    }

    async function flushPending(): Promise<void> {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      const merged = batch.length === 1 ? (batch[0] as Uint8Array) : Y.mergeUpdates(batch);
      if (merged.byteLength === 0) return;

      try {
        state.bytes += await appendToLog(dataDir, slug, merged);
      } catch (error) {
        pending.unshift(merged);
        throw error;
      }
      state.frames += 1;
      state.appended += merged.byteLength;
      touchIndex({
        slug,
        createdAt: state.createdAt,
        updatedAt: Date.now(),
        bytes: state.bytes,
      });
    }

    async function compact(): Promise<void> {
      // A snapshot is smaller than the merged log, which is smaller than the
      // frames it collapses, and it preserves deletions — so it is the right
      // thing to rewrite the log as.
      const snapshot = Y.encodeStateAsUpdate(doc);
      state.bytes = await publishLog(dataDir, slug, state.createdAt, snapshot);
      state.frames = 1;
      state.appended = 0;
      state.snapshotBytes = snapshot.byteLength;
      touchIndex({
        slug,
        createdAt: state.createdAt,
        updatedAt: Date.now(),
        bytes: state.bytes,
      });
    }

    async function persist(): Promise<void> {
      await flushPending();
      // Both conditions, not either: a big board legitimately produces big
      // appends, and rewriting it every time they cleared a fixed floor would
      // make the log cost what it exists to avoid.
      const outgrown =
        state.appended > COMPACT_MIN_APPENDED_BYTES &&
        state.appended > COMPACT_GROWTH_FACTOR * state.snapshotBytes;
      if (outgrown) await compact();
    }

    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === LOAD_ORIGIN) return;
      if (closed) return;
      pending.push(update);
      arm();
    };

    // Attached before the load, so the origin marker below is what keeps the
    // loaded state out of the log rather than the order these two lines happen
    // to be in. Without the marker every restart would append everything it had
    // just read, doubling the file each time.
    doc.on("update", onUpdate);
    if (loaded.state !== null) Y.applyUpdate(doc, loaded.state, LOAD_ORIGIN);

    return {
      async close(): Promise<void> {
        if (closed) return;
        // The snapshot below can only come from a live document. Yjs happens to
        // leave a destroyed one's contents readable, so a caller that destroyed
        // the room first would work by accident until that stopped being true —
        // and then silently write an empty board over a real one.
        if (doc.isDestroyed) {
          throw new Error(`room ${slug}: cannot write out a destroyed document`);
        }
        closed = true;
        disarm();
        doc.off("update", onUpdate);
        await serialise(async () => {
          // The buffer goes out before anything else touches the room: a peer
          // that closed the tab mid-stroke left its last edit in here.
          await flushPending();
          // A log already down to one frame is in the shape compaction would
          // put it in, so leaving it alone keeps a room that was only read
          // byte-identical on disk.
          if (state.frames > 1) await compact();
        });
      },
    };
  }

  async function settle(): Promise<void> {
    await indexTask;
    await writeIfDirty();
  }

  return { dataDir, prepare, openRoom, settle };
}
