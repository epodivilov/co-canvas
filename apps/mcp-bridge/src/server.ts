import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { boardUrl } from "./board.ts";
import type { CommandSpec } from "./command.ts";
import { createRoomConnections } from "./connections.ts";
import { registerDrawingTools } from "./drawing.ts";
import type { HubAccess } from "./hub.ts";
import { acquireHub, listHubRooms } from "./hub.ts";
import { openInBrowser } from "./opener.ts";
import { assertRoomSlug } from "./slug.ts";

export interface BridgeOptions {
  /** Port to look for a hub on. Without it, the protocol's default. */
  readonly hubPort?: number;
  /**
   * Directory holding the hub lockfile and room data. Without it,
   * `~/.co-canvas`, which is right in production and never right in a test.
   */
  readonly hubDataDir?: string;
  /**
   * Resolves the command that starts a hub when none is reachable.
   *
   * A function rather than a value because the default resolution can fail, and
   * that failure has to arrive as a tool error rather than as a bridge that
   * never came up. See {@link resolveHubCommand}.
   */
  readonly hubCommand: () => CommandSpec;
  /** Command that opens a board URL; the URL is appended as its last argument. */
  readonly openCommand: CommandSpec;
}

export interface Bridge {
  readonly server: McpServer;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

const SERVER_INFO = { name: "co-canvas", version: "0.0.0" } as const;

const INSTRUCTIONS =
  "co-canvas boards are live whiteboards shared with a human in their browser." +
  " Call list_rooms to see what is open, create_room to make a board (idempotent)," +
  " and open_room to get a board's URL and show it to the human." +
  " Draw with add_elements, update_elements and delete_elements: everything you draw" +
  " appears in the human's browser at once, without them reloading anything.";

/** Shape of a room in every tool's structured output. */
const roomShape = {
  slug: z.string().describe("The board's slug."),
  url: z.string().describe("URL a browser opens the board at."),
  peers: z.number().int().describe("Clients currently connected to the room."),
};

/**
 * Builds the MCP server.
 *
 * A factory taking everything it touches as an option, so a scenario can drive
 * it over an in-memory transport against a hub on a port the OS handed out.
 * The entry point is what reads the environment.
 */
export function createBridge(options: BridgeOptions): Bridge {
  const connections = createRoomConnections();
  const access: HubAccess = {
    command: options.hubCommand,
    ...(options.hubPort === undefined ? {} : { port: options.hubPort }),
    ...(options.hubDataDir === undefined ? {} : { dataDir: options.hubDataDir }),
  };

  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  // Every tool answers with both a text summary and structured content: a
  // harness that renders only text still shows the human a URL they can click.

  server.registerTool(
    "list_rooms",
    {
      title: "List boards",
      description:
        "Lists the co-canvas boards the hub currently holds, with their URLs and how many" +
        " clients are connected to each.",
      outputSchema: { rooms: z.array(z.object(roomShape)).describe("Boards the hub holds.") },
    },
    async () => {
      const hub = await acquireHub(access);
      const rooms = (await listHubRooms(hub.url)).map((room) => ({
        slug: room.slug,
        url: boardUrl(hub.url, room.slug),
        peers: room.peers,
      }));

      const text =
        rooms.length === 0
          ? "No boards are open."
          : rooms.map((room) => `${room.slug} — ${room.url} (${room.peers} connected)`).join("\n");
      return { content: [{ type: "text", text }], structuredContent: { rooms } };
    },
  );

  server.registerTool(
    "create_room",
    {
      title: "Create a board",
      description:
        "Opens a co-canvas board under the given slug, starting the hub if it is not running." +
        " Idempotent: a slug that already names a board comes back untouched.",
      inputSchema: { slug: z.string().describe("Board slug, e.g. `auth-redesign`.") },
      outputSchema: {
        slug: roomShape.slug,
        url: roomShape.url,
        created: z.boolean().describe("False when the board already existed."),
      },
    },
    async ({ slug }) => {
      assertRoomSlug(slug);
      const hub = await acquireHub(access);
      const existed = (await listHubRooms(hub.url)).some((room) => room.slug === slug);

      // Connecting is what makes the hub hold the room, and it is also how an
      // existing one is joined: an empty local document merges into whatever is
      // already there, adding nothing and removing nothing. That matters after
      // a hub restart, when a board with content on disk is not yet in the
      // hub's memory and the caller is told to create it (CC-13 closes that).
      await connections.open(hub.url, slug);

      const url = boardUrl(hub.url, slug);
      const text = existed
        ? `Board "${slug}" already exists: ${url}`
        : `Created board "${slug}": ${url}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { slug, url, created: !existed },
      };
    },
  );

  server.registerTool(
    "open_room",
    {
      title: "Open a board",
      description:
        "Returns the URL of an existing co-canvas board and, unless asked not to, launches the" +
        " user's browser on it. Use create_room first if the board does not exist yet.",
      inputSchema: {
        slug: z.string().describe("Board slug, e.g. `auth-redesign`."),
        open: z
          .boolean()
          .default(true)
          .describe("Whether to launch a browser. Set false to only get the URL."),
      },
      outputSchema: {
        slug: roomShape.slug,
        url: roomShape.url,
        opened: z.boolean().describe("Whether a browser was actually launched."),
      },
    },
    async ({ slug, open }) => {
      assertRoomSlug(slug);
      const hub = await acquireHub(access);

      // Answered from the room listing rather than by connecting: opening a
      // board is not a reason to join it, and creating one is create_room's job
      // alone — otherwise a typo silently makes an empty board.
      const rooms = await listHubRooms(hub.url);
      if (!rooms.some((room) => room.slug === slug)) {
        throw new Error(
          `no board named "${slug}" is open. Call create_room with slug "${slug}" first.`,
        );
      }

      const url = boardUrl(hub.url, slug);
      const opened = open ? await openInBrowser(options.openCommand, url) : false;
      return {
        content: [{ type: "text", text: openText(slug, url, open, opened) }],
        structuredContent: { slug, url, opened },
      };
    },
  );

  // Registered on the same factory and handed the same connection cache: a
  // board an agent has drawn on is a board it is already a peer of.
  registerDrawingTools(server, { access, connections });

  return {
    server,
    connect: (transport) => server.connect(transport),
    async close() {
      connections.closeAll();
      await server.close();
    },
  };
}

function openText(slug: string, url: string, requested: boolean, opened: boolean): string {
  if (opened) return `Opened board "${slug}" in a browser: ${url}`;
  if (!requested) return `Board "${slug}": ${url}`;
  return `Board "${slug}": ${url} — no browser could be launched on this host, so the URL has to be opened by hand.`;
}
