import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrStartHub } from "./index.ts";
import {
  createScenario,
  FAKE_HUB,
  fakeHubCommand,
  freePort,
  isAlive,
  rejection,
  type Scenario,
} from "./test-helpers.ts";

describe("failures", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await createScenario();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("gives up on a process that never binds, and reaps it (R6)", async () => {
    const port = await freePort();

    const error = await rejection(
      findOrStartHub({
        port,
        dataDir: scenario.dataDir,
        startupTimeoutMs: 1000,
        ...fakeHubCommand(scenario, "never-bind"),
      }),
    );

    expect(error.code).toBe("start-failed");
    expect(error.message).toContain(FAKE_HUB);
    expect(error.message).toContain("1000");
    const spawned = await scenario.spawnedPids();
    expect(spawned).toHaveLength(1);
    // Rejecting while the process it started is still running would leave the
    // caller with a mess it never had a handle on.
    for (const pid of spawned) expect(isAlive(pid)).toBe(false);
  });

  it("fails as soon as the started process exits, not when the budget runs out (R6)", async () => {
    const port = await freePort();
    const startupTimeoutMs = 5000;

    const startedAt = Date.now();
    const error = await rejection(
      findOrStartHub({
        port,
        dataDir: scenario.dataDir,
        startupTimeoutMs,
        ...fakeHubCommand(scenario, "exit-nonzero"),
      }),
    );
    const elapsed = Date.now() - startedAt;

    expect(error.code).toBe("start-failed");
    // The exit is the diagnosis. Polling on until the deadline would turn a
    // one-second failure into a five-second one and lose the exit code.
    expect(elapsed).toBeLessThan(startupTimeoutMs - 2000);
    expect(error.message).toContain("exited with code 3");
  });

  it("reports a command that cannot be executed with its underlying cause (R6)", async () => {
    const port = await freePort();

    const error = await rejection(
      findOrStartHub({
        port,
        dataDir: scenario.dataDir,
        command: "/nonexistent/co-canvas-hub",
        env: { FAKE_HUB_LOG_DIR: scenario.logDir },
      }),
    );

    expect(error.code).toBe("spawn-failed");
    expect(error.message).toContain("/nonexistent/co-canvas-hub");
    expect((error.cause as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });
});
