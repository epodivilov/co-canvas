import { expect, test } from "./fixtures";
import {
  dragFrom,
  drawRect,
  expectConverged,
  expectCount,
  goOffline,
  goOnline,
  liveElements,
  recolourSelection,
  selectAt,
  sleep,
} from "./helpers";

test.describe("R3 — convergence", () => {
  test("simultaneous drawing loses nothing", async ({ room }) => {
    const a = await room.peer("simultaneous");
    const b = await room.peer("simultaneous");

    await Promise.all([
      (async () => {
        for (let index = 0; index < 4; index += 1) {
          await drawRect(a, 350 + index * 30, 200 + index * 40, 60, 40);
        }
      })(),
      (async () => {
        for (let index = 0; index < 4; index += 1) {
          await drawRect(b, 750 + index * 30, 500 - index * 40, 60, 40);
        }
      })(),
    ]);

    expect(await expectConverged(a, b, 25_000)).toHaveLength(8);
  });

  test("conflicting edits of one element settle on one state", async ({ room }) => {
    const a = await room.peer("split-brain-one");
    const b = await room.peer("split-brain-one");

    await drawRect(a, 500, 300, 160, 120);
    await expectCount(b, 1);

    await goOffline(a);
    await goOffline(b);
    // One peer drags the element, the other recolours it from the panel: two
    // different properties of the same element, edited at the same time.
    await dragFrom(a, 500, 360, 250, 0);
    await selectAt(b, 500, 360);
    await recolourSelection(b);
    await goOnline(a);
    await goOnline(b);

    await expectConverged(a, b, 25_000);
    const [left] = await liveElements(a);
    const [right] = await liveElements(b);
    // Merging happens per element, so one of the two edits is lost. What has to
    // hold is that the peers agree on which.
    expect({ x: left?.x, y: left?.y, backgroundColor: left?.backgroundColor }).toEqual({
      x: right?.x,
      y: right?.y,
      backgroundColor: right?.backgroundColor,
    });

    const snapshot = JSON.stringify(await liveElements(a));
    await sleep(2_000);
    expect(JSON.stringify(await liveElements(a))).toBe(snapshot);
    expect(JSON.stringify(await liveElements(b))).toBe(snapshot);
  });

  test("elements drawn while apart all survive the rejoin", async ({ room }) => {
    const a = await room.peer("split-brain-many");
    const b = await room.peer("split-brain-many");

    await drawRect(a, 350, 250, 100, 80);
    await expectCount(b, 1);

    await goOffline(a);
    await goOffline(b);
    await drawRect(a, 350, 500, 100, 80);
    await drawRect(b, 850, 500, 100, 80);
    await expectCount(a, 2);
    await expectCount(b, 2);
    await goOnline(a);
    await goOnline(b);

    expect(await expectConverged(a, b, 25_000)).toHaveLength(3);
  });
});
