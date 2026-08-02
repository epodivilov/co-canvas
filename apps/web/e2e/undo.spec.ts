import type { Page } from "@playwright/test";
import { expect, type RoomOpener, test } from "./fixtures.ts";
import { drawRect, expectConverged, expectCount, liveIds } from "./helpers.ts";

/**
 * A drew one element, then received one from B, then drew a second of its own.
 * Undo on A must walk only A's own two, in reverse order.
 */
async function threeElementHistory(
  room: RoomOpener,
  slug: string,
): Promise<{ a: Page; b: Page; ids: string[] }> {
  const a = await room.peer(slug);
  const b = await room.peer(slug);

  await drawRect(a, 350, 200, 80, 60);
  await expectCount(b, 1);
  await drawRect(b, 850, 200, 80, 60);
  await expectCount(a, 2);
  await drawRect(a, 350, 450, 80, 60);
  await expectCount(b, 3);

  const ids = await liveIds(a);
  expect(ids).toHaveLength(3);
  return { a, b, ids };
}

test.describe("R4 — undo stays local", () => {
  test("the keyboard shortcut reverts only the local edit", async ({ room }) => {
    const { a, b, ids } = await threeElementHistory(room, "undo-keyboard");
    const [ownFirst, remote, ownSecond] = ids;

    await a.keyboard.press("Control+z");
    await expectCount(a, 2);

    const after = await liveIds(a);
    expect(after).not.toContain(ownSecond);
    expect(after).toContain(ownFirst);
    expect(after).toContain(remote);
    expect(await expectConverged(a, b)).toEqual(after.slice().sort());
  });

  test("the toolbar control is present and reverts only the local edit", async ({ room }) => {
    const { a, b, ids } = await threeElementHistory(room, "undo-toolbar");
    const [ownFirst, remote, ownSecond] = ids;

    // The binding hooks this control by its accessible name; renaming it would
    // unhook undo without any other symptom.
    const undo = a.locator('[aria-label="Undo"]');
    await expect(undo).toHaveCount(1);
    await undo.click();
    await expectCount(a, 2);

    const after = await liveIds(a);
    expect(after).not.toContain(ownSecond);
    expect(after).toContain(ownFirst);
    expect(after).toContain(remote);
    expect(await expectConverged(a, b)).toEqual(after.slice().sort());
  });

  test("undoing twice walks only the local history", async ({ room }) => {
    const { a, b, ids } = await threeElementHistory(room, "undo-twice");
    const [ownFirst, remote, ownSecond] = ids;

    await a.keyboard.press("Control+z");
    // Waited for rather than slept through: the second press has to land on a
    // history that has already given the first one back.
    await expectCount(a, 2);
    await a.keyboard.press("Control+z");
    await expectCount(a, 1);

    const after = await liveIds(a);
    expect(after).toEqual([remote]);
    expect(after).not.toContain(ownFirst);
    expect(after).not.toContain(ownSecond);
    await expectCount(b, 1);
    expect(await liveIds(b)).toEqual([remote]);
    expect(await expectConverged(a, b)).toEqual([remote]);
  });
});
