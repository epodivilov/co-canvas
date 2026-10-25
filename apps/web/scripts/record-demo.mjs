/** Record the CC-37 demo with the built MCP bridge and a real browser canvas. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "@co-canvas/hub";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "@playwright/test";

const webDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoDir = resolve(webDir, "../..");
const outputDir = resolve(repoDir, ".github/assets");
const slug = "live-loop-demo";
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port assigned");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function waitForHttp(url, process) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error("Vite exited before serving the demo");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite has not opened its listener yet.
    }
    await pause(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function textOf(result) {
  return result.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n");
}

async function main() {
  const tempDir = await mkdtemp(resolve(tmpdir(), "co-canvas-demo-"));
  const hubPort = await freePort();
  // The hub permits only the repository's fixed Vite origin during development.
  const webPort = 5173;
  const hub = createHub({ port: hubPort, dataDir: resolve(tempDir, "boards") });
  let vite;
  let browser;
  let context;
  let client;

  try {
    const hubUrl = await hub.start();
    vite = spawn(
      "pnpm",
      ["exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
      {
        cwd: webDir,
        stdio: "inherit",
        env: { ...process.env, NODE_ENV: "development" },
      },
    );
    const webUrl = `http://127.0.0.1:${webPort}`;
    await waitForHttp(webUrl, vite);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(repoDir, "apps/mcp-bridge/dist/main.js")],
      env: {
        ...process.env,
        HOME: tempDir,
        CO_CANVAS_HUB_PORT: String(hubPort),
        CO_CANVAS_OPEN_CMD: JSON.stringify([resolve(tempDir, "no-browser-launch")]),
      },
      stderr: "inherit",
    });
    client = new Client({ name: "co-canvas-demo-recorder", version: "1.0.0" });
    await client.connect(transport);

    async function call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${textOf(result)}`);
      return result;
    }

    await call("create_room", { slug });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      recordVideo: { dir: tempDir, size: { width: 1440, height: 900 } },
    });
    const page = await context.newPage();
    await page.goto(`${webUrl}/room/${slug}?hub=${encodeURIComponent(hubUrl)}`);
    await page.waitForFunction(() => window.__coCanvas?.ready() === true);
    await page.locator(".excalidraw").waitFor();

    // A small call log makes the agent's real MCP actions legible alongside the canvas.
    await page.evaluate(() => {
      const panel = document.createElement("aside");
      panel.id = "demo-call-log";
      panel.style.cssText =
        "position:fixed;left:22px;top:105px;width:330px;min-height:430px;box-sizing:border-box;padding:22px;border-radius:18px;background:#171a23;color:#e9ecf5;font:15px/1.45 system-ui,sans-serif;box-shadow:0 16px 50px #0005;z-index:99999;pointer-events:none";
      panel.innerHTML =
        '<div style="color:#a9b7ff;font-size:12px;font-weight:700;letter-spacing:.14em">CO-CANVAS · LIVE</div><h2 style="font-size:22px;line-height:1.2;margin:12px 0 18px">One board, two editors</h2><div id="demo-call-log-entries"></div>';
      document.body.append(panel);
    });

    async function caption(author, message) {
      await page.evaluate(
        ({ author, message }) => {
          const target = document.querySelector("#demo-call-log-entries");
          const item = document.createElement("div");
          item.style.cssText =
            "margin:0 0 15px;padding:10px 12px;border-radius:10px;background:#ffffff12";
          const label = document.createElement("strong");
          label.style.cssText = `display:block;font-size:11px;letter-spacing:.1em;color:${author === "HUMAN" ? "#f6bd77" : "#a9b7ff"}`;
          label.textContent = author;
          const copy = document.createElement("span");
          copy.textContent = message;
          item.append(label, copy);
          target.append(item);
          while (target.children.length > 4) target.firstChild.remove();
        },
        { author, message },
      );
    }

    async function visibleCount(count) {
      await page.waitForFunction(
        (minimum) => window.__coCanvas?.elements().filter((el) => !el.isDeleted).length >= minimum,
        count,
      );
    }

    await caption("HUMAN", "Sketch a client → API → database flow.");
    await pause(1600);
    await caption("AGENT · create_room", "Opening a shared board…");
    await pause(800);

    const nodes = [
      { id: "client", x: 480, y: 360, label: "Client", fill: "#d0ebff", stroke: "#1971c2" },
      { id: "api", x: 790, y: 360, label: "API", fill: "#e5dbff", stroke: "#7048e8" },
      { id: "db", x: 1100, y: 360, label: "Database", fill: "#d3f9d8", stroke: "#2b8a3e" },
    ];
    for (const [index, node] of nodes.entries()) {
      await caption("AGENT · add_elements", `Draw ${node.label}`);
      await call("add_elements", {
        slug,
        elements: [
          {
            type: "rectangle",
            id: node.id,
            x: node.x,
            y: node.y,
            width: 190,
            height: 100,
            label: { text: node.label },
            backgroundColor: node.fill,
            strokeColor: node.stroke,
            fillStyle: "solid",
            roughness: 0,
          },
        ],
      });
      await visibleCount((index + 1) * 2);
      await pause(900);
    }
    await caption("AGENT · add_elements", "Connect the services");
    await call("add_elements", {
      slug,
      elements: [
        {
          type: "arrow",
          id: "client-api",
          start: { id: "client" },
          end: { id: "api" },
          strokeColor: "#495057",
          roughness: 0,
        },
        {
          type: "arrow",
          id: "api-db",
          start: { id: "api" },
          end: { id: "db" },
          strokeColor: "#495057",
          roughness: 0,
        },
      ],
    });
    await visibleCount(8);
    await pause(3400);

    await caption("HUMAN", "Move the API and select it for the agent.");
    await page.keyboard.press("v");
    await page.mouse.move(885, 405);
    await page.mouse.down();
    await page.mouse.move(885, 455, { steps: 12 });
    await page.mouse.move(885, 495, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(
      () => window.__coCanvas?.elements().find((el) => el.id === "api")?.y > 400,
    );
    await page.mouse.click(885, 495);
    await page.waitForFunction(() => window.__coCanvas?.selectedIds().includes("api"));
    await pause(3100);

    await caption("AGENT · get_selection", "Reading the selected shape…");
    const selection = await call("get_selection", { slug });
    if (!selection.structuredContent?.shapes?.some((shape) => shape.id === "api")) {
      throw new Error(
        `The MCP bridge did not read the human's API selection: ${textOf(selection)}`,
      );
    }
    await caption("AGENT · describe_scene", "The API moved. Add a cache beside it.");
    const scene = await call("describe_scene", { slug });
    if (!scene.structuredContent?.shapes?.some((shape) => shape.id === "api" && shape.y > 400)) {
      throw new Error("The MCP bridge did not read the human's moved API shape");
    }
    await pause(1000);
    await caption("AGENT · add_elements", "Draw Cache");
    await call("add_elements", {
      slug,
      elements: [
        {
          type: "rectangle",
          id: "cache",
          x: 1050,
          y: 650,
          width: 170,
          height: 90,
          label: { text: "Cache" },
          backgroundColor: "#fff3bf",
          strokeColor: "#e67700",
          fillStyle: "solid",
          roughness: 0,
        },
      ],
    });
    await visibleCount(10);
    await caption("AGENT · place_relative", "Put Cache below API");
    await call("place_relative", {
      slug,
      anchor: "api",
      target: "cache",
      direction: "below",
      gap: 75,
    });
    await page.waitForFunction(
      () => window.__coCanvas?.elements().find((el) => el.id === "cache")?.y > 600,
    );
    await caption("AGENT · add_elements", "Connect API to Cache");
    await call("add_elements", {
      slug,
      elements: [
        {
          type: "arrow",
          id: "api-cache",
          start: { id: "api" },
          end: { id: "cache" },
          strokeColor: "#e67700",
          roughness: 0,
        },
      ],
    });
    await visibleCount(11);
    await pause(1700);
    await page.mouse.click(1350, 780);
    await caption("AGENT", "Your edit is on the same board. Diagram updated.");
    await pause(3200);

    await mkdir(outputDir, { recursive: true });
    await context.close();
    context = null;
    await rename(await page.video().path(), resolve(outputDir, "live-loop.webm"));
    console.log(`Recorded ${resolve(outputDir, "live-loop.webm")}`);
  } finally {
    await client?.close();
    await context?.close();
    await browser?.close();
    if (vite !== undefined) {
      vite.kill("SIGTERM");
      await new Promise((resolveExit) => vite.once("exit", resolveExit));
    }
    await hub.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
