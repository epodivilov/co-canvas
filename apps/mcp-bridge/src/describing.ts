/**
 * The tool that reads.
 *
 * `describe_scene` is the other half of the agent loop CC-16 opened: without it
 * an agent draws blind and cannot touch a board a person has already edited.
 * Every call renders the room as it is at that moment — nothing is cached
 * between calls, and nothing is held between them either.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeScene } from "./describe.ts";
import { elementsOf, readScene } from "./elements.ts";
import type { RoomAccess } from "./room.ts";
import { openRoom } from "./room.ts";

const extentShape = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
});

export function registerDescribeTool(server: McpServer, deps: RoomAccess): void {
  server.registerTool(
    "describe_scene",
    {
      title: "Read a board",
      description:
        "Describes everything on a co-canvas board as text: what is on it, what each element" +
        " is called, which arrows connect what, which frames and groups hold what, and where" +
        " every element sits. Read this before drawing on a board that is not empty — the" +
        " coordinates it reports are the ones to place new elements against.",
      inputSchema: { slug: z.string().describe("Board slug, e.g. `auth-redesign`.") },
      outputSchema: {
        slug: z.string().describe("The board that was read."),
        elements: z.number().int().describe("Elements the board holds, labels included."),
        nodes: z
          .number()
          .int()
          .describe("Elements described as nodes: everything but arrows, frames and labels."),
        arrows: z.number().int().describe("Arrows on the board."),
        extent: extentShape
          .nullable()
          .describe("Box enclosing everything on the board; null when it is empty."),
      },
    },
    async ({ slug }) => {
      const room = await openRoom(deps, slug);
      const { text, summary } = describeScene(readScene(elementsOf(room.doc)));

      // The description travels as text and the numbers as structured content,
      // and neither repeats the other: sending the description twice would undo
      // the format's whole cost advantage. The SDK validates structured content
      // against the schema above but never synthesises text from it, so the
      // text block is this tool's to write.
      return {
        content: [{ type: "text", text }],
        structuredContent: { slug, ...summary },
      };
    },
  );
}
