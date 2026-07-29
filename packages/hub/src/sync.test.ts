import * as decoding from "lib0/decoding";
import { afterEach, describe, expect, it } from "vitest";
import {
  messageYjsSyncStep2,
  messageYjsUpdate,
  writeSyncStep1,
  writeUpdate,
} from "y-protocols/sync";
import * as Y from "yjs";
import type { Hub } from "./index";
import { createHub } from "./index";
import { createClientPool, MESSAGE_SYNC, openRawClient, syncFrame, waitFor } from "./test-helpers";

describe("document sync", () => {
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

  it("relays an update to the room's other peer and to no one else (R1)", async () => {
    const url = await startHub();

    const alphaOne = clients.open(url, "alpha");
    const alphaTwo = clients.open(url, "alpha");
    const betaOne = clients.open(url, "beta");
    const betaTwo = clients.open(url, "beta");
    const all = [alphaOne, alphaTwo, betaOne, betaTwo];
    await waitFor(() => all.every((client) => client.provider.synced));

    alphaOne.doc.getMap("board").set("shape", "rect");
    await waitFor(() => alphaTwo.doc.getMap("board").get("shape") === "rect");

    // A barrier rather than a sleep: this write reaches the hub strictly after
    // the alpha one, and both would travel to betaTwo over the same ordered
    // socket, so once the marker lands anything wrongly addressed to beta has
    // already been delivered.
    betaOne.doc.getMap("board").set("marker", true);
    await waitFor(() => betaTwo.doc.getMap("board").get("marker") === true);

    expect([...betaTwo.doc.getMap("board").keys()]).toEqual(["marker"]);
    expect(betaOne.doc.getMap("board").has("shape")).toBe(false);
  });

  it("converges when two peers of a room write concurrently (R1)", async () => {
    const url = await startHub();

    const one = clients.open(url, "alpha");
    const two = clients.open(url, "alpha");
    await waitFor(() => one.provider.synced && two.provider.synced);

    one.doc.getMap("board").set("from-one", 1);
    two.doc.getMap("board").set("from-two", 2);

    await waitFor(() => one.doc.getMap("board").size === 2 && two.doc.getMap("board").size === 2);
    expect([...one.doc.getMap("board").keys()].sort()).toEqual(["from-one", "from-two"]);
    expect([...two.doc.getMap("board").keys()].sort()).toEqual(["from-one", "from-two"]);
  });

  it("does not send a peer's own document update back to it (R1)", async () => {
    const url = await startHub();

    const author = await openRawClient(url, "/sync/alpha");
    const observer = await openRawClient(url, "/sync/alpha");
    author.clear();
    observer.clear();

    const scratch = new Y.Doc();
    scratch.getMap("board").set("shape", "rect");
    author.send(syncFrame((encoder) => writeUpdate(encoder, Y.encodeStateAsUpdate(scratch))));

    // The observer receiving it proves the hub fanned the update out at all.
    await waitFor(() => syncKinds(observer.frames).includes(messageYjsUpdate));

    // Barrier on the author's own socket: the hub always answers a sync step 1,
    // and frames on one connection are ordered, so an echo of the earlier update
    // would have arrived before this answer does.
    author.send(syncFrame((encoder) => writeSyncStep1(encoder, new Y.Doc())));
    await waitFor(() => syncKinds(author.frames).includes(messageYjsSyncStep2));

    expect(syncKinds(author.frames)).not.toContain(messageYjsUpdate);
    // Nothing the hub sends is a bare message-type byte. Answering a sync
    // message that needs no answer produces exactly that, and two peers then
    // trade empty frames forever.
    expect(author.frames.filter((frame) => frame.byteLength <= 1)).toEqual([]);
    expect(observer.frames.filter((frame) => frame.byteLength <= 1)).toEqual([]);

    author.close();
    observer.close();
    scratch.destroy();
  });

  it("hands a late joiner the room's existing state without any new write (R2)", async () => {
    const url = await startHub();

    const writer = clients.open(url, "alpha");
    const witness = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced && witness.provider.synced);

    writer.doc.getMap("board").set("shape", "rect");
    // The witness can only see this because the hub applied it to the room's own
    // document, which is exactly the state a late joiner will be handed.
    await waitFor(() => witness.doc.getMap("board").get("shape") === "rect");
    writer.close();
    witness.close();

    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.provider.synced);
    await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");
    expect(reader.doc.getMap("board").get("shape")).toBe("rect");
  });
});

/**
 * The sync sub-type of every sync frame received, in arrival order.
 *
 * Frames too short to carry a sub-type are skipped rather than decoded, so a hub
 * that emits them fails the assertion written for that instead of blowing up
 * here with a decoding error.
 */
function syncKinds(frames: Uint8Array[]): number[] {
  const kinds: number[] = [];
  for (const frame of frames) {
    if (frame.byteLength <= 1) continue;
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    kinds.push(decoding.readVarUint(decoder));
  }
  return kinds;
}
