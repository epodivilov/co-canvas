import { expect, test } from "./fixtures";
import {
  CONVERGENCE_TIMEOUT,
  dragFrom,
  drawRect,
  expectConverged,
  expectCount,
  liveElements,
  liveIds,
  selectAt,
  sleep,
  waitForState,
} from "./helpers";

test.describe("R2 — propagation and isolation", () => {
  test("edits made on either side reach the other", async ({ room }) => {
    const a = await room.peer("both-ways");
    const b = await room.peer("both-ways");

    await drawRect(a, 400, 250);
    await expectCount(b, 1);
    expect((await liveElements(b))[0]?.type).toBe("rectangle");

    await drawRect(b, 700, 450);
    await expectCount(a, 2);

    expect(await expectConverged(a, b)).toHaveLength(2);
  });

  test("a move and a delete both reach the other peer", async ({ room }) => {
    const a = await room.peer("move-and-delete");
    const b = await room.peer("move-and-delete");

    await drawRect(a, 350, 200, 120, 80);
    await drawRect(a, 700, 200, 120, 80);
    await expectCount(b, 2);
    const [moved, doomed] = await liveIds(a);

    // Left edge of the first rectangle: a transparent shape has no interior to
    // grab.
    await dragFrom(a, 350, 240, 0, 220);
    await selectAt(a, 700, 240);
    await a.keyboard.press("Delete");

    await expectCount(b, 1);
    await expect
      .poll(async () => (await liveElements(b))[0]?.y, { timeout: CONVERGENCE_TIMEOUT })
      .toBeGreaterThan(380);
    expect(await liveIds(b)).toEqual([moved]);
    expect(await liveIds(b)).not.toContain(doomed);
  });

  test("a reorder reaches a peer that is already connected", async ({ room }) => {
    const a = await room.peer("reorder-live");
    const b = await room.peer("reorder-live");

    await drawRect(a, 400, 300, 200, 150);
    await drawRect(a, 450, 350, 200, 150);
    await expectCount(b, 2);
    const initial = await liveIds(a);
    expect(await liveIds(b)).toEqual(initial);

    await selectAt(a, 650, 425);
    await a.keyboard.press("Control+Shift+BracketLeft");
    await sleep(1_000);

    const reordered = await liveIds(a);
    expect(reordered).not.toEqual(initial);
    await expect
      .poll(async () => (await liveIds(b)).join(","), { timeout: CONVERGENCE_TIMEOUT })
      .toBe(reordered.join(","));
  });

  test("nothing crosses between two different rooms", async ({ room }) => {
    const a = await room.peer("alpha");
    const b = await room.peer("beta");

    await drawRect(a, 400, 250);
    await expectCount(a, 1);

    await sleep(CONVERGENCE_TIMEOUT / 3);
    expect(await liveIds(b)).toEqual([]);
  });

  test("nothing crosses between peers while the hub is down", async ({ hub, room }) => {
    const a = await room.peer("hub-down");
    const b = await room.peer("hub-down");

    await drawRect(a, 400, 250);
    await expectCount(b, 1);

    await hub.stop();
    await waitForState(a, "disconnected");
    await waitForState(b, "disconnected");

    await drawRect(a, 700, 450);
    await expectCount(a, 2);

    // If this ever goes green with a stopped hub, the peers are talking over
    // `BroadcastChannel` and every other scenario in this suite is meaningless.
    await sleep(CONVERGENCE_TIMEOUT / 3);
    expect(await liveIds(b)).toHaveLength(1);
  });
});
