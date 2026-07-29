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
 * Serves a prebuilt single-page frontend out of `directory`.
 *
 * Nothing outside `directory` is reachable, and the SPA fallback is limited to
 * extension-less paths so a broken asset URL stays a 404 instead of silently
 * turning into HTML that fails later as a parse error.
 */
export function createStaticHandler(directory: string): StaticHandler {
  const root = resolve(directory);

  return async (pathname, response) => {
    const segments = safeSegments(pathname);
    if (segments === null) return false;

    if (segments.length > 0) {
      const file = join(root, ...segments);
      if (!isInside(root, file)) return false;

      const body = await readIfFile(file);
      if (body !== null) {
        respondWithFile(response, contentTypeOf(file), body);
        return true;
      }

      const last = segments.at(-1);
      if (last !== undefined && extname(last) !== "") return false;
    }

    const index = await readIfFile(join(root, "index.html"));
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

async function readIfFile(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    // ENOENT for a missing path, EISDIR for a directory — both mean "no file".
    return null;
  }
}

function respondWithFile(response: ServerResponse, contentType: string, body: Buffer): void {
  response.writeHead(200, { "content-type": contentType, "content-length": body.byteLength });
  response.end(body);
}

function contentTypeOf(file: string): string {
  return CONTENT_TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream";
}
