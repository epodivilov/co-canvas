/**
 * The bridge as a library: what the `co-canvas` dispatcher imports and tsdown
 * inlines. The package stays private and unpublished; only `co-canvas` ships,
 * and it carries this source bundled inside its own build.
 */

export { type OpenIo, type RunOpenOptions, runOpen } from "./open.ts";
export { runBridge } from "./run.ts";
export type { Bridge, BridgeOptions } from "./server.ts";
export { createBridge } from "./server.ts";
