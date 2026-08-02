import { defaultDataDir } from "@co-canvas/hub-client";
import { DEFAULT_PORT } from "@co-canvas/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MS, HELP_TEXT, parseOptions } from "./options.ts";

/** Every case runs against an explicit environment, never the real one. */
function parse(argv: string[], env: NodeJS.ProcessEnv = {}) {
  return parseOptions(argv, env);
}

describe("option parsing", () => {
  it("falls back to the protocol defaults with no options and no environment (R1)", () => {
    const result = parse([]);
    expect(result).toEqual({
      kind: "options",
      options: {
        port: DEFAULT_PORT,
        dataDir: defaultDataDir(),
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        staticDir: undefined,
      },
    });
  });

  it("reads the port and data directory from the environment (R1)", () => {
    const result = parse([], { CO_CANVAS_PORT: "5000", CO_CANVAS_DATA_DIR: "/tmp/env-dir" });
    expect(result).toMatchObject({
      kind: "options",
      options: { port: 5000, dataDir: "/tmp/env-dir" },
    });
  });

  it("lets the option win over the matching environment variable (R1)", () => {
    const result = parse(["--port", "6000", "--data-dir", "/tmp/opt-dir"], {
      CO_CANVAS_PORT: "5000",
      CO_CANVAS_DATA_DIR: "/tmp/env-dir",
    });
    expect(result).toMatchObject({
      kind: "options",
      options: { port: 6000, dataDir: "/tmp/opt-dir" },
    });
  });

  it("accepts the `--opt=value` form as well as `--opt value` (R1)", () => {
    expect(parse(["--port=6001"])).toMatchObject({ kind: "options", options: { port: 6001 } });
  });

  it("refuses a port that is not a number, naming --port (R1)", () => {
    const result = parse(["--port", "not-a-number"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--port");
  });

  it("refuses a port read from the environment that is not a number, naming the variable (R1)", () => {
    const result = parse([], { CO_CANVAS_PORT: "nonsense" });
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("CO_CANVAS_PORT");
  });

  it("treats a blank environment value as unset (R1)", () => {
    const result = parse([], { CO_CANVAS_PORT: "", CO_CANVAS_DATA_DIR: "" });
    expect(result).toMatchObject({
      kind: "options",
      options: { port: DEFAULT_PORT, dataDir: defaultDataDir() },
    });
  });

  it("defaults the idle timeout to thirty minutes (R4)", () => {
    const result = parse([]);
    expect(result.kind === "options" && result.options.idleTimeoutMs).toBe(30 * 60 * 1000);
  });

  it("accepts an idle timeout of zero to disable idle shutdown (R4)", () => {
    expect(parse(["--idle-timeout", "0"])).toMatchObject({
      kind: "options",
      options: { idleTimeoutMs: 0 },
    });
  });

  it("refuses a negative or non-integer idle timeout, naming --idle-timeout (R4)", () => {
    for (const bad of ["-1", "1.5", "soon"]) {
      const result = parse(["--idle-timeout", bad]);
      expect(result.kind).toBe("error");
      expect(result.kind === "error" && result.message).toContain("--idle-timeout");
    }
  });

  it("asks for help on --help and -h (R1)", () => {
    expect(parse(["--help"])).toEqual({ kind: "help" });
    expect(parse(["-h"])).toEqual({ kind: "help" });
  });

  it("names every option in the help text (R1)", () => {
    for (const option of ["--port", "--data-dir", "--idle-timeout", "--static", "--help"]) {
      expect(HELP_TEXT).toContain(option);
    }
  });

  it("refuses an unknown option, naming it (R1)", () => {
    const result = parse(["--frobnicate"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--frobnicate");
  });

  it("refuses a value option given no value (R1)", () => {
    const result = parse(["--port"]);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--port");
  });
});
