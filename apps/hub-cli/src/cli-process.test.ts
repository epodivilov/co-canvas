import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClientPool,
  createCliPool,
  createDataDirPool,
  freePort,
  isHealthy,
  logText,
  occupyPort,
  openRawPeer,
  peerCount,
  readLock,
  readLog,
  roomDocBytes,
  settle,
  waitFor,
  waitForLockPort,
  waitForReady,
} from "./test-helpers.ts";

describe("hub CLI process", () => {
  const clis = createCliPool();
  const clients = createClientPool();
  const dataDirs = createDataDirPool();

  afterEach(async () => {
    clients.closeAll();
    await clis.stopAll();
    await dataDirs.removeAll();
  });

  // --- Configuration and refusal to start (R1) ---

  it("binds the environment's port and data directory when given no options (R1)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    clis.spawn([], { env: { CO_CANVAS_PORT: String(port), CO_CANVAS_DATA_DIR: dataDir } });

    await waitForReady(dataDir);
    expect((await readLock(dataDir)).port).toBe(port);
  });

  it("lets an option win over the matching environment variable (R1)", async () => {
    const dataDir = await dataDirs.create();
    const optionPort = await freePort();
    clis.spawn(["--port", String(optionPort), "--data-dir", dataDir], {
      env: { CO_CANVAS_PORT: String(await freePort()) },
    });

    await waitForReady(dataDir);
    expect((await readLock(dataDir)).port).toBe(optionPort);
  });

  it("refuses a non-numeric --port and leaves the data directory absent (R1)", async () => {
    const dataDir = await dataDirs.reserve();
    const cli = clis.spawn(["--port", "not-a-number", "--data-dir", dataDir]);

    const exit = await cli.waitExit();
    expect(exit.code).not.toBe(0);
    expect(cli.stderr()).toContain("--port");
    expect(existsSync(dataDir)).toBe(false);
  });

  it("fails on a busy port, names it, and does not create the data directory (R1)", async () => {
    const port = await freePort();
    const release = await occupyPort(port);
    const dataDir = await dataDirs.reserve();
    try {
      const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
      const exit = await cli.waitExit();
      expect(exit.code).not.toBe(0);
      expect(cli.stderr()).toContain(String(port));
      // Bind runs before the data directory is touched: a hub that lost the port
      // must leave nothing behind for the one that holds it.
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      await release();
    }
  });

  it("leaves exactly one of two racing processes listening (R1)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const a = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
    const b = clis.spawn(["--port", String(port), "--data-dir", dataDir]);

    // One binds; the other dies on EADDRINUSE.
    await waitFor(async () => {
      const aDead = a.child.exitCode !== null;
      const bDead = b.child.exitCode !== null;
      return (aDead || bDead) && (await isHealthy(port));
    });

    const loser = a.child.exitCode !== null ? a : b.child.exitCode !== null ? b : null;
    expect(loser).not.toBeNull();
    expect(await isHealthy(port)).toBe(true);
    if (loser !== null) expect((await loser.waitExit()).code).not.toBe(0);
  });

  it("prints help naming every option and exits zero (R1)", async () => {
    const cli = clis.spawn(["--help"]);
    const exit = await cli.waitExit();
    expect(exit.code).toBe(0);
    for (const option of ["--port", "--data-dir", "--idle-timeout", "--static", "--help"]) {
      expect(cli.stdout()).toContain(option);
    }
  });

  // --- Lockfile (R2) ---

  it("records the bound port and its own pid in the lockfile (R2)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir]);

    await waitForReady(dataDir);
    const lock = await readLock(dataDir);
    expect(lock.port).toBe(port);
    expect(lock.pid).toBe(cli.pid);
  });

  it("records the OS-assigned port under --port 0, never 0 (R2)", async () => {
    const dataDir = await dataDirs.create();
    clis.spawn(["--port", "0", "--data-dir", dataDir]);

    const port = await waitForLockPort(dataDir);
    expect(port).not.toBe(0);
    expect(await isHealthy(port)).toBe(true);
  });

  it("removes the lockfile on SIGTERM (R2)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
    await waitForReady(dataDir);

    cli.child.kill("SIGTERM");
    await cli.waitExit();
    expect(existsSync(join(dataDir, "hub.lock"))).toBe(false);
  });

  it("removes the lockfile on idle shutdown (R2, R4)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn([
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--idle-timeout",
      "300",
    ]);
    await waitFor(() => isHealthy(port));

    const exit = await cli.waitExit();
    expect(exit.code).toBe(0);
    expect(existsSync(join(dataDir, "hub.lock"))).toBe(false);
  });

  it("leaves no lockfile behind when it fails after binding (R2)", async () => {
    const dataDir = await dataDirs.create();
    const fixture = new URL("./__fixtures__/crash-after-bind.mjs", import.meta.url);
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", fixture.pathname, dataDir],
      { stdio: "ignore" },
    );
    const exit = await new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    // It wrote a lockfile, then threw. The exit backstop must have cleared it.
    expect(exit).not.toBe(0);
    expect(existsSync(join(dataDir, "hub.lock"))).toBe(false);
  });

  // --- Exiting (R3) ---

  it("exits zero on SIGTERM (R3)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
    await waitForReady(dataDir);

    cli.child.kill("SIGTERM");
    expect((await cli.waitExit()).code).toBe(0);
  });

  it("flushes the debounce window on SIGTERM so a restart reads the change back (R3)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const first = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
    await waitForReady(dataDir);

    const writer = clients.open(port, "alpha");
    await waitFor(() => writer.provider.synced);
    writer.doc.getMap("board").set("shape", "rect");
    // Wait until the hub has actually received the update — otherwise the signal
    // could beat it over the wire — but not long enough for the 250 ms debounce
    // to have flushed it. Only the graceful stop the signal triggers gets it to
    // disk.
    await waitFor(async () => (await roomDocBytes(port, "alpha")) > 2);
    first.child.kill("SIGTERM");
    expect((await first.waitExit()).code).toBe(0);
    writer.close();

    clis.spawn(["--port", String(port), "--data-dir", dataDir]);
    await waitFor(() => isHealthy(port));
    const reader = clients.open(port, "alpha");
    await waitFor(() => reader.doc.getMap("board").get("shape") === "rect");
    expect(reader.doc.getMap("board").get("shape")).toBe("rect");
  });

  it("closes a connected peer and exits on SIGINT rather than hanging (R3)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
    await waitForReady(dataDir);

    const peer = clients.open(port, "alpha");
    await waitFor(() => peer.provider.synced);

    // Would hang past the exit budget if the room's Awareness keepalive kept the
    // event loop alive after the port was released.
    cli.child.kill("SIGINT");
    expect((await cli.waitExit()).code).toBe(0);
  });

  // --- Idle shutdown (R4) ---

  it("exits zero after the idle timeout with no peer ever connecting (R4)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn([
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--idle-timeout",
      "300",
    ]);
    await waitFor(() => isHealthy(port));

    expect((await cli.waitExit()).code).toBe(0);
  });

  it("lets a peer connecting midway postpone the exit rather than ignoring it (R4)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn([
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--idle-timeout",
      "500",
    ]);
    await waitForReady(dataDir);

    // Part of the idle window passes with no peer: the countdown is running.
    await settle(250);
    expect(cli.child.exitCode).toBeNull();

    // A peer connects midway. It must postpone the exit, not be ignored: well
    // past the original window the hub is still up because the peer is present.
    const peer = await openRawPeer(port, "alpha");
    await waitFor(async () => (await peerCount(port)) >= 1);
    await settle(700);
    expect(cli.child.exitCode).toBeNull();
    expect(await peerCount(port)).toBeGreaterThanOrEqual(1);
    peer.close();
  });

  it("exits once a peer connects and then leaves, counted from the disconnect (R4)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn([
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      "--idle-timeout",
      "400",
    ]);
    await waitForReady(dataDir);

    const peer = await openRawPeer(port, "alpha");
    await waitFor(async () => (await peerCount(port)) >= 1);
    // With the peer gone the countdown starts from the disconnect and runs out.
    peer.close();

    expect((await cli.waitExit()).code).toBe(0);
  });

  it("runs indefinitely with --idle-timeout 0 (R4)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir, "--idle-timeout", "0"]);
    await waitFor(() => isHealthy(port));

    await settle(900);
    expect(cli.child.exitCode).toBeNull();
    expect(await isHealthy(port)).toBe(true);
  });

  it("reports a thirty-minute idle timeout by default (R4)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    clis.spawn(["--port", String(port), "--data-dir", dataDir]);
    await waitFor(() => isHealthy(port));

    // The startup line the hub logs reports the resolved idle timeout.
    await waitFor(async () => (await logText(dataDir)).includes("idle-timeout"));
    expect(await readLog(dataDir)).toContain(`idle-timeout ${30 * 60 * 1000}ms`);
  });

  // --- Logging (R5) ---

  it("names the bound port in hub.log even with stdout and stderr discarded (R5)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    clis.spawn(["--port", String(port), "--data-dir", dataDir], { discardOutput: true });

    await waitFor(() => isHealthy(port));
    await waitFor(async () => (await logText(dataDir)).includes(String(port)));
    expect(await readLog(dataDir)).toContain(String(port));
  });

  it("records a bind failure in hub.log of a data directory that already exists (R5)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const release = await occupyPort(port);
    try {
      const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
      await cli.waitExit();
      expect(await readLog(dataDir)).toContain("failed to start");
    } finally {
      await release();
    }
  });

  it("appends across restarts rather than truncating (R5)", async () => {
    const dataDir = await dataDirs.create();

    // A fresh port each run keeps the test off the OS's port-release timing: the
    // point here is only that the one log accumulates, not that a port frees.
    for (let run = 0; run < 3; run++) {
      const port = await freePort();
      const cli = clis.spawn(["--port", String(port), "--data-dir", dataDir]);
      await waitFor(() => isHealthy(port));
      await waitFor(
        async () => (await logText(dataDir)).split("\n").filter(Boolean).length >= run * 2 + 1,
      );
      cli.child.kill("SIGTERM");
      expect((await cli.waitExit()).code).toBe(0);
    }

    const log = await readLog(dataDir);
    expect(log.match(/listening on/g)?.length).toBe(3);
    expect(log.match(/shutdown \(SIGTERM\)/g)?.length).toBe(3);
  });

  it("serves a frontend from a --static directory (R6)", async () => {
    const dataDir = await dataDirs.create();
    const port = await freePort();
    const staticDir = fixtureStaticDir();
    clis.spawn(["--port", String(port), "--data-dir", dataDir, "--static", staticDir]);
    await waitFor(() => isHealthy(port));

    const html = await fetchText(port, "/room/demo");
    expect(html.status).toBe(200);
    expect(html.body).toEqual(await readFile(join(staticDir, "index.html"), "utf8"));
  });
});

/** Reuses the hub package's static fixture so the CLI's `--static` wiring is exercised end to end. */
function fixtureStaticDir(): string {
  return new URL("../../../packages/hub/src/__fixtures__/static", import.meta.url).pathname;
}

async function fetchText(port: number, path: string): Promise<{ status: number; body: string }> {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}
