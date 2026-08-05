// Stages the hub's Node build — `main.js` plus the frontend `copy-web.mjs` put
// beside it — into this package's `dist/hub`, so the bridge can spawn a hub from
// a package-relative path (`dist/hub/main.js`) with no workspace on disk. Runs
// after `tsdown` (which cleans `dist`), and after the hub build, which the root
// `build` and this package's `prepublishOnly` both sequence ahead of it.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const hubDist = join(cliDir, "..", "hub-cli", "dist");
const target = join(cliDir, "dist", "hub");

if (!existsSync(join(hubDist, "main.js")) || !existsSync(join(hubDist, "web", "index.html"))) {
  process.stderr.write(
    `co-canvas package build: no built hub at ${hubDist} (expected main.js and web/index.html).\n` +
      "Build the hub first — `pnpm build` from the repo root does this in order.\n",
  );
  process.exit(1);
}

cpSync(hubDist, target, { recursive: true });
process.stdout.write(`co-canvas: staged hub from ${hubDist} into ${target}\n`);
