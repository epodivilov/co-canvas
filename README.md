# co-canvas

https://github.com/user-attachments/assets/1b327d1e-cb6c-4046-8974-fd381b86d39a

A live whiteboard your AI agent and you share — the agent draws, you edit, both on the same board, running on your machine.

co-canvas is an MCP server that hands an AI agent a real Excalidraw board. The agent opens a board, it shows up in your browser; the agent draws on it and you edit it by hand, and every change lands on both sides at once. Nothing leaves your machine — the hub and your boards run locally under `~/.co-canvas`.

## Install

Requires Node ≥ 22.

**Claude Code** — one command:

```bash
claude mcp add co-canvas -- npx -y co-canvas mcp
```

**Cursor** (or any MCP client) — add a stdio server to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "co-canvas": {
      "command": "npx",
      "args": ["-y", "co-canvas", "mcp"]
    }
  }
}
```

## How to use

Ask your agent to open a board, then work on it together:

1. The agent calls `create_room` (or `open_room` for an existing one) and a browser opens on the board. The `/` overview lists every board; each one lives at `/room/<slug>`.
2. The agent draws with `add_elements`, `update_elements` and `delete_elements` — everything it draws appears in your browser live, no reload.
3. You edit the board by hand: move things, redraw, annotate.
4. The agent calls `describe_scene` to read the board back — including your edits — and keeps going. (`list_rooms` shows what boards are already open.)

## Development

This repo is a pnpm monorepo.

```bash
pnpm install    # install dependencies
pnpm build      # build the web app, MCP bridge, hub and CLI
pnpm check      # biome + typecheck + unit tests
pnpm test:e2e   # browser end-to-end tests
```

## License

MIT © Evgenii Podivilov
