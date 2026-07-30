import { ROOM_SLUG_PATTERN } from "@co-canvas/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import { createHarness, hubRooms, settle, textOf } from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("slug validation", () => {
  it("refuses a slug the shared rule rejects and creates nothing (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const result = await bridge.call("create_room", { slug: "Not_A_Slug" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(ROOM_SLUG_PATTERN.source);
    expect(await hubRooms(hub.url)).toEqual([]);
  });

  it("refuses the same slug for open_room and launches nothing (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    const result = await bridge.call("open_room", { slug: "Not_A_Slug" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(ROOM_SLUG_PATTERN.source);
    await settle();
    expect(await harness.openedUrls()).toEqual([]);
    expect(await hubRooms(hub.url)).toEqual([]);
  });

  it("refuses a slug longer than the rule allows (R4)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });

    // 65 lowercase characters: the boundary a `^[a-z0-9-]+$`-only check misses.
    const tooLong = "a".repeat(65);
    const result = await bridge.call("create_room", { slug: tooLong });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(ROOM_SLUG_PATTERN.source);
    expect(await hubRooms(hub.url)).toEqual([]);
  });
});
