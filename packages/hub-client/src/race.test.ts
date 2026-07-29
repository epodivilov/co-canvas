import { DEFAULT_HOST } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrStartHub } from "./index.ts";
import {
  createScenario,
  fakeHubCommand,
  freePort,
  isAlive,
  type Scenario,
  waitFor,
} from "./test-helpers.ts";

const CALLERS = 4;

describe("race", () => {
  let scenario: Scenario;

  beforeEach(async () => {
    scenario = await createScenario();
  });

  afterEach(async () => {
    await scenario.cleanup();
  });

  it("converges on one hub when several callers start at once (R3)", async () => {
    const port = await freePort();

    // Spawned in one synchronous pass, which is as close to simultaneous as a
    // test runner gets. The overlap this achieves is what the scenario proves;
    // it does not enumerate every interleaving.
    const callers = Array.from({ length: CALLERS }, () =>
      scenario.runCaller({ port, dataDir: scenario.dataDir }),
    );
    const outcomes = await Promise.all(callers);

    for (const outcome of outcomes) {
      expect(outcome.code).toBe(0);
      expect(outcome.stdout).toBe(`http://${DEFAULT_HOST}:${port}`);
    }

    // The OS granted the port to exactly one process. Everyone else lost the
    // bind and had to converge on the survivor.
    const bound = await scenario.boundPids();
    expect(bound).toHaveLength(1);
    const survivor = bound.at(0);
    if (survivor === undefined) throw new Error("no hub reported binding the port");
    expect(isAlive(survivor)).toBe(true);

    expect((await scenario.spawnedPids()).length).toBeGreaterThanOrEqual(1);
    // A caller converges the moment the winner answers health, which can be
    // before its own hub has even reached its bind — so the losers are not all
    // gone the instant the last caller returns. What matters is that they all
    // go, and that the survivor is still the only one holding the port when they
    // have.
    await waitFor(async () => {
      const spawned = await scenario.spawnedPids();
      return spawned.every((pid) => pid === survivor || !isAlive(pid));
    }, "a hub that lost the port race is still running");

    expect(await scenario.boundPids()).toEqual([survivor]);
    expect(isAlive(survivor)).toBe(true);
  }, 30_000);

  it("converges on a hub that arrives after its own died on the port (R3)", async () => {
    const port = await freePort();
    // The scenario above is best-effort about which interleaving it reaches;
    // this one fixes the awkward order deliberately. The hub takes the port a
    // quarter of a second late, well after the command this call starts has
    // given up on it — which is what a losing hub's EADDRINUSE looks like from
    // here. Rejecting at that point would leave one of several racing callers
    // with an error while a perfectly good hub is listening.
    await scenario.startFakeHub({ mode: "healthy", port, bindDelayMs: 250, awaitListening: false });

    const info = await findOrStartHub({
      port,
      dataDir: scenario.dataDir,
      ...fakeHubCommand(scenario, "exit-nonzero"),
    });

    expect(info.url).toBe(`http://${DEFAULT_HOST}:${port}`);
    // The start path really was taken: a command ran, and it never bound.
    expect(await scenario.spawnedPids()).toHaveLength(1);
    expect(await scenario.boundPids()).toEqual([]);
  });
});
