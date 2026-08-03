import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Answers a request from the static directory.
 * Returns `false` when the path maps to nothing servable, leaving the caller
 * to produce its own 404.
 */
export type StaticHandler = (pathname: string, response: ServerResponse) => Promise<boolean>;

const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

/**
 * Where a static handler reads its bytes from.
 *
 * The path handed in is a relative POSIX path with no leading slash, already
 * stripped of `.` and `..` by the handler: a source only has to map it to bytes
 * or report that it holds nothing there. Two sources exist because the frontend
 * reaches the hub two ways — a directory on disk for the Node build output, and
 * an in-memory map for the single-file `bun --compile` binary, which has no
 * directory to read from.
 */
export interface AssetSource {
  read(path: string): Promise<Uint8Array | null>;
}

/** Reads assets from a directory on disk, refusing anything outside it. */
export function createDirectoryAssetSource(directory: string): AssetSource {
  const root = resolve(directory);
  return {
    async read(path) {
      const file = join(root, ...path.split("/"));
      // Belt-and-suspenders: the handler already rejects `..` before this, but
      // a source that reads the filesystem checks containment itself.
      if (!isInside(root, file)) return null;
      return await readIfFile(file);
    },
  };
}

/**
 * Reads assets from a map held in memory — the shape the compiled binary
 * carries its frontend in, keyed by the same relative POSIX path a directory
 * source is asked for.
 */
export function createEmbeddedAssetSource(assets: ReadonlyMap<string, Uint8Array>): AssetSource {
  return {
    async read(path) {
      return assets.get(path) ?? null;
    },
  };
}

/**
 * Serves a prebuilt single-page frontend out of `source`.
 *
 * Nothing outside the source is reachable, and the SPA fallback is limited to
 * extension-less paths so a broken asset URL stays a 404 instead of silently
 * turning into HTML that fails later as a parse error.
 */
export function createStaticHandler(source: AssetSource): StaticHandler {
  return async (pathname, response) => {
    const segments = safeSegments(pathname);
    if (segments === null) return false;

    if (segments.length > 0) {
      const relative = segments.join("/");
      const body = await source.read(relative);
      if (body !== null) {
        respondWithFile(response, contentTypeOf(relative), body);
        return true;
      }

      const last = segments.at(-1);
      if (last !== undefined && extname(last) !== "") return false;
    }

    const index = await source.read("index.html");
    if (index === null) return false;
    respondWithFile(response, "text/html; charset=utf-8", index);
    return true;
  };
}

/**
 * Splits a request path into path segments, or `null` when it tries to escape.
 *
 * The path is percent-decoded first, so a separator smuggled in as `%2f` is
 * seen. `.` and `..` are rejected outright rather than normalised away: a
 * normalised traversal turns into a plausible-looking path that the SPA
 * fallback would answer with 200, which hides the attempt instead of refusing
 * it.
 */
function safeSegments(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function readIfFile(file: string): Promise<Uint8Array | null> {
  try {
    return await readFile(file);
  } catch {
    // ENOENT for a missing path, EISDIR for a directory — both mean "no file".
    return null;
  }
}

function respondWithFile(response: ServerResponse, contentType: string, body: Uint8Array): void {
  response.writeHead(200, { "content-type": contentType, "content-length": body.byteLength });
  response.end(body);
}

function contentTypeOf(file: string): string {
  return CONTENT_TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream";
}
