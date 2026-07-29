import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Hub } from "./index";
import { createHub } from "./index";
import { createClientPool, toBytes, waitFor } from "./test-helpers";

/** Mirrors the hub's wire framing; the raw-socket scenario speaks it by hand. */
const MESSAGE_AWARENESS = 1;

describe("awareness", () => {
  const clients = createClientPool();
  let hub: Hub | null = null;

  afterEach(async () => {
    clients.closeAll();
    await hub?.stop();
    hub = null;
  });

  async function startHub(): Promise<string> {
    hub = createHub({ port: 0 });
    return await hub.start();
  }

  it("relays a peer's awareness state to the other peers of the room (R3)", async () => {
    const url = await startHub();

    const one = clients.open(url, "alpha");
    const two = clients.open(url, "alpha");
    await waitFor(() => one.provider.synced && two.provider.synced);

    one.provider.awareness.setLocalStateField("user", { name: "alice" });

    await waitFor(
      () => two.provider.awareness.getStates().get(one.doc.clientID)?.user?.name === "alice",
    );
    expect(two.provider.awareness.getStates().get(one.doc.clientID)?.user?.name).toBe("alice");
  });

  it("echoes an awareness update back to its own sender (R3)", async () => {
    const url = await startHub();

    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/sync/alpha`);
    const received: Uint8Array[] = [];
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      received.push(toBytes(data));
    });
    await waitFor(() => socket.readyState === WebSocket.OPEN);

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalStateField("user", { name: "raw" });

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [awareness.clientID]));
    received.length = 0;
    socket.send(encoding.toUint8Array(encoder));

    await waitFor(() => received.some((message) => message[0] === MESSAGE_AWARENESS));

    const [echoed] = received.filter((message) => message[0] === MESSAGE_AWARENESS);
    if (echoed === undefined) throw new Error("no awareness message was echoed back");

    const mirrorDoc = new Y.Doc();
    const mirror = new Awareness(mirrorDoc);
    const decoder = decoding.createDecoder(echoed);
    decoding.readVarUint(decoder);
    applyAwarenessUpdate(mirror, decoding.readVarUint8Array(decoder), "test");
    expect(mirror.getStates().get(awareness.clientID)?.user?.name).toBe("raw");

    socket.close();
    mirror.destroy();
    awareness.destroy();
    mirrorDoc.destroy();
    doc.destroy();
  });

  it("drops the states of a peer whose socket died without a farewell (R3)", async () => {
    const url = await startHub();

    const one = clients.open(url, "alpha");
    const two = clients.open(url, "alpha");
    await waitFor(() => one.provider.synced && two.provider.synced);

    one.provider.awareness.setLocalStateField("user", { name: "alice" });
    await waitFor(() => two.provider.awareness.getStates().has(one.doc.clientID));

    // Kill the socket underneath the provider. `destroy()` / `disconnect()` would
    // publish the removal themselves, so the hub could stay broken and still pass.
    one.provider.ws?.close();

    await waitFor(() => !two.provider.awareness.getStates().has(one.doc.clientID));
    expect(two.provider.awareness.getStates().has(one.doc.clientID)).toBe(false);
  });
});
