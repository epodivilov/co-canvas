---
"co-canvas": patch
---

Clarify agent-facing tool descriptions and harden the build. Draw responses now spell out that only the box (x/y/width/height) matches what `describe_scene` reports; `delete_elements` documents that its `shapes` is always empty; `describe_scene`'s structured `shapes` are matched by id rather than position. The CLI build now fails loudly if the package manifest has no `version` to bake into the MCP `serverInfo` handshake.
