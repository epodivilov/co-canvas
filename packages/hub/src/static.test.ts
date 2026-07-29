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

  it("404s every non-endpoint path when no static directory is configured (R5)", async () => {
    const url = await startHub();

    for (const path of ["/", "/room/some-board", "/assets/app.js"]) {
      const response = await rawGet(url, path);
      expect(response.status, `expected 404 for ${path}`).toBe(404);
    }
  });
});
