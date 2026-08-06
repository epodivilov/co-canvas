/**
 * The packed-tarball gate (R2–R5): `npm pack` the package, install the tarball
 * into a directory that holds none of this repo or its workspace, and drive the
 * installed `co-canvas` command the way an MCP client would.
 *
 * This is the one scenario that proves the product a publish ships: no source,
 * no `@co-canvas/*` on disk, the hub spawned from inside the package, and the
 * `apps/web` build served from the same install.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  builtCliEntry,
  CLI_DIR,
  connectMcp,
  freePort,
  inheritedEnv,
  killHubFromLock,
  ROOM_TOOLS,
  textOf,
} from "./support.ts";

interface PackedManifest {
  name?: string;
  version?: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

let workspace: string;
let installDir: string;
let installedBin: string;
let packedFiles: string[];
let manifest: PackedManifest;
const homesToReap: string[] = [];

beforeAll(async () => {
  // The tarball is only meaningful once the package is built; say so plainly.
  builtCliEntry();

  workspace = await mkdtemp(join(tmpdir(), "co-canvas-pack-"));

  // Pack. `--json` reports the exact file list a publish would ship.
  const packed = await exec("npm", ["pack", "--json", "--pack-destination", workspace], CLI_DIR);
  const info = JSON.parse(packed.stdout)[0] as { filename: string; files: { path: string }[] };
  const tarball = join(workspace, info.filename);
  packedFiles = info.files.map((file) => file.path.replace(/^package\//, ""));

  // Read the manifest the tarball carries, straight out of the archive.
  const extractDir = join(workspace, "extract");
  await exec("mkdir", ["-p", extractDir], workspace);
  await exec("tar", ["-xzf", tarball, "-C", extractDir], workspace);
  manifest = JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8"));

  // Install into a directory that is not part of this repo or workspace: no
  // pnpm links, no `@co-canvas/*` resolvable, only what the manifest declares.
  installDir = join(workspace, "host");
  await exec("mkdir", ["-p", installDir], workspace);
  await writeFile(
    join(installDir, "package.json"),
    JSON.stringify({ name: "co-canvas-install-host", version: "0.0.0", private: true }),
  );
  const install = await exec(
    "npm",
    ["install", tarball, "--no-audit", "--no-fund", "--loglevel", "error"],
    installDir,
  );
  if (install.code !== 0) {
    throw new Error(`installing the tarball failed:\n${install.stderr}\n${install.stdout}`);
  }
  installedBin = join(installDir, "node_modules", ".bin", "co-canvas");
}, 180_000);

afterAll(async () => {
  for (const home of homesToReap) killHubFromLock(home);
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

/** A private HOME and a free port, so each session's hub is isolated and reapable. */
async function session(extraEnv: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), "co-canvas-pack-home-"));
  homesToReap.push(home);
  const port = await freePort();
  const mcp = await connectMcp(
    installedBin,
    ["mcp"],
    {
      HOME: home,
      CO_CANVAS_HUB_PORT: String(port),
      // Nothing here opens a browser; a command that cannot run makes an accidental
      // open_room fail loudly rather than launch one.
      CO_CANVAS_OPEN_CMD: JSON.stringify([join(home, "no-opener-expected")]),
      ...extraEnv,
    },
    // Run from the install dir, outside this repo, so nothing resolves up the tree.
    installDir,
  );
  return {
    mcp,
    port,
    home,
    async close() {
      await mcp.close();
      killHubFromLock(home);
    },
  };
}

