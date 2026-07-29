import { existsSync } from "node:fs";
import { DEFAULT_HOST } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findHub, findOrStartHub, writeHubLock } from "./index.ts";
import {
  createScenario,
  fakeHubCommand,
  freePort,
  pidOf,
  rejection,
  type Scenario,
} from "./test-helpers.ts";

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

  it("ignores a live hub on the lockfile's port when a port was named (R1)", async () => {
    const recordedPort = await freePort();
    const explicitPort = await freePort();
    const hub = await scenario.startFakeHub({ mode: "healthy", port: recordedPort });
    await writeHubLock(scenario.dataDir, { port: recordedPort, pid: pidOf(hub) });

    const info = await findOrStartHub({
      port: explicitPort,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    // The hub on the recorded port is real and answering, and it is still the
    // wrong one: the caller named a port. Handing back somebody else's hub would
    // put two people on boards where neither can see the other.
    expect(info.port).toBe(explicitPort);
    expect(await scenario.boundPids()).toHaveLength(1);
  });

  it("reports a foreign occupant rather than calling the port empty (R1)", async () => {
    const port = await freePort();
    await scenario.startFakeHub({ mode: "foreign", port });

    const error = await rejection(findHub({ port, dataDir: scenario.dataDir }));

    // `null` is this call's word for "nothing is there". Something is there, and
    // a caller that cannot tell the two apart would go on to ask for a hub to be
    // started and meet the same conflict the hard way.
    expect(error.code).toBe("port-occupied");
    expect(existsSync(scenario.spawnedLogPath())).toBe(false);
  });

  it("treats a stranger on the lockfile's port as a stale hint, not a conflict (R1)", async () => {
    const strangerPort = await freePort();
    await scenario.startFakeHub({ mode: "foreign", port: strangerPort });
    await writeHubLock(scenario.dataDir, {
      port: strangerPort,
      pid: await scenario.deadPid(),
    });

    // No explicit port, so the port a hub belongs on is the default one and the
    // lockfile only says where one used to be. Refusing here would mean a hub
    // that died long ago, on a port some unrelated app has since taken, could
    // stop this machine from ever getting a hub again.
    const info = await findHub({ dataDir: scenario.dataDir });

    // Deliberately not `toBeNull()`: this is the second scenario that can reach
    // DEFAULT_PORT, and a hub genuinely running there is a legitimate answer.
    expect(info?.port).not.toBe(strangerPort);
  });
});
