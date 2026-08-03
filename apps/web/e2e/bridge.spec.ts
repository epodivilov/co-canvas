import type { Page } from "@playwright/test";
import { type BridgeClient, observeRoom, type RoomObserver, startBridge } from "./bridge-client.ts";
import { expect, test } from "./fixtures.ts";
import { liveElements, liveIds } from "./helpers.ts";

/**
 * The font string Excalidraw measures a default-family label against — see its
 * `getFontString` and `getFontFamilyFallbacks`. Restated here because this is
 * the one check that has to reach the real font.
 */
const EXCALIFONT_AT_20 = "20px Excalifont, Xiaolai, Segoe UI Emoji";

/**
 * How far above the browser's own measurement the bridge's width may sit.
 *
 * The bridge measures a label by summing Excalifont's advance widths and adding
 * a fixed allowance per character, because a rasterizer rounds each glyph's
 * advance, applies pair kerning, and draws a precomposed letter's mark even
 * when the font's advance makes no room for it. None of that is in `hmtx`.
 *
 * This is the price of that allowance rather than a quality target: at
 * `WIDTH_SAFETY_EM` = 0.2 a long Latin label lands about 40 % over. It is here
 * to catch a width function that has gone grossly wrong, while the assertion
 * below it — never under the browser — is the one carrying R2.
 */
const WIDTH_TOLERANCE = 1.45;

let bridge: BridgeClient | null = null;
let observer: RoomObserver | null = null;

test.afterEach(async () => {
  await bridge?.close();
  bridge = null;
  observer?.close();
  observer = null;
});

async function connectBridge(hubUrl: string): Promise<BridgeClient> {
  bridge = await startBridge(Number(new URL(hubUrl).port));
  return bridge;
}

/** Every element of a page's live scene, by id. */
async function sceneById(
  page: Page,
): Promise<Map<string, Awaited<ReturnType<typeof liveElements>>[number]>> {
  const elements = await liveElements(page);
  return new Map(elements.map((element) => [element.id, element]));
}

