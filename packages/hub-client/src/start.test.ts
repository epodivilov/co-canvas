import { DEFAULT_HOST, HUB_SERVICE_ID, PROTOCOL_VERSION } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrStartHub, writeHubLock } from "./index.ts";
import {
  createScenario,
  fakeHubCommand,
  freePort,
  isListening,
  type Scenario,
} from "./test-helpers.ts";

describe("start", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await createScenario();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("starts a hub when nothing answers and resolves once it is healthy (R2)", async () => {
    const port = await freePort();

    const info = await findOrStartHub({
      port,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    expect(info.port).toBe(port);
    const response = await fetch(`${info.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: HUB_SERVICE_ID,
      protocol: PROTOCOL_VERSION,
    });
    expect(await scenario.boundPids()).toHaveLength(1);
  });

  it("starts on the explicit port, never on the one the lockfile recorded (R2)", async () => {
    const recordedPort = await freePort();
    const foreignPort = await freePort();
    const explicitPort = await freePort();
    await writeHubLock(scenario.dataDir, { port: recordedPort, pid: await scenario.deadPid() });
    await scenario.startFakeHub({ mode: "foreign", port: foreignPort });

    const info = await findOrStartHub({
      port: explicitPort,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario),
    });

    expect(info.port).toBe(explicitPort);
    expect(await isListening(explicitPort)).toBe(true);
    // The lockfile port is a discovery hint. Starting there would resurrect a
    // hub on a port the caller explicitly moved away from.
    expect(await isListening(recordedPort)).toBe(false);
  });

  it("leaves the hub running after the process that asked for it exits (R2)", async () => {
    const port = await freePort();

    const outcome = await scenario.runCaller({ port, dataDir: scenario.dataDir });

    // The caller's `close` event is the assertion that it is gone — no timer.
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe(`http://${DEFAULT_HOST}:${port}`);
    const response = await fetch(`${outcome.stdout}/health`);
    expect(response.status).toBe(200);
  });
});
