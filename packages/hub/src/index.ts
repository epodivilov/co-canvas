import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@co-canvas/protocol";

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = "127.0.0.1";

export interface HubOptions {
  /** TCP port to bind. `0` asks the OS for a free one — read the real port from `url`. */
  port?: number;
  /** Directory holding room data. Created lazily by the persistence layer. */
  dataDir?: string;
}

export interface Hub {
  /** Starts listening and resolves with the base URL. Idempotent. */
  start(): Promise<string>;
  /** Stops listening. Idempotent. */
  stop(): Promise<void>;
  /** Base URL while running, `null` otherwise. */
  readonly url: string | null;
  /** Resolved data directory. */
  readonly dataDir: string;
}

function defaultDataDir(): string {
  return join(homedir(), ".co-canvas");
}

/**
 * Builds a hub instance. Nothing is bound, read or written until `start()` —
 * importing this module has no side effects, so tests can run a hub in-process
 * and the CLI stays a thin wrapper around it.
 */
export function createHub(options: HubOptions = {}): Hub {
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = options.dataDir ?? defaultDataDir();

  const server = createServer((request, response) => {
    // Lets hub-client tell our hub apart from whatever else grabbed the port.
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ service: "co-canvas-hub", protocol: PROTOCOL_VERSION }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  let url: string | null = null;

  async function start(): Promise<string> {
    if (url !== null) return url;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, DEFAULT_HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    if (address === null) throw new Error("hub started but reported no address");

    url = `http://${DEFAULT_HOST}:${address.port}`;
    return url;
  }

  async function stop(): Promise<void> {
    if (url === null) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    url = null;
  }

  return {
    start,
    stop,
    get url() {
      return url;
    },
    dataDir,
  };
}
