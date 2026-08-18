# Security

co-canvas runs entirely on your machine. The hub — the process that holds your
boards and relays live edits — binds loopback only (`127.0.0.1:4321`) and never
listens on a routable interface. Your boards live under `~/.co-canvas`. Nothing
leaves the machine.

## Trust model

The hub trusts the machine it runs on. Any process running as your user can
reach loopback, and the hub treats every local caller as you: there is no login,
no per-board password, and no per-room authorization. This is deliberate — for a
single-user tool that draws on a local canvas, a shared token or account system
would be weight without a matching threat. The boundary co-canvas defends is the
one between **your machine** and **the rest of the network**, not one between
processes on your machine.

Concretely, on the machine that runs the hub:

- Any local process can open, read and write any board over the sync channel.
- Any local process can list live boards (`GET /__rooms` reports the rooms the
  hub currently holds, with their slugs) and list persisted boards
  (`GET /api/boards`). Board slugs are human-typeable and guessable; they are not
  a secret and are not treated as one.

If you do not trust the code running on your machine, co-canvas is not the layer
that protects you from it.

## What the network boundary defends against

A browser can reach `127.0.0.1` even though it is loopback. So a web page you
visit — on any site — could try to script a connection to your hub in the
background. Two measures close that browser drive-by:

- **Origin check on the WebSocket sync upgrade.** The sync channel
  (`/sync/{slug}`) has no per-room auth, so an unguarded upgrade would give any
  web page full read+write of a board it names. The hub refuses a WebSocket
  handshake whose `Origin` is present and not on its allowlist. The allowlist is
  the hub's own origin (the production UI, which the hub serves itself) and the
  local dev web origin (Vite). The hub's own origin is pinned to its loopback
  bind — `127.0.0.1` or `localhost` on the port the hub actually bound — never
  reconstructed from the request's `Host` header, so a page cannot talk the hub
  into treating a foreign origin as same-origin (see DNS rebinding below). A
  request with no `Origin` header is allowed, because that is how a non-browser
  client connects (the MCP bridge, or any other local tool) and a hostile web
  page cannot suppress the header a browser adds.
- **Narrowed CORS on the board API.** The board API (`/api/boards`) reflects an
  allowed request origin only; it never answers `Access-Control-Allow-Origin: *`.
  A page on an untrusted origin therefore cannot read the board list or drive the
  create / rename / archive operations from the browser. (Note: CORS governs the
  browser fetch API, not WebSockets — the Origin check above is the load-bearing
  fix for the sync channel.)

`GET /__rooms` and `GET /health` send no CORS headers, so a browser on another
origin cannot read their responses. They remain readable by any local process,
which is the local-trust property described above, not a browser-reachable leak.

## Residual risk

- No per-room authentication or authorization. Every board on the hub is
  reachable by every local process, and slugs are guessable.
- The measures above stop a **browser** on an untrusted origin. They do not stop
  a native process running on the same machine — that is outside the trust
  boundary by design.

DNS rebinding against the sync or board origin is **defended, not residual**.
Same-origin is pinned to the hub's own loopback bind (`127.0.0.1` / `localhost`
on the bound port), never to the request's `Host`. A page served from
`http://attacker.example:PORT` that rebinds `attacker.example` to `127.0.0.1`
still carries a foreign `Origin`, which matches neither loopback literal — so
both the WebSocket upgrade and the board-API CORS reflection refuse it.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub's private vulnerability reporting on this repository
(<https://github.com/epodivilov/co-canvas/security/advisories/new>), or by
contacting the maintainer. We will acknowledge the report and work with you on a
fix and a coordinated disclosure.
