// Bun entry point, compiled by `scripts/build-binary.mjs` into the single-file
// executable — never bundled by tsdown and never typechecked by tsc, because it
// depends on Bun's runtime (`Bun.file`) and on `embedded-assets.ts`, generated
// at build time from the frontend. The Node build uses `src/main.ts` instead.
import { runHubCli, type StaticDefault } from "../src/cli.ts";
import { loadEmbeddedAssets } from "./embedded-assets.ts";

const defaultStatic: StaticDefault = { assets: await loadEmbeddedAssets() };
await runHubCli({ argv: process.argv.slice(2), env: process.env, defaultStatic });
