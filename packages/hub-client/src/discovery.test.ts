import { existsSync } from "node:fs";
import { DEFAULT_HOST } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findHub, findOrStartHub, writeHubLock } from "./index.ts";
import { createScenario, fakeHubCommand, freePort, pidOf, type Scenario } from "./test-helpers.ts";

describe("discovery", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await createScenario();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("returns the hub the lockfile points at, with its pid, and starts nothing (R1)", async () => {
    const port = await freePort();
    const hub = await scenario.startFakeHub({ mode: "healthy", port });
    await writeHubLock(scenario.dataDir, { port, pid: pidOf(hub) });

    const info = await findOrStartHub({
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    expect(info.url).toBe(`http://${DEFAULT_HOST}:${port}`);
    expect(info.port).toBe(port);
    expect(info.pid).toBe(pidOf(hub));
    expect(await scenario.spawnedPids()).toEqual([]);
  });

  it("reports no pid when a running hub was found without a lockfile (R1)", async () => {
    const port = await freePort();
    await scenario.startFakeHub({ mode: "healthy", port });

    const info = await findOrStartHub({
      port,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    expect(info.url).toBe(`http://${DEFAULT_HOST}:${port}`);
    // `/health` carries no pid, and the client will not put its own guess there.
    expect(info.pid).toBeUndefined();
    expect(await scenario.spawnedPids()).toEqual([]);
  });

  it("finds a hub without ever starting one (R1)", async () => {
    const port = await freePort();
    await scenario.startFakeHub({ mode: "healthy", port });

    const info = await findHub({ port, dataDir: scenario.dataDir });

    expect(info?.url).toBe(`http://${DEFAULT_HOST}:${port}`);
    // Not "no new lines" but "no log at all": the probe-only entry point has no
    // spawn path to take.
    expect(existsSync(scenario.spawnedLogPath())).toBe(false);
  });

  it("consults the lockfile port before the default port (R1)", async () => {
    const port = await freePort();
    const hub = await scenario.startFakeHub({ mode: "healthy", port });
    await writeHubLock(scenario.dataDir, { port, pid: pidOf(hub) });

    // The one scenario that omits an explicit port, so DEFAULT_PORT is reachable.
    // A failure here can mean the probe order is inverted and this reached an
    // ambient hub on the machine rather than the fixture.
    const info = await findOrStartHub({
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    expect(info.port).toBe(port);
    expect(await scenario.spawnedPids()).toEqual([]);
  });

  it("prefers an explicit port over the one the lockfile records (R1)", async () => {
    const recordedPort = await freePort();
    const explicitPort = await freePort();
    const hub = await scenario.startFakeHub({ mode: "healthy", port: explicitPort });
    await writeHubLock(scenario.dataDir, { port: recordedPort, pid: pidOf(hub) });

    const info = await findOrStartHub({
      port: explicitPort,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    expect(info.port).toBe(explicitPort);
    // The lockfile describes a hub on another port, so its pid says nothing
    // about the one that answered here.
    expect(info.pid).toBeUndefined();
    expect(await scenario.spawnedPids()).toEqual([]);
  });

  it("resolves with null rather than rejecting when nothing answers (R1)", async () => {
    const port = await freePort();

    const info = await findHub({ port, dataDir: scenario.dataDir });

    expect(info).toBeNull();
    expect(await scenario.spawnedPids()).toEqual([]);
  });
});
