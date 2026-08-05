import { describe, expect, it } from "vitest";
import type { HubUrlSources } from "../room/hub-url.ts";
import { resolveHubHttpBase } from "./boards-client.ts";

const sources = (overrides: Partial<HubUrlSources> = {}): HubUrlSources => ({
  search: "",
  origin: "https://boards.example",
  envUrl: undefined,
  dev: false,
  ...overrides,
});

describe("resolveHubHttpBase", () => {
  it("flips the sync socket's ws base to http", () => {
    expect(resolveHubHttpBase(sources({ search: "?hub=http://127.0.0.1:9999" }))).toBe(
      "http://127.0.0.1:9999",
    );
  });

  it("flips wss to https for a same-origin production page", () => {
    expect(resolveHubHttpBase(sources())).toBe("https://boards.example");
  });

  it("uses the loopback hub over http in development", () => {
    expect(resolveHubHttpBase(sources({ dev: true }))).toBe("http://127.0.0.1:4321");
  });
});
