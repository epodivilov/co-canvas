import { isRoomSlug, ROOM_SLUG_PATTERN } from "@co-canvas/protocol";

/**
 * The rule, in words, for an error a person has to act on.
 *
 * Built from the shared pattern rather than restated, so a slug rule that moves
 * in `@co-canvas/protocol` cannot leave this message describing the old one.
 */
export const SLUG_RULE =
  `a room slug must match ${ROOM_SLUG_PATTERN.source}: lowercase letters, digits` +
  " and hyphens, starting with a letter or a digit, at most 64 characters";

/**
 * Refuses a slug before anything else happens.
 *
 * Every tool validates first, so a rejected slug never reaches the hub: no
 * room is created, no socket is opened and nothing is launched.
 */
export function assertRoomSlug(value: string): void {
  if (isRoomSlug(value)) return;
  throw new Error(`invalid room slug ${JSON.stringify(value)}: ${SLUG_RULE}`);
}
