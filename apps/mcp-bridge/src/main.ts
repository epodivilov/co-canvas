#!/usr/bin/env node
import { runBridge } from "./run.ts";

// stdout belongs to the MCP stream; the loop itself lives in `run.ts` so the
// `co-canvas` dispatcher can drive it for its `mcp` subcommand.
await runBridge();
