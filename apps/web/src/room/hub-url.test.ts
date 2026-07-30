import { describe, expect, it } from "vitest";
import { DEV_HUB_URL, type HubUrlSources, resolveHubBaseUrl, resolveSyncUrl } from "./hub-url";

const sources = (overrides: Partial<HubUrlSources> = {}): HubUrlSources => ({
  search: "",
  origin: "https://boards.example",
  envUrl: undefined,
  dev: false,
  ...overrides,
});

describe("resolveHubBaseUrl", () => {
  it("prefers the hub query parameter over everything else", () => {
    const resolved = resolveHubBaseUrl(
      sources({ search: "?hub=http://127.0.0.1:9999", envUrl: "http://env.example", dev: true }),
    );
    expect(resolved).toBe("ws://127.0.0.1:9999");
  });

  it("falls back to VITE_HUB_URL when no query parameter is given", () => {
    expect(resolveHubBaseUrl(sources({ envUrl: "http://env.example:4321", dev: true }))).toBe(
      "ws://env.example:4321",
    );
  });

  it("falls back to the loopback hub in development", () => {
    expect(resolveHubBaseUrl(sources({ dev: true }))).toBe(DEV_HUB_URL);
  });

  it("falls back to the page origin in production", () => {
    expect(resolveHubBaseUrl(sources())).toBe("wss://boards.example");
  });

  it("maps http to ws and https to wss", () => {
    expect(resolveHubBaseUrl(sources({ search: "?hub=http://a.example" }))).toBe("ws://a.example");
    expect(resolveHubBaseUrl(sources({ search: "?hub=https://a.example" }))).toBe(
      "wss://a.example",
    );
  });

  it("passes a websocket url through unchanged", () => {
    expect(resolveHubBaseUrl(sources({ search: "?hub=ws://a.example:1234" }))).toBe(
      "ws://a.example:1234",
    );
    expect(resolveHubBaseUrl(sources({ search: "?hub=wss://a.example" }))).toBe("wss://a.example");
  });

  it("strips a trailing slash so the sync path is not doubled", () => {
    expect(resolveHubBaseUrl(sources({ search: "?hub=http://a.example:4321/" }))).toBe(
      "ws://a.example:4321",
    );
  });

  it("keeps a path prefix the hub is mounted under", () => {
    expect(resolveHubBaseUrl(sources({ search: "?hub=http://a.example/canvas/" }))).toBe(
      "ws://a.example/canvas",
    );
  });

  it("ignores an empty override and moves on to the next source", () => {
    expect(resolveHubBaseUrl(sources({ search: "?hub=", envUrl: "http://env.example" }))).toBe(
      "ws://env.example",
    );
    expect(resolveHubBaseUrl(sources({ envUrl: "", dev: true }))).toBe(DEV_HUB_URL);
  });

  it("ignores an unusable override rather than blanking the room", () => {
    expect(
      resolveHubBaseUrl(sources({ search: "?hub=not a url", envUrl: "http://env.example" })),
    ).toBe("ws://env.example");
    expect(resolveHubBaseUrl(sources({ search: "?hub=ftp://a.example", dev: true }))).toBe(
      DEV_HUB_URL,
    );
  });

  it("resolves the loopback hub to the port the hub binds by default", () => {
    expect(DEV_HUB_URL).toBe("ws://127.0.0.1:4321");
  });
});

describe("resolveSyncUrl", () => {
  it("appends the sync prefix that y-websocket completes with the room name", () => {
    expect(resolveSyncUrl(sources({ search: "?hub=http://127.0.0.1:4321" }))).toBe(
      "ws://127.0.0.1:4321/sync",
    );
  });
});
