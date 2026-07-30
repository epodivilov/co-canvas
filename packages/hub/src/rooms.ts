import type { RoomSlug } from "@co-canvas/protocol";
import * as Y from "yjs";
import type { Persistence, RoomStore } from "./persistence";
import type { Room } from "./sync";
import { createRoom } from "./sync";

/** What `/__rooms` reports for a single room. */
export interface RoomSummary {
  slug: RoomSlug;
  peers: number;
  docBytes: number;
}

export interface RoomRegistryOptions {
  persistence: Persistence;
  /** How long a room with no peers is kept in memory before it is released. */
  idlePeriodMs: number;
}

export interface RoomRegistry {
  /**
   * Returns the room for `slug`, reading it off disk on first use.
   *
   * Asynchronous because a room is only usable once its log has been applied:
   * a caller that served the connection first would show the peer an empty
   * board and fill it in a moment later.
   */
  obtain(slug: RoomSlug): Promise<Room>;
  /** Snapshot of every room in memory, cheap enough to call per request. */
  summarise(): RoomSummary[];
  /** Flushes every room to disk and then tears them all down. */
  shutdown(): Promise<void>;
}

/**
 * A slot is what the registry holds per slug. Opening and closing both take a
 * turn of the event loop, and a connect can arrive during either, so the states
 * are explicit rather than implied by a half-populated map entry.
 */
type Slot =
  | { readonly phase: "opening"; readonly ready: Promise<Room> }
  | {
      readonly phase: "open";
      readonly room: Room;
      readonly store: RoomStore;
      idle: NodeJS.Timeout | null;
    }
  | { readonly phase: "closing"; readonly done: Promise<void> };

/**
 * Holds the rooms the hub is serving.
 *
 * Rooms are read off disk when they are first asked for, released again once
 * nobody has been connected for the idle period, and flushed before either the
 * eviction or the shutdown that destroys them — a room whose debounce timer is
 * still armed when its last peer leaves would otherwise drop the last stroke of
 * a drawing session, which is exactly when a user closes the tab.
 */
export function createRoomRegistry(options: RoomRegistryOptions): RoomRegistry {
  const { persistence, idlePeriodMs } = options;
  const slots = new Map<RoomSlug, Slot>();

  function armIdle(slug: RoomSlug, slot: Extract<Slot, { phase: "open" }>): void {
    if (slot.idle !== null) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => {
      void evict(slug).catch(() => {});
    }, idlePeriodMs);
    // Eviction frees memory and tidies a log; it is not the durability path —
    // the debounce timer is, and that one stays referenced. So this timer must
    // not be a reason for a host process to stay alive.
    slot.idle.unref();
  }

  function disarmIdle(slot: Extract<Slot, { phase: "open" }>): void {
    if (slot.idle === null) return;
    clearTimeout(slot.idle);
    slot.idle = null;
  }

  function peersChanged(room: Room): void {
    const slot = slots.get(room.slug);
    if (slot?.phase !== "open" || slot.room !== room) return;
    if (room.connections.size > 0) disarmIdle(slot);
    else armIdle(room.slug, slot);
  }

  /** Flushes a room out and then takes its timers and listeners down. */
  async function closeSlot(slot: Extract<Slot, { phase: "open" }>): Promise<void> {
    disarmIdle(slot);
    try {
      // Strictly before the document is destroyed: the store's snapshot can
      // only be taken from a live `Y.Doc`.
      await slot.store.close();
    } finally {
      // Each room's `Awareness` runs a keepalive interval that only `destroy()`
      // clears, so a room left behind keeps the host process's event loop alive
      // after the hub has released its port.
      slot.room.awareness.destroy();
      slot.room.doc.destroy();
    }
  }

  async function evict(slug: RoomSlug): Promise<void> {
    const slot = slots.get(slug);
    if (slot?.phase !== "open") return;
    // A peer that reconnected between the timer firing and this running keeps
    // the room.
    if (slot.room.connections.size > 0) return;

    const done = closeSlot(slot).finally(() => {
      if (slots.get(slug)?.phase === "closing") slots.delete(slug);
    });
    slots.set(slug, { phase: "closing", done });
    await done;
  }

  async function openRoom(slug: RoomSlug): Promise<Room> {
    const room = createRoom(slug, peersChanged);
    let store: RoomStore;
    try {
      store = await persistence.openRoom(slug, room.doc);
    } catch (error) {
      room.awareness.destroy();
      room.doc.destroy();
      if (slots.get(slug)?.phase === "opening") slots.delete(slug);
      throw error;
    }

    const slot: Extract<Slot, { phase: "open" }> = { phase: "open", room, store, idle: null };
    slots.set(slug, slot);
    // Nothing is connected yet. The connect that asked for this room disarms it
    // a tick later; a room opened for any other reason is not kept forever.
    armIdle(slug, slot);
    return room;
  }

  return {
    async obtain(slug: RoomSlug): Promise<Room> {
      for (;;) {
        const slot = slots.get(slug);
        if (slot === undefined) break;
        if (slot.phase === "open") return slot.room;
        if (slot.phase === "opening") return await slot.ready;
        // The room is on its way out. Waiting and starting again is what makes
        // a reconnect during eviction read the freshly flushed log rather than
        // attach to a document that is about to be destroyed.
        await slot.done;
      }

      const ready = openRoom(slug);
      // Set before anything awaits `ready`, so a second connect for the same
      // slug in the same tick joins this open instead of starting another.
      slots.set(slug, { phase: "opening", ready });
      return await ready;
    },

    summarise(): RoomSummary[] {
      const summaries: RoomSummary[] = [];
      for (const slot of slots.values()) {
        if (slot.phase !== "open") continue;
        summaries.push({
          slug: slot.room.slug,
          peers: slot.room.connections.size,
          docBytes: Y.encodeStateAsUpdate(slot.room.doc).byteLength,
        });
      }
      return summaries;
    },

    async shutdown(): Promise<void> {
      // A room still being read off disk would otherwise finish after the sweep
      // below and be left holding its `Awareness` timer.
      for (;;) {
        const opening = [...slots.values()].flatMap((slot) =>
          slot.phase === "opening" ? [slot.ready] : [],
        );
        if (opening.length === 0) break;
        await Promise.allSettled(opening);
      }

      const closing: Promise<void>[] = [];
      for (const [slug, slot] of [...slots]) {
        if (slot.phase === "closing") {
          closing.push(slot.done);
          continue;
        }
        if (slot.phase !== "open") continue;
        // Unlike idle eviction this ignores whether peers are still listed: the
        // server has stopped and every socket has been sent away, and a peer
        // whose close event has not landed yet must not keep a room alive.
        const done = closeSlot(slot);
        slots.set(slug, { phase: "closing", done });
        closing.push(done);
      }

      const outcomes = await Promise.allSettled(closing);
      slots.clear();

      // Every room is down and the port is already back; a write that failed is
      // still worth reporting, so it goes out after the teardown, not instead
      // of it.
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed !== undefined) throw failed.reason;
    },
  };
}
