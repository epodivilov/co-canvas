import type { IncomingMessage, ServerResponse } from "node:http";
import { isRoomSlug, ROOM_SLUG_RULE } from "@co-canvas/protocol";
import { isAllowedOrigin } from "./origin-allowlist.ts";
import { BoardNotFoundError, type Persistence } from "./persistence.ts";

/** Everything the board endpoints answer under lives beneath this prefix. */
const API_PREFIX = "/api/boards";

/** The constant CORS properties: the origin is decided per request. */
const CORS_METHODS = "GET, POST, PATCH, OPTIONS";
const CORS_ALLOWED_HEADERS = "content-type";

/**
 * CORS for the whole board API, narrowed to the origin allowlist.
 *
 * The overview is served by the hub in production but by the Vite dev server
 * while developing, and that dev server is a different origin — so both the
 * reads and the JSON writes are cross-origin there and would be blocked without
 * this. The origin is reflected only when the allowlist trusts it, never `*`: a
 * browser can reach loopback, so `*` would let any page a user visits read the
 * board list and drive the create / rename / archive operations. `Vary: Origin`
 * keeps a cache from serving one origin's answer to another.
 */
function corsHeaders(request: IncomingMessage, hubPort: number | null): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": CORS_METHODS,
    "access-control-allow-headers": CORS_ALLOWED_HEADERS,
    vary: "Origin",
  };
  const origin = request.headers.origin;
  if (origin !== undefined && isAllowedOrigin(origin, hubPort)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

/**
 * Answers the board endpoints, or reports that the path is not one of theirs.
 *
 * Returns `true` once it has written a response so the caller stops, `false`
 * when the path is nothing to do with the board API so the caller falls through
 * to the static handler. The hub matches this ahead of the SPA fallback on
 * purpose: once a static directory is configured its fallback answers unknown
 * paths with `index.html`, which would turn every board endpoint into HTML.
 */
export type BoardEndpoints = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) => Promise<boolean>;

export function createBoardEndpoints(
  persistence: Persistence,
  getHubPort: () => number | null,
): BoardEndpoints {
  return async (request, response, pathname) => {
    if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) return false;

    const cors = corsHeaders(request, getHubPort());

    const method = request.method ?? "GET";
    if (method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return true;
    }

    const rest = pathname === API_PREFIX ? "" : pathname.slice(`${API_PREFIX}/`.length);

    try {
      if (rest === "") {
        if (method === "GET") return handleList(request, response);
        if (method === "POST") return await handleCreate(persistence, request, response, cors);
        return respondJson(response, 405, { error: `method ${method} not allowed` }, cors);
      }

      // A single path segment names the board; anything with a slash in it is
      // not a slug and so names nothing.
      if (method === "PATCH") return await handlePatch(persistence, request, response, rest, cors);
      return respondJson(response, 405, { error: `method ${method} not allowed` }, cors);
    } catch (error) {
      if (error instanceof BoardNotFoundError) {
        return respondJson(response, 404, { error: error.message }, cors);
      }
      if (error instanceof SyntaxError) {
        return respondJson(response, 400, { error: "request body is not valid JSON" }, cors);
      }
      throw error;
    }

    function handleList(req: IncomingMessage, res: ServerResponse): boolean {
      const url = new URL(req.url ?? "/", "http://hub.local");
      const archived = url.searchParams.get("archived") === "true";
      const boards = persistence
        .listBoards()
        .filter((board) => board.archived === archived)
        // Most-recently-modified first; the slug breaks ties so the order is
        // stable when two logs share an mtime.
        .sort(
          (left, right) => right.updatedAt - left.updatedAt || left.slug.localeCompare(right.slug),
        );
      return respondJson(res, 200, { boards }, cors);
    }
  };
}

async function handleCreate(
  persistence: Persistence,
  request: IncomingMessage,
  response: ServerResponse,
  cors: Record<string, string>,
): Promise<boolean> {
  const body = await readJsonBody(request);
  const slug = readString(body, "slug");
  if (slug === null || !isRoomSlug(slug)) {
    // Refused before anything is written: no log, no index entry, no metadata.
    return respondJson(response, 400, { error: `invalid board slug: ${ROOM_SLUG_RULE}` }, cors);
  }

  const { board, created } = await persistence.createBoard(slug);
  return respondJson(response, created ? 201 : 200, { board, created }, cors);
}

async function handlePatch(
  persistence: Persistence,
  request: IncomingMessage,
  response: ServerResponse,
  slug: string,
  cors: Record<string, string>,
): Promise<boolean> {
  if (!isRoomSlug(slug)) {
    return respondJson(response, 400, { error: `invalid board slug: ${ROOM_SLUG_RULE}` }, cors);
  }

  const body = await readJsonBody(request);
  if (body === null || typeof body !== "object") {
    return respondJson(response, 400, { error: "expected a JSON object body" }, cors);
  }
  const record = body as Record<string, unknown>;

  let board = null;
  if ("title" in record) {
    const raw = record.title;
    const title = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    board = await persistence.setBoardTitle(slug, title);
  }
  if ("archived" in record) {
    board = await persistence.setBoardArchived(slug, record.archived === true);
  }

  if (board === null) {
    const error = "nothing to change: send `title` or `archived`";
    return respondJson(response, 400, { error }, cors);
  }
  return respondJson(response, 200, { board }, cors);
}

/** Reads the whole request body and parses it as JSON, or `undefined` when empty. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return undefined;
  return JSON.parse(raw);
}

function readString(body: unknown, key: string): string | null {
  if (body === null || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  cors: Record<string, string>,
): boolean {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...cors,
  });
  response.end(JSON.stringify(payload));
  return true;
}
