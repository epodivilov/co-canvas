/**
 * The tool that reads what the human has selected.
 *
 * `describe_scene` lets an agent address elements by id; `get_selection` lets
 * the human point instead. The browser already publishes its live
 * `selectedElementIds` to Yjs awareness (y-excalidraw sets the field, the hub
 * relays it), so nothing new travels on the wire — this tool reads the
 * awareness the room connection already carries, resolves the selected ids to
 * the current scene, and returns each one in the same per-element shape
 * `describe_scene` emits (CC-28).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Described } from "./describe.ts";
import { describeScene } from "./describe.ts";
import { shapeShape, toShape } from "./describing.ts";
import { elementsOf, readScene } from "./elements.ts";
import type { RoomAccess, RoomAwareness } from "./room.ts";
import { openRoom } from "./room.ts";

/**
 * How long to wait for a human's awareness to appear before concluding there is
 * none. Awareness is a separate frame from doc sync, so on a cold first call the
 * human's snapshot can arrive a tick after the socket opens — reading `getStates`
 * straight away would report a false "no one present". A warm connection has the
 * human already in it and returns at once; only a genuinely empty board pays the
 * full wait.
 */
const AWARENESS_SETTLE_MS = 500;
/** How often the settle re-checks for a human peer while it waits. */
const AWARENESS_POLL_MS = 25;

/** What the resolver concludes about a room's live selection. */
export interface ResolvedSelection {
  /**
   * Whether any human peer is on the board. Distinguishes the two empty cases
   * (R3): `false` with no shapes means no one is present; `true` with no shapes
   * means someone is present but has nothing selected.
   */
  readonly humanPresent: boolean;
  /** The selected elements, resolved to the current scene, in document order. */
  readonly shapes: readonly Described[];
}

/** The ids a peer's awareness state names as selected — truthy values only. */
function selectedIdsOf(state: Record<string, unknown>): string[] {
  const raw = state.selectedElementIds;
  if (raw === null || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, selected]) => Boolean(selected))
    .map(([id]) => id);
}

/**
 * Resolves the room's awareness into the selection a human has made.
 *
 * Pure, so the logic is testable without a live socket: it takes the awareness
 * states, the provider's own client id, and the described scene, and returns the
 * selected elements' geometry. Every remote state (any that is not the bridge's
 * own) is a human for this MVP. Selected ids are the de-duplicated union across
 * those states (R2); an id that no longer resolves to a scene element is dropped
 * rather than errored (R4).
 */
export function resolveSelection(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
  shapes: readonly Described[],
): ResolvedSelection {
  const selected = new Set<string>();
  let humanPresent = false;
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    humanPresent = true;
    for (const id of selectedIdsOf(state)) selected.add(id);
  }
  // Filtering the described scene keeps document order and drops stale ids in
  // one step: an id in the selection but not in the scene simply matches nothing.
  return { humanPresent, shapes: shapes.filter((shape) => selected.has(shape.id)) };
}

/** Whether any awareness state other than the bridge's own is present. */
function hasHumanPeer(awareness: RoomAwareness): boolean {
  for (const clientId of awareness.getStates().keys()) {
    if (clientId !== awareness.clientID) return true;
  }
  return false;
}

/** Waits, bounded, for a human peer to appear before the tool reads the states. */
async function settleForHuman(awareness: RoomAwareness): Promise<void> {
  if (hasHumanPeer(awareness)) return;
  const deadline = Date.now() + AWARENESS_SETTLE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, AWARENESS_POLL_MS));
    if (hasHumanPeer(awareness)) return;
  }
}

/** The text block a text-only harness renders for a selection. */
function selectionText(slug: string, selection: ResolvedSelection): string {
  if (!selection.humanPresent) {
    return `No one is on board "${slug}" right now, so there is no selection to read.`;
  }
  if (selection.shapes.length === 0) {
    return `Someone is on board "${slug}" but has nothing selected.`;
  }
  const lines = selection.shapes.map((shape) => {
    const label = shape.label === null ? "" : ` "${shape.label}"`;
    return `  ${shape.id} — ${shape.type}${label} at (${shape.x}, ${shape.y}) ${shape.width}x${shape.height}`;
  });
  const count = selection.shapes.length;
  return `Selected ${count} element${count === 1 ? "" : "s"} on board "${slug}":\n${lines.join("\n")}`;
}

export function registerSelectionTool(server: McpServer, deps: RoomAccess): void {
  server.registerTool(
    "get_selection",
    {
      title: "Read the human's selection",
      description:
        "Returns the elements the human currently has selected on a co-canvas board, so you can" +
        " act on what they pointed at rather than asking them to read element ids off the board." +
        " Each element comes back in the same per-element geometry describe_scene reports. When no" +
        " one is on the board, or the person present has nothing selected, it says so.",
      inputSchema: { slug: z.string().describe("Board slug, e.g. `auth-redesign`.") },
      outputSchema: {
        slug: z.string().describe("The board that was read."),
        humanPresent: z
          .boolean()
          .describe(
            "Whether a human peer is on the board. Tells the two empty cases apart: false with no" +
              " shapes means no one is present; true with no shapes means present but nothing selected.",
          ),
        selected: z.number().int().describe("How many selected elements resolved to the scene."),
        shapes: z
          .array(shapeShape)
          .describe(
            "Each selected element's geometry — box, identity and bindings — the same per-element" +
              " object describe_scene emits (CC-28). Stale ids no longer in the scene are omitted.",
          ),
      },
    },
    async ({ slug }) => {
      const room = await openRoom(deps, slug);

      // Give a cold connection a moment for the human's awareness to land before
      // reading it, so a first call does not report a false "no one present".
      await settleForHuman(room.awareness);

      const { shapes } = describeScene(readScene(elementsOf(room.doc)));
      const selection = resolveSelection(
        room.awareness.getStates(),
        room.awareness.clientID,
        shapes,
      );

      return {
        content: [{ type: "text", text: selectionText(slug, selection) }],
        structuredContent: {
          slug,
          humanPresent: selection.humanPresent,
          selected: selection.shapes.length,
          shapes: selection.shapes.map(toShape),
        },
      };
    },
  );
}
