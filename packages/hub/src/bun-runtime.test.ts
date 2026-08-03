import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Bun replaces `ws` with a native module whose upgraded socket has no
 * `pause`/`resume`, so the hub's old receiver-pausing upgrade path threw
 * `TypeError: webSocket.pause is not a function` under it. This runs the hub
 * under Bun for real and checks the buffered-replay replacement holds.
 *
 * Bun is an undeclared toolchain and there is no CI, so the whole suite cannot
 * depend on it: when bun is nowhere to be found this skips rather than fails.
 */
const bun = resolveBun();
const fixture = fileURLToPath(new URL("./__fixtures__/bun-runtime.mjs", import.meta.url));

describe("hub under Bun", () => {
  it.skipIf(bun === null)(
    "completes the upgrade, replays the first message and stops cleanly (R7)",
    () => {
      const output = execFileSync(bun as string, [fixture], {
        encoding: "utf8",
        timeout: 60_000,
        // An empty-ish environment, so nothing on the developer's machine leaks in.
        env: { PATH: process.env.PATH ?? "", HOME: homedir() },
      });

      const line = output
        .trim()
        .split("\n")
        .findLast((entry) => entry.startsWith("RESULT "));
      expect(line, `no RESULT line in bun output:\n${output}`).toBeDefined();
      const result = JSON.parse((line as string).slice("RESULT ".length));

      expect(result.error, `fixture failed: ${result.error}`).toBeUndefined();
      // The upgrade completed and the hub sent its unprompted sync step 1.
      expect(result.receivedUnpromptedStep1).toBe(true);
      // The state vector announced on open was processed, not dropped.
      expect(result.receivedStep2).toBe(true);
      expect(result.converged).toBe(true);
      // A peer that left mid-load did not strand stop().
      expect(result.stopResolved).toBe(true);
    },
  );
});

/** Finds bun on `PATH` or at its default install location, or `null` when it is absent. */
function resolveBun(): string | null {
  const wellKnown = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(wellKnown)) return wellKnown;
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return "bun";
  } catch {
    return null;
  }
}
