import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendHubLog } from "./log-file.ts";

const runningAsRoot = process.getuid?.() === 0;

describe("hub log write failures", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await chmod(join(dir, "hub.log"), 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("stays silent when the data directory does not exist, creating nothing (R1)", async () => {
    // The pre-bind case: the directory is absent on purpose and the log must not
    // bring one into being, nor make any noise about it.
    const missing = join(tmpdir(), `co-canvas-cli-absent-${process.pid}-${Date.now()}`);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(appendHubLog(missing, "hello")).resolves.toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });

  it.skipIf(runningAsRoot)(
    "surfaces a real write failure to stderr without throwing (R5)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "co-canvas-cli-"));
      dirs.push(dir);
      const logPath = join(dir, "hub.log");
      await writeFile(logPath, "existing\n");
      // Read-only: an append now fails with EACCES for a non-root owner, standing
      // in for an existing-but-unwritable data directory.
      await chmod(logPath, 0o444);

      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(appendHubLog(dir, "hello")).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain("hub.log");
      // The failed write left the file exactly as it was.
      await chmod(logPath, 0o644);
      expect(await readFile(logPath, "utf8")).toBe("existing\n");
    },
  );
});
