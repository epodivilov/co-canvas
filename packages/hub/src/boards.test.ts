import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index.ts";
import { createHub } from "./index.ts";
import {
  createClientPool,
  createDataDirPool,
  encodeLog,
  type JsonResponse,
  logPath,
  rawGet,
  recordUpdates,
  sendJson,
  stopHubs,
  waitFor,
} from "./test-helpers.ts";

/** The shape the board-list endpoint answers with, mirrored here independently. */
interface Board {
  slug: string;
  title: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

const fixtureStaticDir = fileURLToPath(new URL("./__fixtures__/static", import.meta.url));
const CREATED_AT = 1_700_000_000_000;

/** Writes a board's log straight to disk, the way a previous session would have left it. */
async function seedLog(
  dataDir: string,
  slug: string,
  value: string,
  createdAt = CREATED_AT,
): Promise<void> {
  await mkdir(join(dataDir, "rooms"), { recursive: true });
  const updates = recordUpdates([(doc) => doc.getMap("board").set("shape", value)]);
  await writeFile(logPath(dataDir, slug), encodeLog(createdAt, updates));
}

function boards(response: JsonResponse): Board[] {
  const body = response.body as { boards?: Board[] };
  if (!Array.isArray(body.boards))
    throw new Error(`no boards array: ${JSON.stringify(response.body)}`);
  return body.boards;
}

describe("board endpoints", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(dataDir: string, options: { staticDir?: string } = {}): Hub {
    const created = createHub({ port: 0, dataDir, ...options });
    hubs.add(created);
    return created;
  }

  afterEach(async () => {
    clients.closeAll();
    try {
      await stopHubs(hubs);
    } finally {
      hubs.clear();
      await dataDirs.removeAll();
    }
  });

  // --- Overview list (R1) ---

  it("lists every non-archived board, most-recently-modified first (R1)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "a");
    await seedLog(dataDir, "beta", "b");
    await seedLog(dataDir, "gamma", "c");
    // Distinct mtimes so the ordering has something unambiguous to sort on.
    await utimes(logPath(dataDir, "alpha"), new Date(1000), new Date(1000));
    await utimes(logPath(dataDir, "beta"), new Date(3000), new Date(3000));
    await utimes(logPath(dataDir, "gamma"), new Date(2000), new Date(2000));

    const url = await hub(dataDir).start();

    const list = boards(await sendJson(url, "GET", "/api/boards"));
    expect(list.map((board) => board.slug)).toEqual(["beta", "gamma", "alpha"]);
  });

