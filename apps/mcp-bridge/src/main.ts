#!/usr/bin/env node
import { PROTOCOL_VERSION } from "@co-canvas/protocol";

// Tools and the headless Yjs client land in CC-15..CC-17. stdout belongs to the
// MCP stream, so anything human-facing goes to stderr.
process.stderr.write(`co-canvas mcp-bridge (protocol ${PROTOCOL_VERSION}): not implemented yet\n`);
process.exitCode = 1;
