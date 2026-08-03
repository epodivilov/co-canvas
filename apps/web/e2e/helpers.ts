import type { Browser, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { ConnectionStatus } from "../src/room/connection.ts";
import type { InspectedElement, InspectedEntry } from "../src/room/inspect.ts";

/** Empty canvas away from every Excalidraw control, safe to click for focus. */
const FOCUS_POINT = { x: 1000, y: 700 } as const;

/** Long enough for a round trip through the hub, short enough to stay usable. */
export const CONVERGENCE_TIMEOUT = 15_000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface OpenOptions {
  /** Runs in the page before the app's own code does. */
  init?: () => void;
}

/**
 * Opens a room in its own browser context and waits only for the page to come
 * up — the room may be one the hub refuses, which never reports `connected`.
 *
 * A separate context per peer is not a detail: `y-websocket` enables
 * `BroadcastChannel` by default, so two tabs of one context would sync directly
 * with each other and the suite would pass against a hub that is not running.
 */
export async function openPage(
  browser: Browser,
  hubUrl: string,
  slug: string,
  options: OpenOptions = {},
): Promise<Page> {
  const context = await browser.newContext();
  if (options.init !== undefined) await context.addInitScript(options.init);
  const page = await context.newPage();
  await page.goto(`/room/${slug}?hub=${encodeURIComponent(hubUrl)}`);
  await page
    .waitForFunction(() => window.__coCanvas !== undefined, undefined, { timeout: 20_000 })
    .catch(() => {
      throw new Error(
        "inspection handle missing — the dev server must run with import.meta.env.DEV true",
      );
    });
  return page;
}

/** Opens a room and waits until it is connected and drawable. */
export async function openPeer(
  browser: Browser,
  hubUrl: string,
  slug: string,
  options: OpenOptions = {},
): Promise<Page> {
  const page = await openPage(browser, hubUrl, slug, options);
  await waitForState(page, "connected");
  await page.waitForSelector(".excalidraw", { timeout: 20_000 });
  // Not the canvas element but the binding behind it: Excalidraw takes input a
  // commit before the binding attaches, and the binding resets the scene as it
  // starts, so a stroke made in between is dropped.
  await page.waitForFunction(() => window.__coCanvas?.ready() === true, undefined, {
    timeout: 20_000,
  });
  // Keyboard shortcuts only reach Excalidraw once the canvas holds focus.
  await page.mouse.click(FOCUS_POINT.x, FOCUS_POINT.y);
  return page;
}

// Every reader below repeats the same three lines because `page.evaluate` ships
// its callback to the browser as source: it cannot close over a shared helper.

export async function waitForState(
  page: Page,
  state: ConnectionStatus,
  timeout = 20_000,
): Promise<void> {
  await page.waitForFunction((expected) => window.__coCanvas?.state() === expected, state, {
    timeout,
  });
}

export function connectionState(page: Page): Promise<ConnectionStatus> {
  return page.evaluate(() => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    return handle.state();
  });
}

export function socketsOpened(page: Page): Promise<number> {
  return page.evaluate(() => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    return handle.socketsOpened();
  });
}

export async function liveElements(page: Page): Promise<InspectedElement[]> {
  const elements = await page.evaluate(() => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    return handle.elements();
  });
  return elements.filter((element) => !element.isDeleted);
}

export async function liveIds(page: Page): Promise<string[]> {
  return (await liveElements(page)).map((element) => element.id);
}

export function yEntries(page: Page): Promise<InspectedEntry[]> {
  return page.evaluate(() => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    return handle.entries();
  });
}

export function hasFile(page: Page, fileId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    return handle.hasFile(id);
  }, fileId);
}

/** Drops the socket and the cross-tab channel, then waits for the page to agree. */
export async function goOffline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    handle.disconnect();
  });
  await waitForState(page, "disconnected");
}

export async function goOnline(page: Page): Promise<void> {
  await page.evaluate(() => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    handle.connect();
  });
  await waitForState(page, "connected");
}

/** Draws a rectangle the way a person would: pick the tool, then drag. */
export async function drawRect(
  page: Page,
  x: number,
  y: number,
  width = 120,
  height = 80,
): Promise<void> {
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width / 2, y + height / 2, { steps: 5 });
  await page.mouse.move(x + width, y + height, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

/** Draws a freehand stroke the way a person would: pick the pencil, then drag. */
export async function drawFreehand(
  page: Page,
  points: readonly (readonly [number, number])[],
): Promise<void> {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error("a stroke needs at least one point");
  await page.keyboard.press("x");
  await page.mouse.move(first[0], first[1]);
  await page.mouse.down();
  for (const [x, y] of rest) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

/** Writes a loose text note: pick the text tool, click, type, commit. */
export async function writeNote(page: Page, x: number, y: number, text: string): Promise<void> {
  await page.keyboard.press("t");
  await page.mouse.click(x, y);
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

/** Drags whatever sits under (x, y) by (dx, dy) with the selection tool. */
export async function dragFrom(
  page: Page,
  x: number,
  y: number,
  dx: number,
  dy: number,
): Promise<void> {
  await page.keyboard.press("v");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

/**
 * Clicks a point and asserts something got selected.
 *
 * Transparent shapes are only selectable by their stroke, so a click aimed at
 * the middle of a rectangle hits nothing and silently turns the scenario that
 * follows into a no-op.
 */
export async function selectAt(page: Page, x: number, y: number): Promise<string> {
  await page.keyboard.press("v");
  await page.mouse.click(x, y);
  const selected = await page.evaluate(() => {
    const handle = window.__coCanvas;
    if (handle === undefined) throw new Error("inspection handle missing");
    return handle.selectedIds();
  });
  expect(selected, `nothing selected at (${x}, ${y})`).toHaveLength(1);
  return selected[0] ?? "";
}

/** The background top-pick the recolour helper reaches for. */
export const BACKGROUND_SWATCH = "#ffc9c9";

/**
 * Paints the current selection with a background colour from the left panel.
 *
 * Real input rather than `updateScene`: the panel is the path a person's
 * recolour takes, and the only one that runs Excalidraw's own change plumbing
 * into the binding.
 */
export async function recolourSelection(page: Page): Promise<string> {
  await page.locator(`[data-testid="color-top-pick-${BACKGROUND_SWATCH}"]`).click();
  await expect
    .poll(async () => (await liveElements(page)).map((element) => element.backgroundColor))
    .toContain(BACKGROUND_SWATCH);
  return BACKGROUND_SWATCH;
}

/** Waits until the page's live scene holds exactly `count` elements. */
export async function expectCount(
  page: Page,
  count: number,
  timeout = CONVERGENCE_TIMEOUT,
): Promise<void> {
  await expect.poll(async () => (await liveElements(page)).length, { timeout }).toBe(count);
}

/**
 * Waits until both peers hold the same non-empty set of live element ids and
 * returns it. An empty set never counts as converged: it is also what two peers
 * look like a moment before either of them has anything.
 */
export async function expectConverged(
  a: Page,
  b: Page,
  timeout = CONVERGENCE_TIMEOUT,
): Promise<string[]> {
  const fingerprint = async (page: Page) => (await liveIds(page)).slice().sort();
  const deadline = Date.now() + timeout;
  let left: string[] = [];
  let right: string[] = [];
  while (Date.now() < deadline) {
    [left, right] = await Promise.all([fingerprint(a), fingerprint(b)]);
    if (left.length > 0 && left.join(",") === right.join(",")) return left;
    await sleep(200);
  }
  throw new Error(`peers did not converge: A=[${left.join(",")}] B=[${right.join(",")}]`);
}
