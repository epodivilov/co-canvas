---
"co-canvas": patch
---

Harden the local hub against a browser drive-by: the WebSocket sync upgrade now rejects a handshake whose `Origin` is present and not on the allowlist (the hub's own origin and the dev web origin), the board API reflects an allowed origin instead of `*`, and a new `SECURITY.md` documents the loopback trust model and how to report a vulnerability. Non-browser clients that send no `Origin` (the MCP bridge) keep connecting unchanged.
