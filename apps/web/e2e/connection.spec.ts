import { expect, test } from "./fixtures";
import {
  CONVERGENCE_TIMEOUT,
  drawRect,
  expectCount,
  liveIds,
  sleep,
  socketsOpened,
  waitForState,
} from "./helpers";

test.describe("R7 — connection lifecycle", () => {
  test("losing the hub is shown on the page and leaves the board usable", async ({ hub, room }) => {
    const peer = await room.peer("hub-goes-away");
    await drawRect(peer, 400, 250, 100, 80);
    await expectCount(peer, 1);

    await hub.stop();
    await waitForState(peer, "disconnected");
    await expect(peer.locator("[data-connection-state]")).toHaveAttribute(
      "data-connection-state",
      "disconnected",
    );

    await drawRect(peer, 700, 250, 100, 80);
    await expectCount(peer, 2);
  });

  test("the hub coming back reconnects the page and the board survives", async ({ hub, room }) => {
    const a = await room.peer("hub-returns");
    await drawRect(a, 400, 250, 100, 80);
    await drawRect(a, 700, 250, 100, 80);
    await expectCount(a, 2);
    const drawn = await liveIds(a);

    await hub.stop();
    await waitForState(a, "disconnected");

    await hub.start();
    // No reload: `y-websocket` retries on its own and the page picks the room
    // back up.
    await waitForState(a, "connected", 30_000);
    await expect(a.locator(".excalidraw")).toHaveCount(1);
    expect(await liveIds(a)).toEqual(drawn);

    // The hub keeps nothing across a restart until CC-13, so the room only
    // still has these elements because a connected client pushed them back.
    const c = await room.peer("hub-returns");
    await expectCount(c, 2);
    expect(await liveIds(c)).toEqual(drawn);
  });

  test("a room the hub refuses ends in an error and stops retrying", async ({ room }) => {
    const page = await room.page("Not_A_Slug");

    // The hub completes the handshake and only then closes with 1008, so the
    // page truthfully reports `connected` for a moment first: the settled state
    // is the one under test.
    await waitForState(page, "refused");
    await expect(page.locator(".excalidraw")).toHaveCount(0);
    await expect(page.locator("[data-connection-state]")).toHaveAttribute(
      "data-connection-state",
      "refused",
    );
    await expect(page.getByRole("alert")).toBeVisible();

    // `y-websocket` reconnects after every close whatever the code, so an
    // unhandled 1008 would keep opening sockets behind a stuck indicator.
    const opened = await socketsOpened(page);
    await sleep(CONVERGENCE_TIMEOUT / 3);
    expect(await socketsOpened(page)).toBe(opened);
    expect(await liveIds(page)).toEqual([]);
  });
});
