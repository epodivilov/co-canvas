import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./test-helpers.ts";
import {
  BOUND_TEXT_PADDING,
  createHarness,
  roomElement,
  roomIds,
  roomScene,
  settle,
  textOf,
  waitForCount,
} from "./test-helpers.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A box, as every geometric assertion here wants to read it. */
function box(element: Record<string, unknown> | undefined): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const x = Number(element?.x);
  const y = Number(element?.y);
  return {
    left: x,
    top: y,
    right: x + Number(element?.width),
    bottom: y + Number(element?.height),
  };
}

describe("labels", () => {
  it("binds a text element to its container both ways (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
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

    await waitForCount(peer, 2);
    const scene = roomScene(peer.doc);
    const rectangle = scene.find((element) => element.type === "rectangle");
    const text = scene.find((element) => element.type === "text");
    expect(text?.containerId).toBe("auth");
    expect(rectangle?.boundElements).toEqual([{ type: "text", id: text?.id }]);
    expect(text?.text).toBe("Auth");
  });

  it("keeps the label inside its container with the bound-text padding (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "auth",
          x: 30,
          y: 40,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });

    await waitForCount(peer, 2);
    const container = box(roomElement(peer.doc, "auth"));
    const label = box(roomScene(peer.doc).find((element) => element.type === "text"));
    expect(label.left - container.left).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
    expect(label.top - container.top).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
    expect(container.right - label.right).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
    expect(container.bottom - label.bottom).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
  });

  it("sorts a label immediately after its own container (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
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
        { type: "rectangle", id: "later", x: 300, y: 0, width: 200, height: 100 },
      ],
    });

    await waitForCount(peer, 3);
    const ids = roomIds(peer.doc);
    const text = roomScene(peer.doc).find((element) => element.type === "text");
    // Upstream returns bound text at the very end of its result, which would
    // leave the container and its label separated by everything drawn between.
    expect(ids).toEqual(["auth", String(text?.id), "later"]);
  });

  it("wraps a long label and grows the container to hold it (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const sentence = "Authentication service handles login and token refresh";
    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        {
          type: "rectangle",
          id: "auth",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          label: { text: sentence },
        },
      ],
    });

    await waitForCount(peer, 2);
    const text = roomScene(peer.doc).find((element) => element.type === "text");
    expect(String(text?.text).split("\n").length).toBeGreaterThan(1);
    expect(text?.originalText).toBe(sentence);

    const container = box(roomElement(peer.doc, "auth"));
    const label = box(text);
    expect(container.bottom - container.top).toBeGreaterThan(100);
    expect(label.left - container.left).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
    expect(container.right - label.right).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
    expect(label.top - container.top).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
    expect(container.bottom - label.bottom).toBeGreaterThanOrEqual(BOUND_TEXT_PADDING);
  });

  it("centres a label on the arrow it belongs to (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "arrow", id: "flow", x: 0, y: 0, width: 300, height: 0, label: { text: "calls" } },
      ],
    });

    await waitForCount(peer, 2);
    const arrow = roomElement(peer.doc, "flow");
    const text = roomScene(peer.doc).find((element) => element.type === "text");
    expect(text?.containerId).toBe("flow");
    expect(arrow?.boundElements).toEqual([{ type: "text", id: text?.id }]);

    const label = box(text);
    const midX = Number(arrow?.x) + Number(arrow?.width) / 2;
    const midY = Number(arrow?.y) + Number(arrow?.height) / 2;
    expect(Math.abs((label.left + label.right) / 2 - midX)).toBeLessThan(1);
    expect(Math.abs((label.top + label.bottom) / 2 - midY)).toBeLessThan(1);
  });

  it("refuses a label on a line (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "line", id: "rule", x: 0, y: 0, width: 100, height: 0, label: { text: "nope" } },
      ],
    });

    // Upstream drops it silently, which would leave the agent believing it
    // drew a label nobody can see. The schema names the element by position
    // rather than by id, because it is what rejects the call.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("label");
    expect(textOf(result)).toContain("elements[0]");
    await settle();
    expect(roomScene(peer.doc)).toEqual([]);
  });

  it("refuses a label on a bare text element (R2)", async () => {
    const hub = await harness.startHub();
    const bridge = await harness.connect({ hubPort: hub.port });
    await bridge.call("create_room", { slug: "alpha" });
    const peer = await harness.openPeer(hub.url, "alpha");

    const result = await bridge.call("add_elements", {
      slug: "alpha",
      elements: [
        { type: "rectangle", id: "box", x: 0, y: 0, width: 50, height: 50 },
        { type: "text", id: "note", x: 0, y: 0, text: "hi", label: { text: "nope" } },
      ],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("label");
    expect(textOf(result)).toContain("elements[1]");
    await settle();
    expect(roomScene(peer.doc)).toEqual([]);
  });
});
