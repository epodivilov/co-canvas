// Copies the built frontend next to the Node build output, so a hub started
// from `dist/main.js` serves the frontend it ships with. The workspace builds
// hub-cli before web by default, so `pnpm build` at the repo root sequences the
// two explicitly and this runs once `apps/web/dist` exists.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubCliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDist = join(hubCliDir, "..", "web", "dist");
const target = join(hubCliDir, "dist", "web");

if (!existsSync(join(webDist, "index.html"))) {
  process.stderr.write(
    `co-canvas hub-cli build: no frontend at ${webDist}.\n` +
      "Build the frontend first — `pnpm build` from the repo root does this in order.\n",
  );
  process.exit(1);
}

cpSync(webDist, target, { recursive: true });
process.stdout.write(`co-canvas hub-cli: bundled frontend from ${webDist} into ${target}\n`);
