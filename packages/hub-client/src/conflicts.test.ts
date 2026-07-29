import { PROTOCOL_VERSION } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrStartHub } from "./index.ts";
import {
  createScenario,
  fakeHubCommand,
  freePort,
  rejection,
  type Scenario,
} from "./test-helpers.ts";

describe("conflicts", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await createScenario();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("refuses a port held by a foreign service and starts nothing (R4)", async () => {
    const port = await freePort();
    await scenario.startFakeHub({ mode: "foreign", port });

    const error = await rejection(
      findOrStartHub({ port, dataDir: scenario.dataDir, ...fakeHubCommand(scenario) }),
    );

    expect(error.code).toBe("port-occupied");
    expect(error.message).toContain(String(port));
    // The way out has to be in the message: there is no fallback port anywhere
    // in this package, so the caller has to be told which knob moves it.
    expect(error.message).toContain("`port` option");
    expect(await scenario.spawnedPids()).toEqual([]);
  });

  it("refuses a hub speaking a different protocol version and starts nothing (R4)", async () => {
    const port = await freePort();
    await scenario.startFakeHub({ mode: "protocol-999", port });

    const error = await rejection(
      findOrStartHub({ port, dataDir: scenario.dataDir, ...fakeHubCommand(scenario) }),
    );

    expect(error.code).toBe("protocol-mismatch");
    expect(error.message).toContain("protocol 999");
    expect(error.message).toContain(`speaks protocol ${PROTOCOL_VERSION}`);
    expect(await scenario.spawnedPids()).toEqual([]);
  });

  it("treats an occupied port with no health endpoint as foreign (R4)", async () => {
    const port = await freePort();
    await scenario.startFakeHub({ mode: "not-found", port });

    const error = await rejection(
      findOrStartHub({ port, dataDir: scenario.dataDir, ...fakeHubCommand(scenario) }),
    );

    // Someone answered. That is the whole test: an answer that is not a health
    // payload is an occupant, not an absent hub.
    expect(error.code).toBe("port-occupied");
    expect(await scenario.spawnedPids()).toEqual([]);
  });
});
