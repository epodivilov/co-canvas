#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHubCli, type StaticDefault } from "./cli.ts";

// The Node build output ships the frontend as a directory beside `main.js`:
// `tsdown` emits `dist/main.js`, and the build copies the `apps/web` build into
// `dist/web`. Running from source instead (`node --experimental-strip-types
// src/main.ts`) has no such sibling, so the hub serves no frontend and the Vite
// dev server does — which is the intended split during development.
const here = dirname(fileURLToPath(import.meta.url));
const bundledWeb = join(here, "web");
const defaultStatic: StaticDefault = existsSync(join(bundledWeb, "index.html"))
  ? { dir: bundledWeb }
  : {};

await runHubCli({ argv: process.argv.slice(2), env: process.env, defaultStatic });