describe("the packed co-canvas tarball", () => {
  it("publishes as co-canvas — not private, semver, exact bin/files, clean deps (R5)", () => {
    expect(manifest.name).toBe("co-canvas");
    expect(manifest.private ?? false).toBe(false);
    expect(manifest.version ?? "").toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.version).not.toBe("0.0.0");
    expect(manifest.bin).toEqual({ "co-canvas": "./dist/main.js" });
    expect(manifest.files ?? []).toContain("dist");

    // Every dependency block a publish would carry must be resolvable from the
    // public registry: no private workspace package, no `workspace:` protocol —
    // and npm does not rewrite the protocol, so it must simply not be here. Both
    // blocks are checked, since a publish carries devDependencies too.
    const allDeps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    for (const [name, range] of Object.entries(allDeps)) {
      expect(name.startsWith("@co-canvas/"), `${name} is a private workspace dependency`).toBe(
        false,
      );
      expect(String(range), `${name} uses the workspace protocol`).not.toContain("workspace:");
    }
  });

  it("packs the bridge entry, the hub build and the frontend — no source, no symlink (R4, R5)", () => {
    expect(packedFiles).toContain("dist/main.js"); // the bridge dispatcher
    expect(packedFiles).toContain("dist/hub/main.js"); // the Node hub it spawns
    expect(packedFiles).toContain("dist/hub/web/index.html"); // the frontend
    expect(packedFiles.some((file) => file.startsWith("dist/hub/web/assets/"))).toBe(true);

    // Built artifacts only: no TypeScript source, no bundled workspace tree.
    expect(packedFiles.filter((file) => file.endsWith(".ts"))).toEqual([]);
    expect(packedFiles.some((file) => file.includes("node_modules"))).toBe(false);
    expect(packedFiles.some((file) => file.includes("/src/") || file.startsWith("src/"))).toBe(
      false,
    );
  });

  it("round-trips a room over stdio, hub spawned and board served (R4, R2)", async () => {
    const s = await session({});
    try {
      expect(await s.mcp.listTools()).toEqual([...ROOM_TOOLS]);

      const created = await s.mcp.call("create_room", { slug: "demo" });
      expect(created.isError).toBeFalsy();
      expect(created.structuredContent).toMatchObject({ slug: "demo", created: true });

      // Read it back through a second tool call.
      const listed = await s.mcp.call("list_rooms");
      expect(listed.isError).toBeFalsy();
      expect(textOf(listed)).toContain("demo");

      // The hub the bridge spawned from inside the package serves the board.
      const response = await fetch(`http://127.0.0.1:${s.port}/room/demo`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("text/html");
    } finally {
      await s.close();
    }
  }, 60_000);

  it("reports the built package version in serverInfo, not a hardcoded 0.0.0 (CC-27 R1)", async () => {
    const s = await session({});
    try {
      // `getServerVersion()` returns the `serverInfo` the server sent on the
      // initialize handshake `connectMcp` already completed.
      const info = s.mcp.client.getServerVersion();
      // The manifest is read from the tarball at test time — the same `version`
      // as `apps/cli/package.json`. Asserting it equals the current manifest
      // version, and is not the old `0.0.0` placeholder, catches the regression
      // this fix closes (the reverted constant) and a stale hardcode on the next
      // Changesets bump.
      expect(info?.version).toBe(manifest.version);
      // The bug this closes: the constant used to be "0.0.0" for every release.
      expect(info?.version).not.toBe("0.0.0");
    } finally {
      await s.close();
    }
  }, 60_000);

  it("serves the packaged frontend, its assets, and keeps endpoints JSON (R3)", async () => {
    const s = await session({});
    try {
      await s.mcp.call("create_room", { slug: "demo" });
      const base = `http://127.0.0.1:${s.port}`;

      const html = await fetch(`${base}/room/demo`);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type") ?? "").toContain("text/html");
      const body = await html.text();

      const assets = assetUrls(body);
      expect(assets.length, "the frontend references at least one asset").toBeGreaterThan(0);
      for (const url of assets) {
        const asset = await fetch(`${base}${url}`);
        expect(asset.status, `asset ${url}`).toBe(200);
        const type = asset.headers.get("content-type") ?? "";
        const expected = expectedType(url);
        if (expected !== null) expect(type, `content-type of ${url}`).toContain(expected);
      }

      // The SPA fallback must not swallow the hub's own JSON endpoints.
      const health = await fetch(`${base}/health`);
      expect(health.headers.get("content-type") ?? "").toContain("application/json");
      const rooms = await fetch(`${base}/__rooms`);
      expect(rooms.headers.get("content-type") ?? "").toContain("application/json");
    } finally {
      await s.close();
    }
  }, 60_000);

  it("honours CO_CANVAS_HUB_CMD over the bundled hub (R2)", async () => {
    const home = await mkdtemp(join(tmpdir(), "co-canvas-pack-home-"));
    homesToReap.push(home);
    const port = await freePort();
    const bogus = join(home, "there-is-no-hub-here");
    const mcp = await connectMcp(
      installedBin,
      ["mcp"],
      {
        HOME: home,
        CO_CANVAS_HUB_PORT: String(port),
        CO_CANVAS_HUB_CMD: JSON.stringify([bogus]),
        CO_CANVAS_OPEN_CMD: JSON.stringify([join(home, "no-opener-expected")]),
      },
      installDir,
    );
    try {
      const result = await mcp.call("create_room", { slug: "demo" });
      // The override cannot be started, so the call fails — which it only can if
      // the override replaced the bundled hub rather than being ignored for it.
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("CO_CANVAS_HUB_CMD");
    } finally {
      await mcp.close();
      killHubFromLock(home);
    }
  }, 60_000);
});

/** Absolute asset URLs a built index.html references, restricted to ones with an extension. */
function assetUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1];
    if (url === undefined) continue;
    if (!url.startsWith("/")) continue; // same-origin, absolute paths only
    if (!/\.[a-z0-9]+$/i.test(url)) continue; // must name a file, not a route
    urls.add(url);
  }
  return [...urls];
}

/** The substring the hub's content type carries for a given asset extension, or null to skip. */
function expectedType(url: string): string | null {
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    css: "text/css",
    svg: "image/svg",
    png: "image/png",
    ico: "icon",
    json: "json",
    woff: "woff",
    woff2: "woff2",
  };
  const extension = url.split(".").pop()?.toLowerCase() ?? "";
  return map[extension] ?? null;
}

function exec(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd,
      env: inheritedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
