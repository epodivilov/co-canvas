import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { PROTOCOL_VERSION } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearHubLock, hubLockPath, readHubLock, writeHubLock } from "./index.ts";
import { createScenario, type Scenario } from "./test-helpers.ts";

describe("lockfile", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await createScenario();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("round-trips pid, port, protocol and start time (R7)", async () => {
    const startedAt = new Date("2026-07-29T10:11:12.000Z").toISOString();

    await writeHubLock(scenario.dataDir, {
      pid: 4242,
      port: 4321,
      protocol: PROTOCOL_VERSION,
      startedAt,
    });

    expect(await readHubLock(scenario.dataDir)).toEqual({
      pid: 4242,
      port: 4321,
      protocol: PROTOCOL_VERSION,
      startedAt,
    });
  });

  it("resolves with null when there is no lockfile (R7)", async () => {
    // The ordinary case until CC-3 teaches the hub to write one.
    expect(await readHubLock(scenario.dataDir)).toBeNull();
  });

  it("resolves with null for unusable contents instead of rejecting (R7)", async () => {
    const path = hubLockPath(scenario.dataDir);

    for (const contents of [
      "this is not json",
      "",
      JSON.stringify({ pid: 4242, protocol: PROTOCOL_VERSION, startedAt: "2026-07-29T00:00:00Z" }),
      // A blank start time is a field that was written but says nothing, which
      // is no more of a claim than a missing one.
      JSON.stringify({ pid: 4242, port: 4321, protocol: PROTOCOL_VERSION, startedAt: "" }),
    ]) {
      await writeFile(path, contents, "utf8");
      // A half-written or hand-edited file means "no claim", not "crash the
      // caller that was only asking whether a hub might be running".
      expect(await readHubLock(scenario.dataDir)).toBeNull();
    }
  });

  it("clears an existing lockfile and tolerates a missing one (R7)", async () => {
    await expect(clearHubLock(scenario.dataDir)).resolves.toBeUndefined();

    await writeHubLock(scenario.dataDir, { port: 4321 });
    await clearHubLock(scenario.dataDir);

    expect(existsSync(hubLockPath(scenario.dataDir))).toBe(false);
    expect(await readHubLock(scenario.dataDir)).toBeNull();
  });

  it("reports a lockfile it could not remove rather than pretending it did (R7)", async () => {
    // A directory in the lockfile's place cannot be unlinked. Only absence is
    // benign here: swallowing every error would let a hub that failed to give up
    // its claim report a clean shutdown, and the next client would find a
    // lockfile nobody stands behind.
    await mkdir(hubLockPath(scenario.dataDir), { recursive: true });

    await expect(clearHubLock(scenario.dataDir)).rejects.toThrow();
  });
});
