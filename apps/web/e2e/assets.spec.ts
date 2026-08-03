import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.ts";
import { CONVERGENCE_TIMEOUT, expectCount, hasFile, liveElements } from "./helpers.ts";

const FIXTURE_PNG = fileURLToPath(new URL("./fixtures/dot.png", import.meta.url));

/**
 * Excalidraw picks its file dialog once, when `browser-fs-access` loads: the
 * File System Access API if the window has it, a plain `<input type="file">`
 * otherwise. Playwright cannot answer `showOpenFilePicker` — it intercepts the
 * call and aborts it without ever raising a `filechooser` event — so the tool
 * is driven down the fallback path every other browser already takes.
 */
function withoutFileSystemAccessApi(): void {
  Reflect.deleteProperty(window, "showOpenFilePicker");
}

test.describe("R5 — image assets", () => {
  test("an image placed by one peer arrives at the other with its payload", async ({ room }) => {
    const a = await room.peer("images", { init: withoutFileSystemAccessApi });
    const b = await room.peer("images");

    // The image tool opens the dialog as soon as it is picked. Driving it for
    // real keeps the element and its binary on the path an upload actually
    // takes, rather than seeding the scene through the inspection handle.
    const chooser = a.waitForEvent("filechooser");
    await a.keyboard.press("9");
    await (await chooser).setFiles(FIXTURE_PNG);
    await a.mouse.click(700, 400);

    await expectCount(a, 1);
    // Excalidraw puts the element on the canvas before it has finished reading
    // the file, so the element exists for a moment with no `fileId` on it yet.
    await expect
      .poll(async () => (await liveElements(a))[0]?.fileId ?? "", { timeout: CONVERGENCE_TIMEOUT })
      .not.toBe("");

    const [placed] = await liveElements(a);
    expect(placed?.type).toBe("image");
    const fileId = placed?.fileId ?? "";

    await expectCount(b, 1);
    await expect
      .poll(async () => (await liveElements(b))[0]?.fileId ?? "", { timeout: CONVERGENCE_TIMEOUT })
      .toBe(fileId);
    expect((await liveElements(b))[0]?.type).toBe("image");
    await expect.poll(() => hasFile(b, fileId), { timeout: CONVERGENCE_TIMEOUT }).toBe(true);
  });
});
