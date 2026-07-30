import { expect, test } from "./fixtures";
import { drawRect, expectCount, liveIds, selectAt, sleep } from "./helpers";

test.describe("R1 — joining a room", () => {
  test("a fresh room renders a canvas and reports a connection", async ({ room }) => {
    const peer = await room.peer("fresh-room");

    await expect(peer.locator(".excalidraw")).toHaveCount(1);
    await expect(peer.locator("[data-connection-state]")).toHaveAttribute(
      "data-connection-state",
      "connected",
    );
  });

  test("a peer joining later sees what was drawn before it arrived", async ({ room }) => {
    const a = await room.peer("late-joiner");
    for (let index = 0; index < 3; index += 1) {
      await drawRect(a, 350 + index * 150, 250, 100, 80);
    }
    await expectCount(a, 3);

    const b = await room.peer("late-joiner");
    await expectCount(b, 3);
    expect(await liveIds(b)).toEqual(await liveIds(a));
  });

  test("a peer joining after a reorder sees the same z-order", async ({ room }) => {
    const a = await room.peer("late-joiner-order");
    await drawRect(a, 400, 300, 200, 150);
    await drawRect(a, 450, 350, 200, 150);
    await expectCount(a, 2);
    const initial = await liveIds(a);

    // Right edge of the upper rectangle, clear of the lower one.
    await selectAt(a, 650, 425);
    await a.keyboard.press("Control+Shift+BracketLeft");
    await sleep(1_000);

    const reordered = await liveIds(a);
    expect(reordered).not.toEqual(initial);

    // The invariant is the fractional `pos` key rather than the Y.Array's
    // physical order, so a peer that reads the room from scratch is the one
    // that can disagree.
    const c = await room.peer("late-joiner-order");
    await expectCount(c, 2);
    await expect.poll(async () => (await liveIds(c)).join(",")).toBe(reordered.join(","));
  });
});
