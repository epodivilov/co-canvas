import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import { createHarness, freePort, hubHealth, textOf, waitFor } from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("hub acquisition", () => {
  it("starts a hub when nothing is listening, then serves the call (R5)", async () => {
    const port = await freePort();
    const bridge = await harness.connect({
      hubPort: port,
      hubCommand: () => harness.fixtureHubCommand(port),
    });

    const result = await bridge.call("create_room", { slug: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      slug: "alpha",
      url: `http://127.0.0.1:${port}/room/alpha`,
      created: true,
    });
    expect(await hubHealth(port)).toBe("co-canvas-hub");
    expect(await harness.startedHubPids()).toHaveLength(1);
  }, 20_000);

  it("fails actionably when the port is held by something else (R5)", async () => {
    const port = await harness.occupyPort();
    const bridge = await harness.connect({
      hubPort: port,
      hubCommand: () => harness.fixtureHubCommand(port),
    });

    const result = await bridge.call("list_rooms");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(String(port));
    expect(textOf(result)).toContain("CO_CANVAS_HUB_PORT");
    expect(await harness.startedHubPids()).toEqual([]);
  }, 20_000);

  it("stays alive and keeps answering after an unreachable hub (R5)", async () => {
    const port = await harness.occupyPort();
    const bridge = await harness.connect({
      hubPort: port,
      hubCommand: () => harness.fixtureHubCommand(port),
    });

    const first = await bridge.call("list_rooms");
    const second = await bridge.call("create_room", { slug: "alpha" });

    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("CO_CANVAS_HUB_PORT");
    // The session itself is still usable, which a dead server could not manage.
    const tools = await bridge.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "create_room",
      "list_rooms",
      "open_room",
    ]);
  }, 20_000);

  it("names the start-command override when the hub cannot be started (R5)", async () => {
    const port = await freePort();
    const bridge = await harness.connect({
      hubPort: port,
      hubCommand: () => ({ executable: `${harness.root}/there-is-no-hub-here`, args: [] }),
    });

    const result = await bridge.call("list_rooms");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("CO_CANVAS_HUB_CMD");
    // Nothing came up on the port either, so a later call has the same problem.
    await waitFor(async () => (await hubHealth(port)) === null, "something bound the port");
  }, 20_000);
});
