#!/usr/bin/env node
/**
 * Stands in for `xdg-open`: records the arguments it was handed — the URL being
 * the last of them — as one JSON line in the file named by
 * `CO_CANVAS_TEST_OPENER_LOG`.
 *
 * It reports through a file rather than through stdout because the bridge
 * spawns openers with `stdio: "ignore"`. Anything printed here would go
 * nowhere, and anything printed on an inherited stdout would corrupt the MCP
 * stream — which is the property the stdout-writing sibling fixture exists to
 * check.
 */
import { appendFileSync } from "node:fs";

const log = process.env.CO_CANVAS_TEST_OPENER_LOG;
if (log === undefined || log === "") {
  process.exitCode = 1;
} else {
  appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`);
}
