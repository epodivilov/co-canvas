import type { Page } from "@playwright/test";
import { type BridgeClient, startBridge, textOf } from "./bridge-client.ts";
import { expect, test } from "./fixtures.ts";
import { drawFreehand, drawRect, liveElements, liveIds, selectAt, writeNote } from "./helpers.ts";

/**
 * `describe_scene` against a board a person is editing with a real mouse.
 *
 * The bridge runs as the built bundle in a child process, so what these
 * scenarios drive is the shipped tool rather than the source. The point of them
 * is the half of the loop no in-process scenario can reach: a person changes
 * the board, and the very next description says so.
 */
let bridge: BridgeClient | null = null;

test.afterEach(async () => {
  await bridge?.close();
  bridge = null;
});

async function connectBridge(hubUrl: string): Promise<BridgeClient> {
  bridge = await startBridge(Number(new URL(hubUrl).port));
  return bridge;
}

async function describe(client: BridgeClient, slug: string): Promise<string> {
  const result = await client.call("describe_scene", { slug });
  expect(result.isError, textOf(result)).toBeFalsy();
  return textOf(result);
}

/** The lines of one section of a description. */
function section(description: string, heading: string): string[] {
  const headings = new Set(["NODES", "CONTAINERS", "ARROWS", "GEOMETRY"]);
  const lines: string[] = [];
  let inside = false;
  for (const line of description.split("\n")) {
    if (line === "") continue;
    if (!line.startsWith(" ")) {
      inside = headings.has(line.split(" ")[0] ?? "") && line.startsWith(heading);
      continue;
    }
    if (inside) lines.push(line.slice(2));
  }
  return lines;
}

/**
 * How this page's screen points map onto scene coordinates.
 *
 * Two probes rather than one: the second pins the scale, so a canvas that came
 * up zoomed fails here instead of quietly turning every drag below into a
 * shorter one than the assertion expects.
 */
async function calibrate(page: Page): Promise<{ dx: number; dy: number }> {
  await drawRect(page, 400, 200, 60, 40);
  await drawRect(page, 700, 200, 60, 40);
  await expect.poll(async () => (await liveIds(page)).length).toBe(2);

  const probes = (await liveElements(page)).slice().sort((a, b) => a.x - b.x);
  const [left, right] = probes;
  if (left === undefined || right === undefined) throw new Error("the probes never arrived");
  expect(right.x - left.x, "the canvas is not at zoom 1").toBe(300);
  return { dx: left.x - 400, dy: left.y - 200 };
}

test.describe("describing a board a person is editing", () => {
  test("reports the coordinates a person dragged a shape to (R1, R4)", async ({ hub, room }) => {
    const page = await room.peer("dragged");
    const client = await connectBridge(hub.url);
    const offset = await calibrate(page);

    await client.call("add_elements", {
      slug: "dragged",
      elements: [
        {
          type: "rectangle",
          id: "auth",
          x: 700,
          y: 400,
          width: 180,
          height: 100,
          // Filled, so the person can pick it up from the middle: a transparent
          // shape is only selectable by its stroke, and the stroke is where the
          // selection's resize handles sit.
          backgroundColor: "#ffc9c9",
          fillStyle: "solid",
          label: { text: "Auth" },
        },
      ],
    });
    await expect.poll(async () => (await liveIds(page)).length).toBe(4);
    expect(await describe(client, "dragged")).toContain("auth  700, 400, 180, 100");

    const grab = { x: 700 + 90 - offset.dx, y: 400 + 50 - offset.dy };
    await selectAt(page, grab.x, grab.y);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 60, grab.y - 80, { steps: 5 });
    await page.mouse.move(grab.x + 120, grab.y - 160, { steps: 5 });
    await page.mouse.up();

    // The description is re-read on every call, so the new box is simply there.
    await expect.poll(() => describe(client, "dragged")).toContain("auth  820, 240, 180, 100");
  });

  test("describes a freehand stroke and a loose note a person made (R3, R5)", async ({
    hub,
    room,
  }) => {
    const page = await room.peer("annotated");
    const client = await connectBridge(hub.url);

    await client.call("add_elements", {
      slug: "annotated",
      elements: [
        {
          type: "rectangle",
          id: "auth",
          x: 100,
          y: 100,
          width: 200,
          height: 100,
          label: { text: "Auth" },
        },
      ],
    });
    await expect.poll(async () => (await liveIds(page)).length).toBe(2);

    await drawFreehand(page, [
      [600, 200],
      [660, 260],
      [720, 230],
      [780, 300],
    ]);
    await writeNote(page, 620, 480, "remember to split this");
    await expect.poll(async () => (await liveIds(page)).length).toBe(4);

    const stroke = (await liveElements(page)).find((element) => element.type === "freedraw");
    const note = (await liveElements(page)).find(
      (element) => element.type === "text" && element.containerId === null,
    );
    expect(stroke, "the person's stroke never reached the room").toBeDefined();
    expect(note, "the person's note never reached the room").toBeDefined();

    const description = await describe(client, "annotated");
    const nodes = section(description, "NODES");
    const strokeLine = nodes.find((line) => line.startsWith(`${stroke?.id} `));
    const noteLine = nodes.find((line) => line.startsWith(`${note?.id} `));

    // An element the agent cannot see is an element it will draw on top of.
    expect(strokeLine, description).toBeDefined();
    expect(strokeLine).toContain("freedraw");
    expect(section(description, "GEOMETRY").some((line) => line.startsWith(`${stroke?.id} `))).toBe(
      true,
    );
    // A loose note is content, not decoration.
    expect(noteLine, description).toContain('"remember to split this"');
    expect(noteLine).toContain("text");
  });
});
