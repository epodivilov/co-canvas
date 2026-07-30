import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hub } from "./index";
import { createHub } from "./index";
import {
  createClientPool,
  createDataDirPool,
  indexPath,
  logPath,
  readLog,
  settle,
  waitFor,
} from "./test-helpers";

/**
 * Records every mutating filesystem call the hub makes and, after each one,
 * reads the files under watch back. Compaction and index writes both publish by
 * renaming a sibling over the target, and the only way to see that is from
 * underneath: an assertion on the final file cannot tell a rename apart from a
 * truncate-then-write that happened to finish.
 */
const probe = vi.hoisted(() => ({
  calls: [] as { op: string; path: string; to: string | null }[],
  watched: [] as string[],
  reads: [] as { op: string; path: string; bytes: number; complete: boolean }[],
  reset(): void {
    probe.calls.length = 0;
    probe.reads.length = 0;
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { readFileSync } = await import("node:fs");

  const wholeLog = (bytes: Buffer): boolean => {
    if (bytes.length < 14 || bytes.subarray(0, 5).toString("ascii") !== "CCLOG") return false;
    let offset = 14;
    while (offset < bytes.length) {
      if (offset + 4 > bytes.length) return false;
      const length = bytes.readUInt32BE(offset);
      if (offset + 4 + length > bytes.length) return false;
      offset += 4 + length;
    }
    return true;
  };

  const wholeJson = (bytes: Buffer): boolean => {
    try {
      JSON.parse(bytes.toString("utf8"));
      return true;
    } catch {
      return false;
    }
  };

  const observe = (op: string): void => {
    for (const path of probe.watched) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      const complete = path.endsWith(".json") ? wholeJson(bytes) : wholeLog(bytes);
      probe.reads.push({ op, path, bytes: bytes.length, complete });
    }
  };

  const wrap =
    (op: string, fn: (...args: never[]) => Promise<unknown>) =>
    async (...args: unknown[]): Promise<unknown> => {
      probe.calls.push({
        op,
        path: String(args[0]),
        to: args.length > 1 && op === "rename" ? String(args[1]) : null,
      });
      try {
        return await (fn as (...inner: unknown[]) => Promise<unknown>)(...args);
      } finally {
        observe(op);
      }
    };

  return {
    ...actual,
    writeFile: wrap("writeFile", actual.writeFile),
    appendFile: wrap("appendFile", actual.appendFile),
    rename: wrap("rename", actual.rename),
    truncate: wrap("truncate", actual.truncate),
  } as unknown as typeof actual;
});

const KIB = 1024;

function blob(bytes: number): string {
  return "x".repeat(bytes);
}

describe("atomic publication", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(dataDir: string): Hub {
    const created = createHub({ port: 0, dataDir });
    hubs.add(created);
    return created;
  }

  afterEach(async () => {
    clients.closeAll();
    try {
      for (const created of hubs) await created.stop();
    } finally {
      hubs.clear();
      probe.watched.length = 0;
      probe.reset();
      // Unconditional: a scenario that failed with a hub mid-flush would
      // otherwise leave its directory behind in the OS temp dir forever.
      await dataDirs.removeAll();
    }
  });

  it("replaces a compacted log wholesale and never writes a partial one (R5)", async () => {
    const dataDir = await dataDirs.create();
    const log = logPath(dataDir, "alpha");
    const temporary = join(dataDir, "rooms", "alpha.log.tmp");
    const url = await hub(dataDir).start();
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);

    // Settle the room first, so the log exists and the recording below covers
    // one compaction rather than the room's whole life.
    writer.doc.getMap("board").set("blob", blob(4 * KIB));
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1);
    probe.watched.push(log);
    probe.reset();

    const value = blob(4 * KIB);
    for (let batch = 0; batch < 3; batch += 1) {
      for (let index = 0; index < 20; index += 1) {
        writer.doc.getMap("board").set("blob", `${batch}-${index}-${value}`);
      }
      await settle(320);
    }
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1, 10_000);

    const publications = probe.calls.filter((call) => call.to === log);
    expect(publications.length).toBeGreaterThan(0);
    expect(publications).toEqual(
      publications.map(() => ({ op: "rename", path: temporary, to: log })),
    );
    // Nothing wrote the snapshot straight into the live log, and nothing
    // truncated it first either.
    expect(probe.calls.filter((call) => call.path === log && call.op !== "appendFile")).toEqual([]);
    expect(probe.reads.length).toBeGreaterThan(0);
    expect(probe.reads.filter((read) => !read.complete)).toEqual([]);
  }, 30_000);

  it("replaces rooms.json wholesale so a reader never sees half an index (R7)", async () => {
    const dataDir = await dataDirs.create();
    const index = indexPath(dataDir);
    const temporary = `${index}.tmp`;
    const url = await hub(dataDir).start();
    probe.watched.push(index);
    probe.reset();

    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await readLog(dataDir, "alpha")).frames.length === 1);
    await settle(100);

    const publications = probe.calls.filter((call) => call.to === index);
    expect(publications.length).toBeGreaterThan(0);
    expect(publications.every((call) => call.op === "rename" && call.path === temporary)).toBe(
      true,
    );
    expect(probe.calls.filter((call) => call.path === index && call.op !== "rename")).toEqual([]);
    expect(probe.reads.length).toBeGreaterThan(0);
    expect(probe.reads.filter((read) => !read.complete)).toEqual([]);
  });
});
