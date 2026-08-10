import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import {
  BOUND_TEXT_PADDING,
  createHarness,
  roomElement,
  roomScene,
  settle,
  textOf,
  waitFor,
  waitForCount,
} from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

function fits(container: Record<string, unknown>, label: Record<string, unknown>): void {
  const cx = Number(container.x);
  const cy = Number(container.y);
  const lx = Number(label.x);
  const ly = Number(label.y);
  expect(lx - cx).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
  expect(ly - cy).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
  expect(cx + Number(container.width) - (lx + Number(label.width))).toBeGreaterThanOrEqual(
    BOUND_TEXT_PADDING,
  );
  expect(cy + Number(container.height) - (ly + Number(label.height))).toBeGreaterThanOrEqual(
    BOUND_TEXT_PADDING,
  );
}

describe("update_elements", () => {
  it("changes only the fields the patch names, and marks the element changed (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          backgroundColor: "#ffc9c9",
        },
      ],
    });
    await waitForCount(peer, 1);
    const before = { ...roomElement(peer.doc, "box") };

    const result = await bridge.call("update_elements", {
      slug: "alpha",
      patches: [{ id: "box", x: 500, y: 250 }],
    });

    expect(result.isError).toBeFalsy();
    await waitFor(
      () => roomElement(peer.doc, "box")?.x === 500,
      "the patched rectangle never moved",
    );
    const after = roomElement(peer.doc, "box");
    expect(after).toMatchObject({ x: 500, y: 250, backgroundColor: "#ffc9c9", width: 100 });
    expect(Number(after?.version)).toBeGreaterThan(Number(before.version));
    expect(after?.versionNonce).not.toBe(before.versionNonce);
    expect(Number(after?.updated)).toBeGreaterThanOrEqual(Number(before.updated));
  });

  it("leaves every other element byte-for-byte alone (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "one", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "two", x: 200, y: 0, width: 100, height: 100 },
      ],
    });
    await waitForCount(peer, 2);
    const untouched = JSON.stringify(roomElement(peer.doc, "two"));

    await bridge.call("update_elements", { slug: "alpha", patches: [{ id: "one", x: 40 }] });

    await waitFor(
      () => roomElement(peer.doc, "one")?.x === 40,
      "the patched rectangle never moved",
    );
    expect(JSON.stringify(roomElement(peer.doc, "two"))).toBe(untouched);
  });

  it("moves a bound label with its container (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });
    await waitForCount(peer, 2);
    const labelBefore = roomScene(peer.doc).find((element) => element.type === "text");

    await bridge.call("update_elements", {
      slug: "alpha",
      patches: [{ id: "box", x: 400, y: 300 }],
    });

    await waitFor(() => roomElement(peer.doc, "box")?.x === 400, "the container never moved");
    const container = roomElement(peer.doc, "box");
    const label = roomScene(peer.doc).find((element) => element.type === "text");
    expect(label?.x).not.toBe(labelBefore?.x);
    expect(container).toBeDefined();
    expect(label).toBeDefined();
    if (container !== undefined && label !== undefined) fits(container, label);
  });

  it("re-fits a label whose text got much longer (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 60, label: { text: "Hi" } },
      ],
    });
    await waitForCount(peer, 2);

    const sentence = "Authentication service handles login and token refresh";
    await bridge.call("update_elements", {
      slug: "alpha",
      patches: [{ id: "box", label: { text: sentence } }],
    });

    await waitFor(
      () => roomScene(peer.doc).some((element) => element.originalText === sentence),
      "the label text never changed",
    );
    const container = roomElement(peer.doc, "box");
    const label = roomScene(peer.doc).find((element) => element.type === "text");
    expect(String(label?.text).split("\n").length).toBeGreaterThan(1);
    expect(Number(container?.height)).toBeGreaterThan(60);
    expect(container).toBeDefined();
    expect(label).toBeDefined();
    if (container !== undefined && label !== undefined) fits(container, label);
  });

  it("turns a bound label with the container it belongs to (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });
    await waitForCount(peer, 2);

    await bridge.call("update_elements", { slug: "alpha", patches: [{ id: "box", angle: 0.4 }] });

    await waitFor(() => roomElement(peer.doc, "box")?.angle === 0.4, "the container never turned");
    // Excalidraw keeps a bound text at its container's angle; a label left flat
    // under a turned box is a state the app itself never produces.
    const label = roomScene(peer.doc).find((element) => element.type === "text");
    expect(label?.angle).toBe(0.4);
  });

  it("refuses a patch that would move a label out of its container (R2, R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });
    await waitForCount(peer, 2);
    const label = roomScene(peer.doc).find((element) => element.type === "text");
    const before = JSON.stringify(roomScene(peer.doc));

    const result = await bridge.call("update_elements", {
      slug: "alpha",
      patches: [{ id: String(label?.id), x: 9000 }],
    });

    // A label's box belongs to its container. Moving it by hand breaks the fit
    // R2 requires, and nothing would ever put it back.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(String(label?.id));
    expect(textOf(result)).toContain("box");
    await settle();
    expect(JSON.stringify(roomScene(peer.doc))).toBe(before);
  });

  it("reports the post-update box after a move and a relabel (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 60, label: { text: "Hi" } },
      ],
    });
    await waitForCount(peer, 2);

    const sentence = "Authentication service handles login and token refresh";
    const result = await bridge.call("update_elements", {
      slug: "alpha",
      patches: [{ id: "box", x: 400, y: 300, label: { text: sentence } }],
    });

    expect(result.isError).toBeFalsy();
    const box = (
      result.structuredContent as {
        shapes: { id: string; x: number; y: number; width: number; height: number }[];
      }
    ).shapes.find((shape) => shape.id === "box");
    // The move and the label's grow are both in the reported box.
    expect(box).toMatchObject({ id: "box", x: 400, y: 300 });
    expect(Number(box?.height)).toBeGreaterThan(60);

    // And it is the box the room actually stores, read back after the write.
    await waitFor(() => roomElement(peer.doc, "box")?.x === 400, "the container never moved");
    expect(Number(box?.width)).toBe(Number(roomElement(peer.doc, "box")?.width));
    expect(Number(box?.height)).toBe(Number(roomElement(peer.doc, "box")?.height));
  });

  it("re-routes a bound arrow to new waypoints and refreshes its bindings (R3)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "left", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "right", x: 300, y: 0, width: 100, height: 100 },
        { type: "arrow", id: "flow", start: { id: "left" }, end: { id: "right" } },
      ],
    });
    await waitForCount(peer, 3);
    // The routed arrow starts life straight: two points.
    expect(((roomElement(peer.doc, "flow")?.points as unknown[] | undefined) ?? []).length).toBe(2);

    const result = await bridge.call("update_elements", {
      slug: "alpha",
      patches: [
        {
          id: "flow",
          points: [
            [100, 50],
            [200, 200],
            [300, 50],
          ],
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    await waitFor(
      () => (roomElement(peer.doc, "flow")?.points as unknown[] | undefined)?.length === 3,
      "the arrow never adopted the new waypoints",
    );

    const arrow = roomElement(peer.doc, "flow");
    const startBinding = arrow?.startBinding as { elementId: string; focus: number } | undefined;
    const endBinding = arrow?.endBinding as { elementId: string; focus: number } | undefined;
    // Same shapes, bindings refreshed to the new terminal segments (focus ~0).
    expect(startBinding).toMatchObject({ elementId: "left" });
    expect(endBinding).toMatchObject({ elementId: "right" });
    expect(Math.abs(Number(startBinding?.focus))).toBeLessThan(0.01);
    expect(Math.abs(Number(endBinding?.focus))).toBeLessThan(0.01);
    // The box is recomputed from the new waypoints' extent.
    expect(Number(arrow?.width)).toBeCloseTo(200, 5);
    expect(Number(arrow?.height)).toBeCloseTo(100, 5);

    const described = await bridge.call("describe_scene", { slug: "alpha" });
    const shapes = (
      described.structuredContent as {
        shapes: { id: string; points: { x: number; y: number }[] | null }[];
      }
    ).shapes;
    const reported = shapes.find((shape) => shape.id === "flow")?.points;
    expect(reported).toHaveLength(3);
    // The interior bend the caller asked for is reported back unchanged.
    expect(reported?.[1]).toEqual({ x: 200, y: 200 });
  });

  it("refuses a patch naming an id the room does not hold (R6)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "one", x: 0, y: 0, width: 100, height: 100 },
        { type: "rectangle", id: "two", x: 200, y: 0, width: 100, height: 100 },
      ],
    });
    await waitForCount(peer, 2);
    const before = JSON.stringify(roomScene(peer.doc));

    const result = await bridge.call("update_elements", {
      slug: "alpha",
      patches: [
        { id: "one", x: 40 },
        { id: "absent", x: 40 },
      ],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("absent");
    await settle();
    expect(JSON.stringify(roomScene(peer.doc))).toBe(before);
  });
});
