import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Hub } from "./index.ts";
import { createHub } from "./index.ts";
import {
  createDataDirPool,
  getJson,
  liveRooms,
  openRawClient,
  settle,
  stopHubs,
  waitFor,
} from "./test-helpers.ts";

/**
 * The Origin gate on the WebSocket sync upgrade.
 *
 * The hub binds loopback but a browser can still reach loopback, and the sync
 * channel has no per-room auth — so a foreign page opening `ws://…/sync/{slug}`
 * would get full read+write of that board. The gate refuses a present, foreign
 * `Origin`, allows a missing one (non-browser clients like the MCP bridge), and
 * allows the hub's own origin and the dev web origin.
 */
describe("websocket origin gate", () => {
  const dataDirs = createDataDirPool();
  let hub: Hub;
  let url: string;

  beforeEach(async () => {
    hub = createHub({ port: 0, dataDir: await dataDirs.create() });
    url = await hub.start();
  });

  afterEach(async () => {
    try {
      await stopHubs([hub]);
    } finally {
      await dataDirs.removeAll();
    }
  });

  it("refuses a WS upgrade whose Origin is not allowed (R1)", async () => {
    await expect(
      openRawClient(url, "/sync/alpha", { origin: "http://evil.example" }),
    ).rejects.toThrow();

    // The handshake never completed, so no room was ever opened for the slug.
    await settle();
    await expect(getJson(url, "/__rooms")).resolves.toEqual({ rooms: [] });
  });

  it("accepts a WS upgrade that carries no Origin, as the bridge sends (R2)", async () => {
    const client = await openRawClient(url, "/sync/alpha");
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    // The room is attached — a real sync connection, not just an open socket.
    await waitFor(async () => (await liveRooms(url)).some((room) => room.slug === "alpha"));
    client.close();
  });

  it("accepts the dev web origin (R3)", async () => {
    const client = await openRawClient(url, "/sync/alpha", { origin: "http://localhost:5173" });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    await waitFor(async () => (await liveRooms(url)).some((room) => room.slug === "alpha"));
    client.close();
  });

  it("accepts the hub's own origin, as the same-origin production UI sends (R3)", async () => {
    const sameOrigin = `http://${new URL(url).host}`;
    const client = await openRawClient(url, "/sync/beta", { origin: sameOrigin });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    await waitFor(async () => (await liveRooms(url)).some((room) => room.slug === "beta"));
    client.close();
  });

  it("refuses a DNS-rebinding upgrade whose Origin and Host agree but are foreign (R1)", async () => {
    // The bypass a Host-reflecting gate would admit: a page served from
    // `http://attacker.example:PORT` rebinds `attacker.example` to `127.0.0.1`,
    // then opens `ws://attacker.example:PORT/sync/alpha`. The browser sends an
    // `Origin` and a `Host` that agree with each other, so reflecting `Host`
    // ("Origin equals the Host the client dialed") would have let this foreign
    // origin through. Same-origin is pinned to the hub's own loopback bind
    // instead — `127.0.0.1` is an IP literal an attacker cannot rebind — so the
    // foreign `Origin` matches neither loopback literal and the handshake is
    // refused. `ws` sends the spoofed `Host` on the wire, so this exercises the
    // exact request the browser would make.
    const port = Number(new URL(url).port);
    await expect(
      openRawClient(url, "/sync/alpha", {
        origin: `http://attacker.example:${port}`,
        host: `attacker.example:${port}`,
      }),
    ).rejects.toThrow();

    // The handshake never completed, so no room was ever opened for the slug.
    await settle();
    await expect(getJson(url, "/__rooms")).resolves.toEqual({ rooms: [] });
  });
});
