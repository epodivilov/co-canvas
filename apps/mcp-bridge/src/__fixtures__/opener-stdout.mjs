#!/usr/bin/env node
/**
 * An opener that chatters on its own stdout, the way `xdg-open` does.
 *
 * Spawned with `stdio: "ignore"` none of this reaches anybody. Spawned with
 * inherited stdio every byte of it lands in the middle of the MCP stream and
 * the next response fails to parse.
 */
process.stdout.write(`opening ${process.argv.at(-1)}\n`);
process.stdout.write("this line has no business on the MCP stream\n");