test.describe("the built bridge", () => {
  test("writes a labelled rectangle from its bundled entry point (R1)", async ({ hub }) => {
    // Neither the DOM stubs nor the dynamic import of Excalidraw is exercised
    // by any in-process scenario: both have to survive bundling.
    const client = await connectBridge(hub.url);
    await client.call("create_room", { slug: "bundled" });
    observer = await observeRoom(hub.url, "bundled");

    const result = await client.call("add_elements", {
      slug: "bundled",
      elements: [
        {
          type: "rectangle",
          id: "auth",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    await expect.poll(() => observer?.scene().length ?? 0).toBe(2);
    const scene = observer.scene();
    expect(scene.map((element) => element.type)).toEqual(["rectangle", "text"]);
    expect(scene[1]).toMatchObject({ containerId: "auth", text: "Auth" });
    expect(Number(scene[1]?.width)).toBeGreaterThan(0);
  });
});

test.describe("what a browser sees", () => {
  test("gains a diagram the bridge draws, bindings and labels included (R1, R2, R3)", async ({
    hub,
    room,
  }) => {
    const page = await room.peer("drawn");
    const client = await connectBridge(hub.url);

    const result = await client.call("add_elements", {
      slug: "drawn",
      elements: [
        {
          type: "rectangle",
          id: "auth",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
        {
          type: "ellipse",
          id: "store",
          x: 600,
          y: 100,
          width: 200,
          height: 100,
          label: { text: "Store" },
        },
        { type: "arrow", id: "writes", start: { id: "auth" }, end: { id: "store" } },
      ],
    });

    expect(result.isError).toBeFalsy();
    await expect.poll(async () => (await liveIds(page)).length).toBe(5);

    const scene = await sceneById(page);
    const authLabel = [...scene.values()].find((element) => element.containerId === "auth");
    const storeLabel = [...scene.values()].find((element) => element.containerId === "store");
    expect(authLabel).toBeDefined();
    expect(storeLabel).toBeDefined();
    expect(scene.get("auth")?.boundElementIds).toContain(authLabel?.id);
    expect(scene.get("auth")?.boundElementIds).toContain("writes");
    expect(scene.get("store")?.boundElementIds).toContain(storeLabel?.id);
    expect(scene.get("store")?.boundElementIds).toContain("writes");
    expect(scene.get("writes")?.startBindingId).toBe("auth");
    expect(scene.get("writes")?.endBindingId).toBe("store");
  });

  test("re-renders an element the bridge moved (R6)", async ({ hub, room }) => {
    const page = await room.peer("moved");
    const client = await connectBridge(hub.url);

    await client.call("add_elements", {
      slug: "moved",
      elements: [{ type: "rectangle", id: "box", x: 100, y: 100, width: 120, height: 80 }],
    });
    await expect.poll(async () => (await liveIds(page)).length).toBe(1);

    await client.call("update_elements", {
      slug: "moved",
      patches: [{ id: "box", x: 700, y: 400 }],
    });

    // The document entry has to be updated in place: replacing it produces
    // array events instead of map events, and the binding then treats the
    // element as unchanged and keeps rendering the copy it already has.
    await expect.poll(async () => (await sceneById(page)).get("box")?.x).toBe(700);
    expect((await sceneById(page)).get("box")?.y).toBe(400);
  });

  test("loses a container and its label when the bridge deletes it (R7)", async ({ hub, room }) => {
    const page = await room.peer("deleted");
    const client = await connectBridge(hub.url);

    await client.call("add_elements", {
      slug: "deleted",
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
        { type: "rectangle", id: "kept", x: 500, y: 100, width: 120, height: 80 },
      ],
    });
    await expect.poll(async () => (await liveIds(page)).length).toBe(3);

    await client.call("delete_elements", { slug: "deleted", ids: ["box"] });

    await expect.poll(async () => await liveIds(page)).toEqual(["kept"]);
  });

  test("stores label widths no browser measures wider (R2)", async ({ hub, room }) => {
    const page = await room.peer("measured");
    const client = await connectBridge(hub.url);
    observer = await observeRoom(hub.url, "measured");

    const labels = {
      short: "Auth",
      sentence: "Authentication service handles login and token refresh",
      capitals: "WAVE FORM XYZ",
      // The two glyphs Chromium draws furthest past the advance Excalifont's
      // own metrics claim for them: a run of `j`, whose pairs kern apart, and a
      // run of `ľ`, which the font gives no more width than a bare `l`. Both
      // under-measured before the allowance was sized to them.
      descenders: "j".repeat(100),
      caron: "ľ".repeat(30),
    };
    await client.call("add_elements", {
      slug: "measured",
      elements: Object.entries(labels).map(([id, text], n) => ({
        type: "rectangle",
        id,
        x: 100,
        y: 100 + n * 200,
        // Wide enough that none of these labels wraps, so each comparison is
        // one stored line against the same unwrapped string in the browser.
        width: 1300,
        height: 150,
        label: { text },
      })),
    });
    await expect.poll(async () => (await liveIds(page)).length).toBe(10);

    // Excalidraw loads a scene's fonts lazily; measuring before Excalifont is
    // there would compare the bridge against a fallback family.
    await expect
      .poll(() => page.evaluate((font) => document.fonts.check(font), EXCALIFONT_AT_20))
      .toBe(true);

    const measured = await page.evaluate(
      ({ font, texts }) => {
        const context = document.createElement("canvas").getContext("2d");
        if (context === null) throw new Error("no 2d context");
        context.font = font;
        return texts.map((text) => context.measureText(text).width);
      },
      { font: EXCALIFONT_AT_20, texts: Object.values(labels) },
    );

    const scene = observer.scene();
    for (const [index, [id, text]] of Object.entries(labels).entries()) {
      const label = scene.find((element) => element.containerId === id);
      expect(label, `no label bound to ${id}`).toBeDefined();
      // A wrapped label would put its widest line against the browser's whole
      // string, which is a different question from the one being asked.
      expect(String(label?.text), `${id} wrapped`).not.toContain("\n");
      const stored = Number(label?.width);
      const browser = measured[index] ?? 0;
      expect(browser, `browser measured nothing for ${text}`).toBeGreaterThan(0);
      expect(stored, `${text}: stored ${stored} < browser ${browser}`).toBeGreaterThanOrEqual(
        browser,
      );
      expect(stored, `${text}: stored ${stored} far over browser ${browser}`).toBeLessThanOrEqual(
        browser * WIDTH_TOLERANCE,
      );
    }
  });
});
