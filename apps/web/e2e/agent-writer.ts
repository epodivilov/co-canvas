import { generateKeyBetween } from "fractional-indexing";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

/**
 * A Yjs client with no browser attached — the shape the MCP bridge will take in
 * CC-15. It exists here only as a test fixture: R6 is about browsers rendering
 * what a non-browser client writes, and nothing else may pretend to be one.
 */
export interface AgentRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A complete Excalidraw rectangle. Built field by field rather than cloned from
 * a browser's scene, because the bridge this stands in for will not have a
 * browser to clone from either.
 */
function excalidrawRectangle(rectangle: AgentRectangle): Record<string, unknown> {
  return {
    id: rectangle.id,
    type: "rectangle",
    x: rectangle.x,
    y: rectangle.y,
    width: rectangle.width,
    height: rectangle.height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: 1_337,
    version: 1,
    versionNonce: 1_337,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function toWebSocketUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${url.origin}/sync`;
}

/** Appends one element to a room's document and waits for the hub to take it. */
export async function writeElementAsAgent(options: {
  hubUrl: string;
  slug: string;
  rectangle: AgentRectangle;
}): Promise<void> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(toWebSocketUrl(options.hubUrl), options.slug, doc, {
    WebSocketPolyfill: WebSocket,
  });
  const yElements = doc.getArray<Y.Map<unknown>>("elements");

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("agent client: sync timed out")), 15_000);
      provider.once("sync", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // The fractional key, not the array position, is what decides z-order, so a
    // new element has to name a key after the last one already in the room.
    const tail = yElements.toArray().at(-1)?.get("pos");
    const pos = generateKeyBetween(typeof tail === "string" ? tail : null, null);

    doc.transact(() => {
      const entry = new Y.Map<unknown>();
      entry.set("pos", pos);
      entry.set("el", excalidrawRectangle(options.rectangle));
      yElements.push([entry]);
    });

    // `destroy()` closes the socket outright, so the update needs a moment on
    // the wire before this client walks away.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    provider.destroy();
    doc.destroy();
  }
}
