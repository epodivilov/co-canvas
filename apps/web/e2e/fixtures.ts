// biome-ignore-all lint/correctness/noEmptyPattern: playwright reads a fixture's
// dependencies off its first parameter's destructuring pattern and refuses a
// plain one, so a fixture that depends on nothing has to be written `({}, use)`.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "@co-canvas/hub";
import { type Browser, test as base, type Page } from "@playwright/test";
import { type OpenOptions, openPage, openPeer } from "./helpers";

/** A hub running in the test process, which the specs can stop and restart. */
export interface TestHub {
  /** Base URL of the running hub. Stable across a stop/start cycle. */
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Opens browsers on the fixture hub's rooms. */
export interface RoomOpener {
  /** An isolated context on a room, waited until it reports `connected`. */
  peer(slug: string, options?: OpenOptions): Promise<Page>;
  /** An isolated context on a room, waited only until the page is alive. */
  page(slug: string, options?: OpenOptions): Promise<Page>;
}

interface Fixtures {
  hub: TestHub;
  room: RoomOpener;
}

/**
 * Asks the OS for a port and immediately gives it back.
 *
 * The hub itself can bind port `0`, but then it would land on a different port
 * every time it started — and the reconnect scenario needs the hub to come back
 * where the browser is still looking for it.
 */
async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export const test = base.extend<Fixtures>({
  hub: async ({}, use) => {
    const port = await reserveFreePort();
    // Never the developer's real board directory: `createHub` defaults to
    // `~/.co-canvas`.
    const dataDir = await mkdtemp(join(tmpdir(), "co-canvas-e2e-"));
    const hub = createHub({ port, dataDir });
    const url = await hub.start();

    await use({
      url,
      start: async () => {
        await hub.start();
      },
      stop: async () => {
        await hub.stop();
      },
    });

    await hub.stop();
    await rm(dataDir, { recursive: true, force: true });
  },

  room: async ({ browser, hub }, use) => {
    const opened: Page[] = [];
    const track = async (page: Promise<Page>): Promise<Page> => {
      const resolved = await page;
      opened.push(resolved);
      return resolved;
    };

    await use({
      peer: (slug, options) => track(openPeer(browser, hub.url, slug, options)),
      page: (slug, options) => track(openPage(browser, hub.url, slug, options)),
    });

    // Contexts outlive the test otherwise, and a suite of eighteen scenarios
    // would end up holding several dozen of them open at once.
    for (const page of opened) await page.context().close();
  },
});

export { expect } from "@playwright/test";
export type { Browser };
