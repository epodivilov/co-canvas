/** An executable plus the arguments it is always given. */
export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * Reads a command out of an environment variable.
 *
 * The documented form is a JSON array of the executable followed by its
 * arguments. A single string would need quoting rules to carry more than one
 * argument, and the only quoting rules on hand are a shell's — which is exactly
 * what neither of these commands may go through: the opener is handed a URL
 * that arrived from outside.
 *
 * Anything that is not a usable JSON array is taken as a bare executable path
 * with no arguments, so `CO_CANVAS_OPEN_CMD=/usr/bin/firefox` does the obvious
 * thing, and so does a path containing spaces.
 */
export function parseCommandSpec(value: string): CommandSpec {
  const parsed = tryParseJson(value);
  if (!Array.isArray(parsed)) return bare(value);

  const parts: string[] = [];
  for (const part of parsed) {
    // One non-string element means the value was never meant to be read this
    // way; guessing at a conversion would spawn something nobody asked for.
    if (typeof part !== "string") return bare(value);
    parts.push(part);
  }

  const [executable, ...args] = parts;
  if (executable === undefined || executable === "") return bare(value);
  return { executable, args };
}

function bare(value: string): CommandSpec {
  return { executable: value, args: [] };
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
