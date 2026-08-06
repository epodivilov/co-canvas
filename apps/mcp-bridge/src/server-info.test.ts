/**
 * CC-27 R2: the bridge built from source carries no `__CO_CANVAS_VERSION__`
 * define — vitest runs the `.ts` through esbuild, which never applies it, just
 * as a `node --experimental-strip-types` dev start does not. So `serverInfo`'s
 * `version` must resolve to the fallback string without throwing a
 * `ReferenceError` on the undefined token. R1 — the injected value on the
 * shipped product — is proven by the packaged-tarball test in `apps/cli`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { CommandSpec } from "./command.ts";
import { createBridge } from "./server.ts";

describe("serverInfo.version (CC-27 R2)", () => {
  it("resolves to a non-empty string with no build-time define applied", async () => {
    // Reading serverInfo touches neither command, so an unreachable stub for
    // each keeps this to the handshake alone.
    const unreachable: CommandSpec = { executable: "/co-canvas/no-such-command", args: [] };
    const bridge = createBridge({ hubCommand: () => unreachable, openCommand: unreachable });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cc-27", version: "0.0.0" });
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // `getServerVersion()` is the `serverInfo` the initialize handshake carried.
      const info = client.getServerVersion();
      expect(info?.name).toBe("co-canvas");
      expect(typeof info?.version).toBe("string");
      expect(info?.version).not.toBe("");
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
