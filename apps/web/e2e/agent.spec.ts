import { writeElementAsAgent } from "./agent-writer.ts";
import { expect, test } from "./fixtures.ts";
import { drawRect, expectConverged, expectCount, liveIds } from "./helpers.ts";

test.describe("R6 — a client that is not a browser", () => {
  test("an element written from node shows up without a reload", async ({ hub, room }) => {
    const a = await room.peer("agent-writes");
    const b = await room.peer("agent-writes");

    await drawRect(a, 400, 250, 100, 80);
    await expectCount(b, 1);

    await writeElementAsAgent({
      hubUrl: hub.url,
      slug: "agent-writes",
      rectangle: { id: "agent-rectangle-1", x: 900, y: 250, width: 120, height: 90 },
    });

    await expectCount(a, 2);
    await expectCount(b, 2);
    expect(await expectConverged(a, b)).toContain("agent-rectangle-1");
    expect(await liveIds(b)).toContain("agent-rectangle-1");
  });
});
