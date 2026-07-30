import type { FindOrStartHubOptions, HubInfo } from "@co-canvas/hub-client";
import { findOrStartHub } from "@co-canvas/hub-client";
import { DEFAULT_PORT } from "@co-canvas/protocol";
import { z } from "zod";
import type { CommandSpec } from "./command.ts";
import { HUB_CMD_ENV, HUB_PORT_ENV } from "./env.ts";

/** Where the bridge looks for a hub, and what it runs when there is none. */
export interface HubAccess {
  /** Port to look on. Without it, the protocol's default. */
  readonly port?: number;
  /** Directory holding the hub lockfile and room data. Without it, `~/.co-canvas`. */
  readonly dataDir?: string;
  /** Resolves the command that starts a hub. See {@link resolveHubCommand}. */
  readonly command: () => CommandSpec;
}

/** A room as the hub reports it. */
export interface HubRoom {
  readonly slug: string;
  readonly peers: number;
}

/**
 * `/__rooms` carries more than the bridge reports — `docBytes` is a debugging
 * aid — so this reads the two fields it needs and ignores the rest, which is
 * also what keeps a hub that grows a field from breaking a tool call.
 */
const roomsPayload = z.object({
  rooms: z.array(z.object({ slug: z.string(), peers: z.number() })),
});

/**
 * Finds the hub, starting one if nothing answers.
 *
 * Done on every tool call rather than once at startup: the hub is an on-demand
 * singleton that any of its clients may have started or stopped since the last
 * one, and a bridge that cached an address would keep talking to a hub that is
 * no longer there.
 */
export async function acquireHub(access: HubAccess): Promise<HubInfo> {
  try {
    const options: FindOrStartHubOptions = {
      ...(access.port === undefined ? {} : { port: access.port }),
      ...(access.dataDir === undefined ? {} : { dataDir: access.dataDir }),
      ...commandOptions(access.command()),
    };
    return await findOrStartHub(options);
  } catch (error) {
    // Rethrown rather than propagated, so the message names the two knobs that
    // can fix it. `@co-canvas/hub-client` knows nothing about this process's
    // environment and should not be made to.
    throw new Error(unreachableHubMessage(error, access.port), { cause: error });
  }
}

/** Reads the hub's live room listing. */
export async function listHubRooms(hubUrl: string): Promise<HubRoom[]> {
  const response = await fetch(`${hubUrl}/__rooms`);
  if (!response.ok) {
    throw new Error(`the hub at ${hubUrl} answered ${response.status} for its room listing`);
  }
  return roomsPayload.parse(await response.json()).rooms;
}

function commandOptions(command: CommandSpec): Pick<FindOrStartHubOptions, "command" | "args"> {
  return { command: command.executable, args: command.args };
}

function unreachableHubMessage(error: unknown, port: number | undefined): string {
  const cause = error instanceof Error ? error.message : String(error);
  return (
    `no co-canvas hub is available on port ${port ?? DEFAULT_PORT}: ${cause}.` +
    ` Point the bridge at another port with ${HUB_PORT_ENV},` +
    ` or change how it starts one with ${HUB_CMD_ENV}` +
    " (a JSON array of the executable followed by its arguments)"
  );
}