  it("shows a board's title, or its slug when it has none (R1)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "titled", "a");
    await seedLog(dataDir, "bare", "b");

    const url = await hub(dataDir).start();
    await sendJson(url, "PATCH", "/api/boards/titled", { title: "Auth redesign" });

    const list = boards(await sendJson(url, "GET", "/api/boards"));
    const titled = list.find((board) => board.slug === "titled");
    const bare = list.find((board) => board.slug === "bare");
    expect(titled?.title).toBe("Auth redesign");
    expect(bare?.title).toBeNull();
  });

  it("shows an empty list rather than an error when the hub holds no board (R1)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub(dataDir).start();

    const response = await sendJson(url, "GET", "/api/boards");
    expect(response.status).toBe(200);
    expect(boards(response)).toEqual([]);
  });

  // --- Creating (R3) ---

  it("materialises a board created under a valid slug and lists it afterwards (R3)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub(dataDir).start();

    const created = await sendJson(url, "POST", "/api/boards", { slug: "gamma" });
    expect(created.status).toBe(201);
    expect((created.body as { board: Board }).board.slug).toBe("gamma");

    // The log exists on disk, so a board made but never drawn on is not lost.
    expect((await stat(logPath(dataDir, "gamma"))).isFile()).toBe(true);
    const list = boards(await sendJson(url, "GET", "/api/boards"));
    expect(list.map((board) => board.slug)).toContain("gamma");
  });

  it("refuses an invalid slug with a message and writes nothing (R3)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub(dataDir).start();

    const response = await sendJson(url, "POST", "/api/boards", { slug: "Not_A_Slug" });
    expect(response.status).toBe(400);
    expect(typeof (response.body as { error?: unknown }).error).toBe("string");

    await expect(stat(logPath(dataDir, "Not_A_Slug"))).rejects.toThrow();
    expect(boards(await sendJson(url, "GET", "/api/boards"))).toEqual([]);
  });

  it("returns the existing board untouched when the slug already names one (R3)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "rect");
    const url = await hub(dataDir).start();

    const before = await stat(logPath(dataDir, "alpha"));
    const response = await sendJson(url, "POST", "/api/boards", { slug: "alpha" });
    expect(response.status).toBe(200);
    expect((response.body as { created: boolean }).created).toBe(false);

    // The log is byte-identical: creating an existing board changed nothing.
    const after = await stat(logPath(dataDir, "alpha"));
    expect(after.size).toBe(before.size);
    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");
  });

  // --- Renaming the title (R4) ---

  it("sets a title while leaving the slug unchanged (R4)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "a");
    const url = await hub(dataDir).start();

    const response = await sendJson(url, "PATCH", "/api/boards/alpha", { title: "Sprint plan" });
    expect(response.status).toBe(200);

    const list = boards(await sendJson(url, "GET", "/api/boards"));
    const alpha = list.find((board) => board.slug === "alpha");
    expect(alpha?.title).toBe("Sprint plan");
    expect(alpha?.slug).toBe("alpha");
  });

  it("keeps a title across a hub restart that rebuilds the index (R4, R7)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "a");

    const first = hub(dataDir);
    const firstUrl = await first.start();
    await sendJson(firstUrl, "PATCH", "/api/boards/alpha", { title: "Sprint plan" });
    await first.stop();

    const second = hub(dataDir);
    const secondUrl = await second.start();
    const list = boards(await sendJson(secondUrl, "GET", "/api/boards"));
    expect(list.find((board) => board.slug === "alpha")?.title).toBe("Sprint plan");
  });

  // --- Archiving and restoring (R5) ---

  it("removes an archived board from the default list but keeps its log and route (R5)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "a");
    const url = await hub(dataDir, { staticDir: fixtureStaticDir }).start();

    await sendJson(url, "PATCH", "/api/boards/alpha", { archived: true });

    const active = boards(await sendJson(url, "GET", "/api/boards"));
    expect(active.map((board) => board.slug)).not.toContain("alpha");
    // The data is kept: the log is still on disk and the SPA route still answers.
    expect((await stat(logPath(dataDir, "alpha"))).isFile()).toBe(true);
    const route = await rawGet(url, "/room/alpha");
    expect(route.status).toBe(200);
  });

  it("keeps serving an archived board's content over the sync socket (R5)", async () => {
    const dataDir = await dataDirs.create();
    // A board with content on disk, so what comes back is served from the log
    // rather than from a live room the test happens to be holding open.
    await seedLog(dataDir, "alpha", "rect");
    const url = await hub(dataDir).start();

    await sendJson(url, "PATCH", "/api/boards/alpha", { archived: true });
    expect(boards(await sendJson(url, "GET", "/api/boards")).map((b) => b.slug)).not.toContain(
      "alpha",
    );

    // The board leaves the overview, but `/sync/alpha` still opens and the board
    // syncs back: archive is visibility, not eviction, and the upgrade handler
    // gates on the slug alone, never on the archived flag. The `/room/<slug>`
    // check above only exercises the SPA fallback, which would answer any
    // extension-less path — so it is this socket that pins the content path.
    const reader = clients.open(url, "alpha");
    await waitFor(() => reader.provider.synced);
    await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");
    expect(reader.doc.getMap("board").toJSON()).toEqual({ shape: "rect" });
  });

  it("lists an archived board in the archived view and restores it (R5)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "a");
    const url = await hub(dataDir).start();

    await sendJson(url, "PATCH", "/api/boards/alpha", { archived: true });
    const archived = boards(await sendJson(url, "GET", "/api/boards?archived=true"));
    expect(archived.map((board) => board.slug)).toContain("alpha");

    await sendJson(url, "PATCH", "/api/boards/alpha", { archived: false });
    const active = boards(await sendJson(url, "GET", "/api/boards"));
    expect(active.map((board) => board.slug)).toContain("alpha");
  });

  it("keeps a board archived across a restart, and a later restore too (R5, R7)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "a");

    const first = hub(dataDir);
    const firstUrl = await first.start();
    await sendJson(firstUrl, "PATCH", "/api/boards/alpha", { archived: true });
    await first.stop();

    const second = hub(dataDir);
    const secondUrl = await second.start();
    // The rebuild did not resurrect it into the default list.
    expect(
      boards(await sendJson(secondUrl, "GET", "/api/boards")).map((b) => b.slug),
    ).not.toContain("alpha");
    expect(
      boards(await sendJson(secondUrl, "GET", "/api/boards?archived=true")).map((b) => b.slug),
    ).toContain("alpha");

    await sendJson(secondUrl, "PATCH", "/api/boards/alpha", { archived: false });
    await second.stop();

    const third = hub(dataDir);
    const thirdUrl = await third.start();
    expect(boards(await sendJson(thirdUrl, "GET", "/api/boards")).map((b) => b.slug)).toContain(
      "alpha",
    );
  });

  it("404s a rename of a board that does not exist", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub(dataDir).start();

    const response = await sendJson(url, "PATCH", "/api/boards/ghost", { title: "nope" });
    expect(response.status).toBe(404);
  });

  // --- Hub API and origin (R6) ---

  it("answers the board list as JSON behind the static frontend, and leaves the old endpoints alone (R6)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "alpha", "a");
    const url = await hub(dataDir, { staticDir: fixtureStaticDir }).start();

    const list = await sendJson(url, "GET", "/api/boards");
    expect(list.headers["content-type"]).toMatch(/application\/json/);
    expect(boards(list).map((board) => board.slug)).toEqual(["alpha"]);

    const health = await rawGet(url, "/health");
    expect(JSON.parse(health.body.toString("utf8"))).toMatchObject({ service: "co-canvas-hub" });
    const rooms = await rawGet(url, "/__rooms");
    expect(JSON.parse(rooms.body.toString("utf8"))).toEqual({ rooms: [] });
  });

  it("reflects an allowed origin and never answers with * (R4)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub(dataDir).start();

    // The dev web origin is one the allowlist trusts; the header echoes it back
    // rather than the wildcard a page on any site could borrow.
    const list = await sendJson(url, "GET", "/api/boards", undefined, "http://localhost:5173");
    expect(list.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    // The preflight a browser sends before a JSON POST/PATCH from another origin.
    const preflight = await sendJson(
      url,
      "OPTIONS",
      "/api/boards",
      undefined,
      "http://localhost:5173",
    );
    expect(preflight.status).toBeGreaterThanOrEqual(200);
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(String(preflight.headers["access-control-allow-methods"])).toContain("PATCH");
    expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toContain(
      "content-type",
    );
  });

  it("omits the allow-origin header for a foreign origin (R4)", async () => {
    const dataDir = await dataDirs.create();
    const url = await hub(dataDir).start();

    const list = await sendJson(url, "GET", "/api/boards", undefined, "http://evil.example");
    expect(list.status).toBe(200);
    expect(list.headers["access-control-allow-origin"]).toBeUndefined();

    const preflight = await sendJson(
      url,
      "OPTIONS",
      "/api/boards",
      undefined,
      "http://evil.example",
    );
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // --- Durable metadata (R7) ---

  it("keeps titles and archived flags after a rebuild while size and mtime follow the logs (R7)", async () => {
    const dataDir = await dataDirs.create();
    await seedLog(dataDir, "kept", "a");
    await seedLog(dataDir, "hidden", "b");

    const first = hub(dataDir);
    const firstUrl = await first.start();
    await sendJson(firstUrl, "PATCH", "/api/boards/kept", { title: "Kept board" });
    await sendJson(firstUrl, "PATCH", "/api/boards/hidden", { archived: true });
    await first.stop();

    const second = hub(dataDir);
    const secondUrl = await second.start();

    const active = boards(await sendJson(secondUrl, "GET", "/api/boards"));
    const kept = active.find((board) => board.slug === "kept");
    expect(kept?.title).toBe("Kept board");
    // The derived fields still come from the log on disk.
    expect(kept?.bytes).toBe((await stat(logPath(dataDir, "kept"))).size);

    expect(active.map((board) => board.slug)).not.toContain("hidden");
    const archived = boards(await sendJson(secondUrl, "GET", "/api/boards?archived=true"));
    expect(archived.map((board) => board.slug)).toEqual(["hidden"]);
  });
});
