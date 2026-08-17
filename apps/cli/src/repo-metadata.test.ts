/**
 * Public-repo prep (CC-34, R1–R3): the paperwork a visitor expects once
 * `epodivilov/co-canvas` is public — a root `LICENSE` that matches the `MIT`
 * claimed in the manifest, and npm metadata that links the published package
 * back to its source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Manifest {
  license?: string;
  author?: string;
  repository?: { type?: string; url?: string };
  homepage?: string;
  bugs?: { url?: string } | string;
  keywords?: unknown;
  engines?: { node?: string };
}

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const manifest: Manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, "apps", "cli", "package.json"), "utf8"),
);

describe("root LICENSE (R1)", () => {
  it("is the MIT text and names the manifest's author", () => {
    const license = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Evgenii Podivilov");
    // Same holder the manifest's `author` field names — no invented spelling.
    expect(manifest.author).toBe("Evgenii Podivilov");
  });

  it("agrees with the `license` field in apps/cli/package.json", () => {
    expect(manifest.license).toBe("MIT");
  });
});

describe("apps/cli/package.json npm metadata (R2, R3)", () => {
  it("repository/homepage/bugs resolve to github.com/epodivilov/co-canvas", () => {
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/epodivilov/co-canvas.git",
    });
    expect(manifest.homepage).toContain("github.com/epodivilov/co-canvas");
    const bugsUrl = typeof manifest.bugs === "string" ? manifest.bugs : manifest.bugs?.url;
    expect(bugsUrl).toBe("https://github.com/epodivilov/co-canvas/issues");
  });

  it("declares a non-empty keywords array and engines.node >=22", () => {
    expect(Array.isArray(manifest.keywords)).toBe(true);
    const keywords = manifest.keywords as unknown[];
    expect(keywords.length).toBeGreaterThan(0);
    for (const keyword of keywords) expect(typeof keyword).toBe("string");

    expect(manifest.engines?.node).toBe(">=22");
  });
});
