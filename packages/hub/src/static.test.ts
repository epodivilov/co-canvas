import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index";
import { createHub } from "./index";
import { rawGet } from "./test-helpers";

const fixtureDir = fileURLToPath(new URL("./__fixtures__/static", import.meta.url));

describe("static serving", () => {
  let hub: Hub | null = null;

  afterEach(async () => {
    await hub?.stop();
    hub = null;
  });

  async function startHub(staticDir?: string): Promise<string> {
    hub = createHub(staticDir === undefined ? { port: 0 } : { port: 0, staticDir });
    return await hub.start();
  }

  it("serves an existing asset with its bytes and content type (R5)", async () => {
    const url = await startHub(fixtureDir);

    const response = await rawGet(url, "/assets/app.js");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/javascript/);
    expect(response.body).toEqual(await readFile(`${fixtureDir}/assets/app.js`));
  });

  it("falls back to index.html for an extension-less path (R5)", async () => {
    const url = await startHub(fixtureDir);

    const response = await rawGet(url, "/room/some-board");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(await readFile(`${fixtureDir}/index.html`));
  });

  it("404s a missing asset instead of masking it with index.html (R5)", async () => {
    const url = await startHub(fixtureDir);

    const response = await rawGet(url, "/assets/missing.js");

    expect(response.status).toBe(404);
    expect(response.body.toString("utf8")).not.toContain("co-canvas static fixture index");
  });

  it("404s a raw traversal path that reaches the socket unnormalized (R5)", async () => {
    const url = await startHub(fixtureDir);

    const response = await rawGet(url, "/../../etc/passwd");

    expect(response.status).toBe(404);
    expect(response.body.toString("utf8")).not.toContain("root:");
  });

  it("404s a traversal smuggled through encoded slashes (R5)", async () => {
    const url = await startHub(fixtureDir);

    const response = await rawGet(url, "/..%2f..%2fetc/passwd");

    expect(response.status).toBe(404);
    expect(response.body.toString("utf8")).not.toContain("root:");
  });

  it("404s a traversal whose dot segments are percent-encoded (R5)", async () => {
    const url = await startHub(fixtureDir);

    // Undecoded this reads as an ordinary nested path: no segment is literally
    // `..` and nothing about it begins with a dot, so it slips past a purely
    // textual containment check. It only becomes a traversal after
    // percent-decoding, which is the step this pins.
    const response = await rawGet(url, "/assets/%2e%2e/%2e%2e/etc/passwd");

    expect(response.status).toBe(404);
    expect(response.body.toString("utf8")).not.toContain("root:");
  });

  it("keeps its own endpoints reachable behind a static directory (R5, R6)", async () => {
    const url = await startHub(fixtureDir);

    const health = await rawGet(url, "/health");
    const rooms = await rawGet(url, "/__rooms");

    // Both paths are extension-less, so an SPA fallback matched ahead of them
    // would answer with index.html and the API would silently disappear.
    expect(health.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(health.body.toString("utf8"))).toMatchObject({
      service: "co-canvas-hub",
    });
    expect(rooms.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(rooms.body.toString("utf8"))).toEqual({ rooms: [] });
  });

  it("404s every non-endpoint path when no static directory is configured (R5)", async () => {
    const url = await startHub();

    for (const path of ["/", "/room/some-board", "/assets/app.js"]) {
      const response = await rawGet(url, path);
      expect(response.status, `expected 404 for ${path}`).toBe(404);
    }
  });
});
