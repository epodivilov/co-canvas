import type { BoardListing } from "@co-canvas/protocol";
import { currentHubUrlSources, type HubUrlSources, resolveHubBaseUrl } from "../room/hub-url.ts";

/**
 * The hub's HTTP origin for the board API.
 *
 * `resolveHubBaseUrl` answers a `ws`/`wss` base — it exists for the sync socket
 * — so the scheme is flipped to `http`/`https` here. Everything else about
 * where the hub is (the `hub` query parameter, `VITE_HUB_URL`, dev loopback,
 * same-origin production) is settled there and reused, so the board API and the
 * canvas always talk to the same hub.
 */
export function resolveHubHttpBase(sources: HubUrlSources): string {
  return resolveHubBaseUrl(sources).replace(/^ws/, "http");
}

/** Base URL of the board API on the running page's hub. */
function boardsBase(): string {
  return `${resolveHubHttpBase(currentHubUrlSources())}/api/boards`;
}

/** Raised when the hub answers a board request with a non-2xx status. */
export class BoardRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BoardRequestError";
    this.status = status;
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Fall through to the generic message below.
  }
  return `board request failed (${response.status})`;
}

/** Lists the boards the hub holds — the active set, or the archived set. */
export async function listBoards(options: { archived?: boolean } = {}): Promise<BoardListing[]> {
  const query = options.archived === true ? "?archived=true" : "";
  const response = await fetch(`${boardsBase()}${query}`);
  if (!response.ok) throw new BoardRequestError(response.status, await readError(response));
  const body = (await response.json()) as { boards: BoardListing[] };
  return body.boards;
}

/** Creates (or joins) a board under `slug`. The hub is authoritative on the slug rule. */
export async function createBoard(slug: string): Promise<BoardListing> {
  const response = await fetch(boardsBase(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (!response.ok) throw new BoardRequestError(response.status, await readError(response));
  const body = (await response.json()) as { board: BoardListing };
  return body.board;
}

async function patchBoard(slug: string, change: Record<string, unknown>): Promise<BoardListing> {
  const response = await fetch(`${boardsBase()}/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new BoardRequestError(response.status, await readError(response));
  const body = (await response.json()) as { board: BoardListing };
  return body.board;
}

/** Sets a board's title. An empty title clears it back to the slug. */
export function renameBoard(slug: string, title: string): Promise<BoardListing> {
  return patchBoard(slug, { title });
}

/** Archives a board out of the default overview. */
export function archiveBoard(slug: string): Promise<BoardListing> {
  return patchBoard(slug, { archived: true });
}

/** Restores an archived board to the default overview. */
export function restoreBoard(slug: string): Promise<BoardListing> {
  return patchBoard(slug, { archived: false });
}
