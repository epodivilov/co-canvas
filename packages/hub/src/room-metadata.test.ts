import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  METADATA_FILENAME,
  METADATA_TEMP_FILENAME,
  readRoomMetadata,
  writeRoomMetadata,
} from "./room-metadata.ts";

describe("room metadata store", () => {
  const dirs: string[] = [];

  async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "co-canvas-meta-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips titles and archived flags", async () => {
    const dir = await dataDir();
    await writeRoomMetadata(
      dir,
      new Map([
        ["alpha", { title: "Auth redesign", archived: false }],
        ["beta", { title: null, archived: true }],
      ]),
    );

    const read = await readRoomMetadata(dir);
    expect(read.get("alpha")).toEqual({ title: "Auth redesign", archived: false });
    expect(read.get("beta")).toEqual({ title: null, archived: true });
  });

  it("reports an empty store when no metadata file exists", async () => {
    const dir = await dataDir();
    expect((await readRoomMetadata(dir)).size).toBe(0);
  });

  it("falls back to an empty store rather than throwing on unreadable JSON", async () => {
    const dir = await dataDir();
    await writeFile(join(dir, METADATA_FILENAME), "{ not json");
    expect((await readRoomMetadata(dir)).size).toBe(0);
  });

  it("publishes by renaming a sibling so a reader never sees a half-written store", async () => {
    const dir = await dataDir();
    await writeRoomMetadata(dir, new Map([["alpha", { title: "A", archived: false }]]));

    // The scratch file is renamed over the target, never left behind.
    await expect(stat(join(dir, METADATA_TEMP_FILENAME))).rejects.toThrow();
    const raw = await readFile(join(dir, METADATA_FILENAME), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
