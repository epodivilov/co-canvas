// Reproduces the window R2 pins: a hub that has bound its port and written its
// lockfile, and then fails. It arms the CLI's real lockfile backstop, writes a
// lock the way the CLI does after a successful bind, and throws — the exit path
// must leave no `hub.lock` behind claiming a process that is gone.
import { writeHubLock } from "@co-canvas/hub-client";
import { armLockfileCleanup } from "../cli.ts";

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error("usage: crash-after-bind.mjs <dataDir>");

await writeHubLock(dataDir, { port: 45999 });
armLockfileCleanup(dataDir);

throw new Error("boom after bind");
