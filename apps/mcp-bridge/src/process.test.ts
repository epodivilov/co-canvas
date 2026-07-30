import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness, HubHandle } from "./test-helpers.ts";
import {
  commandEnvValue,
  connectBridgeProcess,
  createHarness,
  FIXTURE_OPENER_RECORD,
  FIXTURE_OPENER_STDOUT,
  hubPeers,
  OPENER_LOG_ENV,
  settle,
  spawnBridgeProcess,
  textOf,
  waitFor,
} from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

function childEnv(harness: Harness, hub: HubHandle, opener: string): Record<string, string> {
  return {
    CO_CANVAS_HUB_PORT: String(hub.port),
    CO_CANVAS_HUB_CMD: commandEnvValue(harness.fixtureHubCommand(hub.port)),
    CO_CANVAS_OPEN_CMD: JSON.stringify([process.execPath, opener]),
    [OPENER_LOG_ENV]: harness.openerLog,
  };
}

describe("the bridge as a process", () => {
  it("keeps stdout to MCP messages while serving a tool call (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = await connectBridgeProcess(
      harness,
      childEnv(harness, hub, FIXTURE_OPENER_RECORD),
    );

    const result = (await bridge.client.callTool({
      name: "create_room",
      arguments: { slug: "alpha" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(`${hub.url}/room/alpha`);
    expect(await hubPeers(hub.url, "alpha")).toBe(1);
  }, 30_000);

  it("keeps stdout clean while the opener writes to its own (R7)", async () => {
    const hub = await harness.startHub();
    // Driven by hand rather than through the SDK client: that client skips a
    // stdout line it cannot parse and carries on, so a scenario built on it
    // would pass against a bridge that let the opener into the stream.
    const bridge = spawnBridgeProcess(harness, childEnv(harness, hub, FIXTURE_OPENER_STDOUT));
    await bridge.initialize();

    await bridge.request("tools/call", { name: "create_room", arguments: { slug: "alpha" } });
    const opened = await bridge.request("tools/call", {
      name: "open_room",
      arguments: { slug: "alpha" },
    });
    // Give the opener every chance to say something before the next response.
    await settle(500);
    const listed = await bridge.request("tools/call", { name: "list_rooms" });

    expect(bridge.stdoutViolations()).toEqual([]);
    expect(opened.result).toMatchObject({ structuredContent: { opened: true } });
    expect(listed.result).toMatchObject({
      structuredContent: { rooms: [{ slug: "alpha", url: `${hub.url}/room/alpha`, peers: 1 }] },
    });
  }, 30_000);

  it("exits successfully on its own when stdin closes (R7)", async () => {
    const hub = await harness.startHub();
    const bridge = spawnBridgeProcess(harness, childEnv(harness, hub, FIXTURE_OPENER_RECORD));
    await bridge.initialize();
    await bridge.request("tools/call", { name: "create_room", arguments: { slug: "alpha" } });
    expect(await hubPeers(hub.url, "alpha")).toBe(1);

    bridge.closeStdin();
    const exit = await bridge.whenExited(10_000);

    // Success status, and reached without anybody signalling the process.
    expect(exit).toEqual({ code: 0, signal: null });
    await waitFor(
      async () => (await hubPeers(hub.url, "alpha")) === 0,
      "the hub still reports the bridge as a peer",
    );
  }, 30_000);
});
