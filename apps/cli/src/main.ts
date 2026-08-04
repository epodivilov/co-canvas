#!/usr/bin/env node
/**
 * The `co-canvas` command: a thin subcommand dispatcher.
 *
 * `mcp` is the only functional subcommand this package needs — it runs the MCP
 * bridge over stdio, and that stream owns stdout. Everything this dispatcher
 * writes for a human therefore goes to stderr, except the help text, which is
 * the one thing a person asked for on stdout. The bridge loop is imported from
 * `@co-canvas/mcp-bridge` and inlined by tsdown, so the published package needs
 * no `@co-canvas/*` at runtime.
 */
// biome-ignore lint/correctness/useImportExtensions: a package specifier the tsdown alias and tsconfig paths map to the bridge source; an extension would defeat that mapping.
import { runBridge } from "@co-canvas/mcp-bridge";

const USAGE = `co-canvas — shared live whiteboard for AI agents and humans

Usage:
  co-canvas mcp        Run the MCP server over stdio, for an MCP client to spawn.
  co-canvas help       Show this help.

Register it with an MCP client, e.g.:
  claude mcp add co-canvas -- npx -y co-canvas mcp
`;

async function main(argv: readonly string[]): Promise<void> {
  const [subcommand] = argv;

  switch (subcommand) {
    case "mcp":
      // stdout is the MCP transport from here on; runBridge writes nothing else to it.
      await runBridge();
      return;

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;

    default:
      // No subcommand or an unknown one: usage to stderr, and a non-zero exit so
      // a client that misconfigured the command notices rather than hangs.
      process.stderr.write(
        subcommand === undefined
          ? `co-canvas: a subcommand is required.\n\n${USAGE}`
          : `co-canvas: unknown subcommand ${JSON.stringify(subcommand)}.\n\n${USAGE}`,
      );
      process.exitCode = 1;
      return;
  }
}

await main(process.argv.slice(2));
