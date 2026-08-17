---
"co-canvas": minor
---

Add `route_arrow`: draws an orthogonal, single-elbow arrow between two bound shapes, working out the bend from their relative position so a bound arrow comes out clean without the agent guessing waypoints. It authors a new arrow or re-routes an existing bound one, keeps every segment axis-aligned, and clears its own two endpoint shapes.
