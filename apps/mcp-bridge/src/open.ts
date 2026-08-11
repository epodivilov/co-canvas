/**
 * `co-canvas open`: wake the hub and show every room — in a browser when there
 * is one, and on stdout always.
 *
 * The reusable half of the CLI's `open` subcommand (CC-32), the mirror of
 * `runBridge`. It composes the same primitives a tool call uses — `acquireHub`
 * to wake a sleeping hub, `listHubRooms` to read what it holds, `openInBrowser`
 * to launch the desktop — behind one call a future client (CC-7) can make
 * without going through argv.
 *
 * Its hub, browser and output are injectable so the scenarios drive it with
 * fakes and spawn no real hub or browser; the defaults read the environment and
 * reach the real hub, exactly as `runBridge` does.
 */
import type { HubInfo } from "@co-canvas/hub-client";
import { boardUrl } from "./board.ts";
import { resolveHubCommand, resolveHubPort, resolveOpenCommand } from "./env.ts";
import type { HubAccess, HubRoom } from "./hub.ts";
import { acquireHub, listHubRooms } from "./hub.ts";
import { openInBrowser } from "./opener.ts";

/**
 * Where human-facing text goes.
 *
 * Two channels, because `open`'s stdout is a machine surface: a user can pipe it
 * to grab the URL. The address and the room list go there; the waking notice,
 * the browser outcome and an unknown-slug warning are chatter for `err`.
 */
export interface OpenIo {
  /** The URL and the room list — the part a script would read. */
  readonly out: (line: string) => void;
  /** Status chatter: waking, the browser outcome, an unknown-slug warning. */
  readonly err: (line: string) => void;
}

/** What {@link runOpen} needs, all injectable and all defaulting to the real thing. */
export interface RunOpenOptions {
  /** Board to open; without it, the room overview at the hub root. */
  readonly slug?: string;
  /** Wakes the hub and reports where it is. Defaults to {@link acquireHub} over the environment. */
  readonly acquire?: () => Promise<Pick<HubInfo, "url">>;
  /** Reads the hub's live room listing. Defaults to {@link listHubRooms}. */
  readonly listRooms?: (hubUrl: string) => Promise<HubRoom[]>;
  /** Launches a browser on a URL, reporting whether one started. Defaults to {@link openInBrowser}. */
  readonly open?: (url: string) => Promise<boolean>;
  /** Where output goes. Defaults to stdout for the URL and stderr for chatter. */
  readonly io?: OpenIo;
  /** Environment the defaults resolve from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Wakes the hub, prints its overview URL and rooms, and opens a browser on the
 * overview — or on one board, given a slug.
 *
 * Resolves once the wake, the print and the browser-launch attempt are done. It
 * does not wait for a browser to appear, nor for the hub to sleep again — that
 * "never sleep" mode is CC-23; `open` wakes and detaches. A browser that will
 * not launch is the headless-host normal case, not a failure: the URL is already
 * on stdout and this still resolves. The one thing that rejects is being unable
 * to wake or reach the hub — a caller maps that to a non-zero exit.
 */
export async function runOpen(options: RunOpenOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo();
  const acquire = options.acquire ?? (() => acquireHub(resolveAccess(env)));
  const listRooms = options.listRooms ?? listHubRooms;
  const open = options.open ?? ((url: string) => openInBrowser(resolveOpenCommand(env), url));

  io.err("Waking the co-canvas hub…");
  // A wake that fails throws here and propagates: an unreachable hub is the one
  // failure `open` has, and the only thing that exits non-zero.
  const hub = await acquire();
  const rooms = await listRooms(hub.url);

  // Always, so a headless host still sees the address and the boards.
  io.out(hub.url);
  if (rooms.length === 0) {
    io.out("No rooms are open yet.");
  } else {
    for (const room of rooms) {
      io.out(`  ${room.slug} — ${boardUrl(hub.url, room.slug)} (${room.peers} connected)`);
    }
  }

  const target = resolveTarget(options.slug, hub.url, rooms, io);
  // An unknown slug: reported already, and nothing to open — but still exit 0,
  // since the hub was reached. Non-zero is reserved for not reaching it.
  if (target === undefined) return;

  const opened = await open(target);
  io.err(
    opened
      ? `Opened ${target} in your browser.`
      : `No browser could be launched on this host — open ${target} by hand.`,
  );
}

/**
 * The URL to open: the overview for no slug, the board for a slug the hub holds,
 * or `undefined` — after saying so — for a slug it does not.
 */
function resolveTarget(
  slug: string | undefined,
  hubUrl: string,
  rooms: readonly HubRoom[],
  io: OpenIo,
): string | undefined {
  if (slug === undefined) return hubUrl;
  if (rooms.some((room) => room.slug === slug)) return boardUrl(hubUrl, slug);
  io.err(
    `No room named "${slug}" is open — showing all rooms above instead of opening a dead board.`,
  );
  return undefined;
}

/** The real hub access, resolved from the environment the way `runBridge` does. */
function resolveAccess(env: NodeJS.ProcessEnv): HubAccess {
  const port = resolveHubPort(env);
  return {
    command: () => resolveHubCommand(env),
    ...(port === undefined ? {} : { port }),
  };
}

function defaultIo(): OpenIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}
