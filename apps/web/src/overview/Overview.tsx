import type { BoardListing } from "@co-canvas/protocol";
import { isRoomSlug, ROOM_SLUG_RULE } from "@co-canvas/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  archiveBoard,
  createBoard,
  listBoards,
  renameBoard,
  restoreBoard,
} from "./boards-client.ts";

type View = "active" | "archived";

/**
 * The board overview at `/`: every board the hub holds, and the controls to
 * open, create, rename and archive one — so a person reaches a board without
 * ever typing a slug into the URL bar.
 *
 * The list and every mutation travel over the hub's HTTP board API rather than
 * the sync socket: the page is plain data until a board is opened, and the hub
 * is the one origin the browser can reach for it.
 */
export function Overview() {
  const [view, setView] = useState<View>("active");
  const [boards, setBoards] = useState<BoardListing[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (which: View) => {
    setLoadError(null);
    try {
      setBoards(await listBoards({ archived: which === "archived" }));
    } catch (error) {
      setBoards([]);
      setLoadError(error instanceof Error ? error.message : "could not reach the hub");
    }
  }, []);

  useEffect(() => {
    void refresh(view);
  }, [view, refresh]);

  return (
    <main className="overview">
      <header className="overview__header">
        <h1 className="overview__title">co-canvas</h1>
        <nav className="overview__tabs" aria-label="Board views">
          <button
            type="button"
            data-testid="view-active"
            className="overview__tab"
            aria-pressed={view === "active"}
            onClick={() => setView("active")}
          >
            Boards
          </button>
          <button
            type="button"
            data-testid="view-archived"
            className="overview__tab"
            aria-pressed={view === "archived"}
            onClick={() => setView("archived")}
          >
            Archived
          </button>
        </nav>
      </header>

      {view === "active" ? <CreateForm /> : null}

      {loadError !== null ? (
        <p className="overview__error" role="alert" data-testid="board-load-error">
          {loadError}
        </p>
      ) : null}

      <BoardList view={view} boards={boards} onChanged={() => refresh(view)} />
    </main>
  );
}

/** Sends the browser to a board, carrying the current query so the hub stays the same one. */
function openBoard(slug: string): void {
  window.location.assign(`/room/${slug}${window.location.search}`);
}

function CreateForm() {
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const candidate = slug.trim();
      // A local check for immediate feedback; the hub validates again and is the
      // authority, so an invalid slug never reaches it as a write.
      if (!isRoomSlug(candidate)) {
        setError(ROOM_SLUG_RULE);
        return;
      }
      setError(null);
      try {
        await createBoard(candidate);
        openBoard(candidate);
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : "could not create the board");
      }
    },
    [slug],
  );

  return (
    <form className="create-form" onSubmit={submit}>
      <input
        type="text"
        className="create-form__input"
        data-testid="create-slug"
        placeholder="new-board-slug"
        value={slug}
        onChange={(event) => setSlug(event.target.value)}
        aria-label="New board slug"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <button type="submit" className="create-form__submit" data-testid="create-submit">
        Create board
      </button>
      {error !== null ? (
        <p className="create-form__error" role="alert" data-testid="create-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function BoardList({
  view,
  boards,
  onChanged,
}: {
  view: View;
  boards: BoardListing[] | null;
  onChanged: () => void;
}) {
  if (boards === null) {
    return <p className="overview__loading">Loading boards…</p>;
  }
  if (boards.length === 0) {
    return (
      <p className="overview__empty" data-testid="board-empty">
        {view === "archived"
          ? "No archived boards."
          : "No boards yet. Create one above to get started."}
      </p>
    );
  }
  return (
    <ul className="board-list" data-testid="board-list">
      {boards.map((board) => (
        <BoardRow key={board.slug} view={view} board={board} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function BoardRow({
  view,
  board,
  onChanged,
}: {
  view: View;
  board: BoardListing;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(board.title ?? "");
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const saveTitle = useCallback(() => {
    setRenaming(false);
    void run(() => renameBoard(board.slug, title.trim()));
  }, [board.slug, title, run]);

  return (
    <li className="board-item" data-testid="board-item" data-slug={board.slug}>
      <button
        type="button"
        className="board-item__open"
        data-testid="board-open"
        onClick={() => openBoard(board.slug)}
      >
        <span className="board-item__name" data-testid="board-title">
          {board.title ?? board.slug}
        </span>
        <time className="board-item__time" dateTime={new Date(board.updatedAt).toISOString()}>
          {formatRelativeTime(board.updatedAt)}
        </time>
      </button>

      <div className="board-item__actions">
        {view === "active" ? (
          <>
            <button
              type="button"
              className="board-item__action"
              data-testid="board-rename"
              disabled={busy}
              onClick={() => {
                setTitle(board.title ?? "");
                setRenaming((open) => !open);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="board-item__action"
              data-testid="board-archive"
              disabled={busy}
              onClick={() => run(() => archiveBoard(board.slug))}
            >
              Archive
            </button>
          </>
        ) : (
          <button
            type="button"
            className="board-item__action"
            data-testid="board-restore"
            disabled={busy}
            onClick={() => run(() => restoreBoard(board.slug))}
          >
            Restore
          </button>
        )}
      </div>

      {renaming ? (
        <div className="board-item__rename">
          <input
            type="text"
            className="board-item__rename-input"
            data-testid="rename-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={`Title for ${board.slug}`}
            placeholder={board.slug}
          />
          <button
            type="button"
            className="board-item__action"
            data-testid="rename-save"
            onClick={saveTitle}
          >
            Save
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** A short, legible "when" for a board's last write: relative near now, a date further out. */
function formatRelativeTime(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < minute) return "just now";
  if (abs < hour) return relative.format(Math.round(diff / minute), "minute");
  if (abs < day) return relative.format(Math.round(diff / hour), "hour");
  if (abs < 30 * day) return relative.format(Math.round(diff / day), "day");
  return new Date(ms).toLocaleDateString();
}
