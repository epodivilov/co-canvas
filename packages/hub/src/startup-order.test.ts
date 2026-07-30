import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Hub } from "./index";
import { createHub } from "./index";
import {
  createClientPool,
  createDataDirPool,
  freePort,
  logBoard,
  readLog,
  roomDocBytes,
  waitFor,
} from "./test-helpers";

/**
 * `packages/hub-client` resolves the "who runs the hub" race by starting a hub
 * per caller and letting everyone who loses the port die on `EADDRINUSE`. That
 * only holds while `start()` binds before it touches the data directory: two
 * processes that both prepared the directory before one of them lost would have
 * appended into the same log, and interleaved appends do not parse.
 */
describe("startup order", () => {
  const clients = createClientPool();
  const dataDirs = createDataDirPool();
  const hubs = new Set<Hub>();

  function hub(options: { dataDir: string; port: number }): Hub {
    const created = createHub(options);
    hubs.add(created);
    return created;
  }

  afterEach(async () => {
    clients.closeAll();
    for (const created of hubs) await created.stop();
    hubs.clear();
    await dataDirs.removeAll();
  });

  it("fails on the busy port rather than on an unusable data directory", async () => {
    const parent = await dataDirs.create();
    const blocker = join(parent, "not-a-directory");
    await writeFile(blocker, "a regular file where a directory has to go");

    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));

    try {
      // Both things are broken at once: the port is taken and the data directory
      // cannot be created. Whichever error comes out names the step that ran
      // first, and it has to be the bind — a hub that reported the directory
      // here would have written to it before losing the race for the port.
      await expect(hub({ dataDir: join(blocker, "data"), port }).start()).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("leaves the loser dead on EADDRINUSE and the winner's log free of foreign frames", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const contenders = [hub({ dataDir, port }), hub({ dataDir, port })];

    const outcomes = await Promise.allSettled(contenders.map((candidate) => candidate.start()));
    const winners = contenders.filter((candidate) => candidate.url !== null);
    const rejections = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toMatchObject({ code: "EADDRINUSE" });

    const winner = winners[0] as Hub;
    const url = winner.url as string;
    const writer = clients.open(url, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("shape", "rect");
    await waitFor(async () => (await roomDocBytes(url, "alpha")) > 2);
    await winner.stop();

    // Nothing but the winner ever wrote here: the log parses to the end and
    // holds exactly what the winner's client drew.
    const log = await readLog(dataDir, "alpha");
    expect(log.trailing).toBe(0);
    expect(logBoard(log)).toEqual({ shape: "rect" });
  });
});
