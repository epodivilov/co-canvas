import { describe, expect, it } from "vitest";
import { parseCommandSpec } from "./command.ts";

describe("parseCommandSpec", () => {
  it("reads a JSON array as the executable followed by its arguments", () => {
    expect(parseCommandSpec('["/usr/bin/node", "server.js", "--quiet"]')).toEqual({
      executable: "/usr/bin/node",
      args: ["server.js", "--quiet"],
    });
  });

  it("reads a single-element array as an executable with no arguments", () => {
    expect(parseCommandSpec('["xdg-open"]')).toEqual({ executable: "xdg-open", args: [] });
  });

  it("takes anything that is not a JSON array as a bare executable path", () => {
    expect(parseCommandSpec("/usr/bin/firefox")).toEqual({
      executable: "/usr/bin/firefox",
      args: [],
    });
    // A path with spaces stays one path: there is no shell here to split it.
    expect(parseCommandSpec("/opt/My Browser/open")).toEqual({
      executable: "/opt/My Browser/open",
      args: [],
    });
    expect(parseCommandSpec('{"executable":"open"}')).toEqual({
      executable: '{"executable":"open"}',
      args: [],
    });
  });

  it("falls back to the bare reading for an array it cannot use", () => {
    expect(parseCommandSpec("[]")).toEqual({ executable: "[]", args: [] });
    expect(parseCommandSpec('["", "--flag"]')).toEqual({ executable: '["", "--flag"]', args: [] });
    expect(parseCommandSpec('["open", 7]')).toEqual({ executable: '["open", 7]', args: [] });
  });
});
