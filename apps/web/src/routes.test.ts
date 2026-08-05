import { describe, expect, it } from "vitest";
import { parseRoute } from "./routes.ts";

describe("parseRoute", () => {
  it("routes /room/{slug} to the room canvas", () => {
    expect(parseRoute("/room/auth-redesign")).toEqual({ kind: "room", slug: "auth-redesign" });
  });

  it("does not match a room without a slug", () => {
    expect(parseRoute("/room/")).toEqual({ kind: "overview" });
  });

  it("does not match the bare /room path", () => {
    expect(parseRoute("/room")).toEqual({ kind: "overview" });
  });

  it("routes the root and unknown paths to the overview", () => {
    expect(parseRoute("/")).toEqual({ kind: "overview" });
    expect(parseRoute("/board/alpha")).toEqual({ kind: "overview" });
    expect(parseRoute("/roomy/alpha")).toEqual({ kind: "overview" });
  });

  it("hands a slug the hub would refuse straight through", () => {
    // The hub is the single authority on what a room may be called. Rejecting
    // this here would make the hub's 1008 close path unreachable.
    expect(parseRoute("/room/Not_A_Slug")).toEqual({ kind: "room", slug: "Not_A_Slug" });
  });

  it("keeps everything after the prefix in the slug", () => {
    expect(parseRoute("/room/alpha/beta")).toEqual({ kind: "room", slug: "alpha/beta" });
  });
});
