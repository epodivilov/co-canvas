/**
 * The `co-canvas` subcommand dispatcher (R1), driven as the built `bin` a
 * publish ships. Every scenario spawns `dist/main.js` — the dispatcher must
 * survive bundling, and its `mcp` branch shares the bridge's stdout with the
 * MCP stream, which only the real process framing exercises.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  builtCliEntry,
  captureMcpStdout,
  freePort,
  ROOM_TOOLS,
  runToCompletion,
} from "./support.ts";

let entry: string;
let home: string;

beforeAll(async () => {
  entry = builtCliEntry();
  home = await mkdtemp(join(tmpdir(), "co-canvas-cli-dispatch-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Runs the dispatcher through `node`, so the shebang and exec bit are not in play. */
function run(...args: string[]) {
  return runToCompletion(process.execPath, [entry, ...args]);
}

describe("co-canvas subcommand dispatch (R1)", () => {
  it("answers the MCP handshake and lists the room tools under `mcp`", async () => {
    const port = await freePort();
    const capture = await captureMcpStdout(process.execPath, [entry, "mcp"], {
      HOME: home,
      // A port nothing answers on: the handshake and tools/list never need a hub,
      // so no hub is started and nothing has to be reaped.
      CO_CANVAS_HUB_PORT: String(port),
    });

    expect(capture.tools).toEqual([...ROOM_TOOLS]);
  }, 30_000);

  it("keeps stdout to JSON-RPC frames under `mcp` — no banner leaks in", async () => {
    const port = await freePort();
    const capture = await captureMcpStdout(process.execPath, [entry, "mcp"], {
      HOME: home,
      CO_CANVAS_HUB_PORT: String(port),
    });

    expect(capture.nonJson).toEqual([]);
    // And it actually said something, so an empty stream is not passing by default.
    expect(capture.lines.length).toBeGreaterThan(0);
  }, 30_000);

  it("writes usage to stderr and exits non-zero with no subcommand", async () => {
    const result = await run();

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mcp");
    expect(result.stderr.toLowerCase()).toContain("usage");
  });

  it("writes usage to stderr and exits non-zero on an unknown subcommand", async () => {
    const result = await run("frobnicate");

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("frobnicate");
    expect(result.stderr).toContain("mcp");
  });

  it("writes usage naming `mcp` to stdout and exits zero under --help", async () => {
    const result = await run("--help");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("mcp");
    expect(result.stdout.toLowerCase()).toContain("usage");
  });

  it("writes usage to stdout and exits zero under the `help` subcommand", async () => {
    const result = await run("help");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mcp");
  });
});
