import type { RoomSlug } from "@co-canvas/protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";

/**
 * Every frame is a varUint message type followed by a type-specific payload.
 * These two values are the wire contract `y-websocket` clients already speak.
 */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** One WebSocket peer attached to a room. */
export interface Connection {
  readonly socket: WebSocket;
  /**
   * Awareness client ids this socket introduced. Kept per connection so the
   * room can retract exactly those states when the socket goes away — a peer
   * that crashes never sends a farewell of its own.
   */
  readonly controlledIds: Set<number>;
}

/** A live board: one shared document plus the awareness state of its peers. */
export interface Room {
  readonly slug: RoomSlug;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly connections: Set<Connection>;
  /**
   * Called after a peer joins or leaves. The registry arms and disarms idle
   * eviction from it, which is why the room reports the change rather than the
   * registry polling for it.
   */
  readonly onPeersChanged: ((room: Room) => void) | null;
}

/**
 * Builds an empty room and wires its fan-out.
 *
 * Both listeners are registered once per room rather than per connection, so
 * the cost of an extra peer is one `Set` entry.
 */
export function createRoom(
  slug: RoomSlug,
  onPeersChanged: ((room: Room) => void) | null = null,
): Room {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // `Awareness` publishes an empty local state on construction. The hub is not
  // a peer, so it retracts it — otherwise every room shows a phantom cursor.
  awareness.setLocalState(null);

  const connections = new Set<Connection>();
  const room: Room = { slug, doc, awareness, connections, onPeersChanged };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const connection of connections) {
      // The originating peer already has this update; echoing it back would
      // bounce between the two of them.
      if (connection === origin) continue;
      send(connection, message);
    }
  });

  awareness.on(
    "update",
    (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const { added, updated, removed } = changes;
      // The origin is a connection exactly when it is one of ours; the hub's own
      // retractions come through with a `null` origin and own no client ids.
      const source = origin as Connection;
      if (connections.has(source)) {
        for (const clientId of added) source.controlledIds.add(clientId);
        for (const clientId of removed) source.controlledIds.delete(clientId);
      }

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
      );
      const message = encoding.toUint8Array(encoder);
      // Unlike document updates, awareness goes back to the sender too: the
      // hub's view is authoritative and the sender must see it converge.
      for (const connection of connections) send(connection, message);
    },
  );

  return room;
}

/**
 * Puts a freshly upgraded socket into a room and starts the sync handshake.
 */
export function attachConnection(room: Room, socket: WebSocket): void {
  const connection: Connection = { socket, controlledIds: new Set() };
  room.connections.add(connection);
  room.onPeersChanged?.(room);

  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    handleMessage(room, connection, toBytes(data));
  });

  socket.on("close", () => {
    room.connections.delete(connection);
    // `null` origin: this is the hub retracting states, not a peer update, so
    // the retraction is broadcast to everyone still in the room.
    removeAwarenessStates(room.awareness, [...connection.controlledIds], null);
    connection.controlledIds.clear();
    room.onPeersChanged?.(room);
  });

  socket.on("error", () => {
    socket.close();
  });

  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
  writeSyncStep1(syncEncoder, room.doc);
  send(connection, encoding.toUint8Array(syncEncoder));

  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      encodeAwarenessUpdate(room.awareness, [...states.keys()]),
    );
    send(connection, encoding.toUint8Array(awarenessEncoder));
  }
}

function handleMessage(room: Room, connection: Connection, message: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(message);
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        // The origin must be the connection itself so `doc.on('update')` can
        // recognise and skip it.
        readSyncMessage(decoder, encoder, room.doc, connection);
        // Only step 1 asks for an answer. Replying unconditionally makes two
        // peers trade bare message-type bytes forever.
        if (encoding.length(encoder) > 1) send(connection, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), connection);
        break;
      }
      default:
        // A newer client may speak message types this hub does not know yet;
        // ignoring them is friendlier than dropping the connection.
        break;
    }
  } catch {
    // A malformed frame is the peer's problem, never the room's.
    connection.socket.close(1003, "malformed message");
  }
}

function send(connection: Connection, message: Uint8Array): void {
  const { socket } = connection;
  // `handleUpgrade` only ever hands over an already-open socket, so anything
  // other than OPEN means the peer is on its way out.
  if (socket.readyState !== WebSocket.OPEN) {
    socket.close();
    return;
  }
  try {
    // `ws` signals success by calling back with `null`, not `undefined`, so the
    // argument is tested for truthiness rather than compared against undefined.
    socket.send(message, (error) => {
      if (error) socket.close();
    });
  } catch {
    socket.close();
  }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
