# co-canvas

## 0.2.1

### Patch Changes

- bb8a30d: Clarify agent-facing tool descriptions and harden the build. Draw responses now spell out that only the box (x/y/width/height) matches what `describe_scene` reports; `delete_elements` documents that its `shapes` is always empty; `describe_scene`'s structured `shapes` are matched by id rather than position. The CLI build now fails loudly if the package manifest has no `version` to bake into the MCP `serverInfo` handshake.

## 0.2.0

### Minor Changes

- afc00d0: Give the agent machine-readable geometry: `describe_scene` now returns per-element geometry in `structuredContent`, and `add_elements`/`update_elements` return the final box of the elements they touched — so an agent can place elements without overlapping them.

### Patch Changes

- f65aa96: Report the real package version in the MCP `serverInfo` handshake instead of a hardcoded `0.0.0`, injected at build time from the package manifest so it tracks each release.
