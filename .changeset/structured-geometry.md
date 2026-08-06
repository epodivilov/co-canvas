---
"co-canvas": minor
---

Give the agent machine-readable geometry: `describe_scene` now returns per-element geometry in `structuredContent`, and `add_elements`/`update_elements` return the final box of the elements they touched — so an agent can place elements without overlapping them.
