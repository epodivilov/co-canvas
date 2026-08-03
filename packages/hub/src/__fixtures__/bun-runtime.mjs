// Exercises the hub's upgrade path under Bun, whose native WebSocket has no
// receiver to pause. Run by `bun-runtime.test.ts` (skipped when bun is absent);
// it drives the raw sync wire format over Bun's global WebSocket and prints one
// `RESULT {json}` line the test parses.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { readSyncMessage, writeSyncStep1 } from "y-protocols/sync";
import * as Y from "yjs";
import { createHub } from "../index.ts";

const MESSAGE_SYNC = 0;

/** Builds a log file's bytes: `CCLOG`, a version byte, a u64 timestamp, then u32-prefixed updates. */
function encodeLog(createdAt, frames) {
  const header = Buffer.alloc(14);
  header.write("CCLOG", 0, "ascii");
  header.writeUInt8(1, 5);
  header.writeBigUInt64BE(BigInt(createdAt), 6);
  const parts = [header];
  for (const frame of frames) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(frame.byteLength, 0);
    parts.push(prefix, Buffer.from(frame));
  }
  return Buffer.concat(parts);
}

function seedRoom(dataDir, slug, edit) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on("update", (update) => updates.push(update));
  edit(doc);
  doc.destroy();
  writeFileSync(join(dataDir, "rooms", `${slug}.log`), encodeLog(1_700_000_000_000, updates));
}

function connect(url, slug, doc) {
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}/sync/${slug}`);
  socket.binaryType = "arraybuffer";
  const frames = [];
  socket.addEventListener("message", (event) => {
    const bytes = new Uint8Array(event.data);
    frames.push(bytes);
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    readSyncMessage(decoder, encoder, doc, null);
    if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
  });
  return { socket, frames };
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("socket error")));
  });
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function syncStepOf(frame) {
  const decoder = decoding.createDecoder(frame);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return -1;
  return decoding.readVarUint(decoder);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "bun-hub-"));
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(join(dataDir, "rooms"), { recursive: true }),
  );
  seedRoom(dataDir, "alpha", (doc) => doc.getMap("board").set("shape", "rect"));

  const hub = createHub({ port: 0, dataDir });
  const url = await hub.start();

  // Scenarios 1 & 2: the upgrade completes and the hub sends its unprompted sync
  // step 1; a state vector we announce the instant we open is still processed —
  // the hub replies with a step 2 that carries the seeded board.
  const doc = new Y.Doc();
  const { socket, frames } = connect(url, "alpha", doc);
  await opened(socket);
  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, MESSAGE_SYNC);
  writeSyncStep1(step1, doc);
  socket.send(encoding.toUint8Array(step1));

  const converged = await waitUntil(() => doc.getMap("board").get("shape") === "rect", 5000);
  const receivedUnpromptedStep1 = frames.length > 0 && syncStepOf(frames[0]) === 0;
  const receivedStep2 = frames.some((frame) => syncStepOf(frame) === 1);

  // Scenario 3: a peer that leaves while its room is loading is cleaned up, and
  // `stop()` still resolves rather than hanging on a stranded closing handshake.
  const doc2 = new Y.Doc();
  const { socket: socket2 } = connect(url, "beta", doc2);
  await opened(socket2);
  socket2.close();

  const stopResolved = await Promise.race([
    hub.stop().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 6000)),
  ]);

  return { receivedUnpromptedStep1, receivedStep2, converged, stopResolved };
}

main().then(
  (result) => {
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  },
  (error) => {
    process.stdout.write(`RESULT ${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
    process.exit(1);
  },
);
