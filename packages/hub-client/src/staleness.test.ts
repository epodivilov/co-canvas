import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrStartHub, readHubLock, writeHubLock } from "./index.ts";
import {
  createScenario,
  fakeHubCommand,
  freePort,
  isAlive,
  pidOf,
  type Scenario,
  waitFor,
} from "./test-helpers.ts";

describe("staleness", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await createScenario();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("starts a new hub over a lockfile whose hub is gone (R5)", async () => {
    const port = await freePort();
    const gonePid = await scenario.deadPid();
    await writeHubLock(scenario.dataDir, { port, pid: gonePid });

    const info = await findOrStartHub({
      port,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario, "healthy-lockfile"),
    });

    expect(info.port).toBe(port);
    const bound = await scenario.boundPids();
    expect(bound).toHaveLength(1);
    // The hub records itself after its bind, so the file catches up a moment
    // after the health endpoint starts answering.
    await waitFor(
      async () => (await readHubLock(scenario.dataDir))?.pid === bound.at(0),
      "the started hub never recorded itself",
    );
    const lock = await readHubLock(scenario.dataDir);
    expect(lock?.port).toBe(port);
    expect(lock?.pid).not.toBe(gonePid);
  });

  it("removes the disproved entry and records nothing in its place (R5)", async () => {
    const port = await freePort();
    await writeHubLock(scenario.dataDir, { port, pid: await scenario.deadPid() });

    await findOrStartHub({
      port,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario, "healthy"),
    });

    // This hub does not write a lockfile, so whatever is left is the client's
    // doing: it retracts a claim the probe disproved and makes none of its own.
    expect(await readHubLock(scenario.dataDir)).toBeNull();
  });

  it("never signals the pid the lockfile recorded (R5)", async () => {
    const port = await freePort();
    const innocent = await scenario.startSleeper();
    // The pid in a stale lockfile can have been handed to anyone by now. A
    // client that reaped it would kill a stranger.
    await writeHubLock(scenario.dataDir, { port, pid: pidOf(innocent) });

    await findOrStartHub({
      port,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    expect(isAlive(pidOf(innocent))).toBe(true);
    expect(innocent.exitCode).toBeNull();
    expect(innocent.signalCode).toBeNull();
  });
});
