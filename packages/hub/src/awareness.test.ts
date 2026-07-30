import * as decoding from "lib0/decoding";
import { afterEach, describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
import { writeSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";
import type { Hub } from "./index";
import { createHub } from "./index";
import {
  awarenessFrame,
  createClientPool,
  createDataDirPool,
  MESSAGE_AWARENESS,
  openRawClient,
  syncFrame,
  waitFor,
} from "./test-helpers";

describe("awareness", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  let hub: Hub | null = null;

  afterEach(async () => {
    clients.closeAll();
    await hub?.stop();
    hub = null;
    await dataDirs.removeAll();
  });

  async function startHub(): Promise<string> {
    hub = createHub({ port: 0, dataDir: await dataDirs.create() });
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

  it("announces no peers at all to the first client in a room (R3)", async () => {
    const url = await startHub();

    const first = await openRawClient(url, "/sync/alpha");
    // The hub greets a new peer with sync step 1 and, only when the room already
    // holds awareness states, a second frame carrying them. Provoking one more
    // answer gives an ordered barrier: once a second frame has arrived, any
    // greeting the hub meant to send has arrived too.
    first.send(syncFrame((encoder) => writeSyncStep1(encoder, new Y.Doc())));
    await waitFor(() => first.frames.length >= 2);

    // `Awareness` publishes an empty local state on construction. A hub that
    // never retracts its own turns up in every room as a peer that is not there
    // — invisibly at first, because a fresh peer rejects its clock-0 state, and
    // then for real once the 15s keepalive advances that clock.
    expect(first.frames.filter((frame) => frame[0] === MESSAGE_AWARENESS)).toEqual([]);

    first.close();
  });

  it("relays a refresh that repeats a peer's current state unchanged (R3)", async () => {
    const url = await startHub();

    const publisher = await openRawClient(url, "/sync/alpha");
    const observer = await openRawClient(url, "/sync/alpha");

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const state = { user: { name: "alice" } };
    awareness.setLocalState(state);
    publisher.send(awarenessFrame(awareness));
    await waitFor(() => observer.frames.some((frame) => frame[0] === MESSAGE_AWARENESS));

    // Same content, next clock — exactly what the keepalive republishes every
    // 15s. `Awareness` fires `change` only when content differs but `update` on
    // every clock bump, so a hub listening to `change` drops these and remote
    // peers expire after 30s even though everyone is still connected.
    observer.clear();
    awareness.setLocalState({ ...state });
    publisher.send(awarenessFrame(awareness));

    await waitFor(() => observer.frames.some((frame) => frame[0] === MESSAGE_AWARENESS));

    publisher.close();
    observer.close();
    awareness.destroy();
    doc.destroy();
  });

  it("echoes an awareness update back to its own sender (R3)", async () => {
    const url = await startHub();

    const sender = await openRawClient(url, "/sync/alpha");

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalStateField("user", { name: "raw" });

    sender.clear();
    sender.send(awarenessFrame(awareness));

    await waitFor(() => sender.frames.some((frame) => frame[0] === MESSAGE_AWARENESS));

    const [echoed] = sender.frames.filter((frame) => frame[0] === MESSAGE_AWARENESS);
    if (echoed === undefined) throw new Error("no awareness message was echoed back");

    const mirrorDoc = new Y.Doc();
    const mirror = new Awareness(mirrorDoc);
    const decoder = decoding.createDecoder(echoed);
    decoding.readVarUint(decoder);
    applyAwarenessUpdate(mirror, decoding.readVarUint8Array(decoder), "test");
    expect(mirror.getStates().get(awareness.clientID)?.user?.name).toBe("raw");

    sender.close();
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
