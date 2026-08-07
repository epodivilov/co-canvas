# co-canvas

## 0.2.0

### Minor Changes

- afc00d0: Give the agent machine-readable geometry: `describe_scene` now returns per-element geometry in `structuredContent`, and `add_elements`/`update_elements` return the final box of the elements they touched — so an agent can place elements without overlapping them.

### Patch Changes

- f65aa96: Report the real package version in the MCP `serverInfo` handshake instead of a hardcoded `0.0.0`, injected at build time from the package manifest so it tracks each release.
