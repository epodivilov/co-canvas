# co-canvas

## 0.4.0

### Minor Changes

- a66a65e: Add `route_arrow`: draws an orthogonal, single-elbow arrow between two bound shapes, working out the bend from their relative position so a bound arrow comes out clean without the agent guessing waypoints. It authors a new arrow or re-routes an existing bound one, keeps every segment axis-aligned, and clears its own two endpoint shapes.

### Patch Changes

- 0a0c843: Add npm metadata (`repository`, `homepage`, `bugs`, `keywords`, `engines.node`) so the published
  package page links back to `github.com/epodivilov/co-canvas` and is discoverable by keyword. Also
  adds a root `LICENSE` file and `CONTRIBUTING.md` ahead of making the repo public.
- 01f3cf8: Harden the local hub against a browser drive-by: the WebSocket sync upgrade now rejects a handshake whose `Origin` is present and not on the allowlist (the hub's own origin and the dev web origin), the board API reflects an allowed origin instead of `*`, and a new `SECURITY.md` documents the loopback trust model and how to report a vulnerability. Non-browser clients that send no `Origin` (the MCP bridge) keep connecting unchanged.

## 0.3.0

### Minor Changes

- 122b276: Add a `get_selection` tool so the agent can read the elements you've selected on the canvas — "look at what I selected" works without naming element ids.
- 245f55e: Add layout tools — `place_relative`, `align_elements`, `distribute_elements` — so the agent can position elements relative to each other without overlaps, using true rotated geometry.
- 3f45bfc: Support bent (multi-point) arrows: `add_elements` and `update_elements` accept an explicit `points` path, and bound arrows keep correct bindings through the bends.
- b9b4169: Add a `co-canvas open [slug]` command that wakes the hub and opens the room overview (or a specific board) in your browser, printing the URL and room list for headless use.

## 0.2.1

### Patch Changes

- bb8a30d: Clarify agent-facing tool descriptions and harden the build. Draw responses now spell out that only the box (x/y/width/height) matches what `describe_scene` reports; `delete_elements` documents that its `shapes` is always empty; `describe_scene`'s structured `shapes` are matched by id rather than position. The CLI build now fails loudly if the package manifest has no `version` to bake into the MCP `serverInfo` handshake.

## 0.2.0

### Minor Changes

- afc00d0: Give the agent machine-readable geometry: `describe_scene` now returns per-element geometry in `structuredContent`, and `add_elements`/`update_elements` return the final box of the elements they touched — so an agent can place elements without overlapping them.

### Patch Changes

- f65aa96: Report the real package version in the MCP `serverInfo` handshake instead of a hardcoded `0.0.0`, injected at build time from the package manifest so it tracks each release.
