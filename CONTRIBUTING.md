# Contributing to co-canvas

Thanks for looking into contributing. This is a pnpm monorepo; here is how to get set up, make a
change, and open a pull request.

## Prerequisites

Node ≥ 22 and [pnpm](https://pnpm.io).

## Install

```bash
pnpm install    # install dependencies
```

## Build

```bash
pnpm build      # build the web app, MCP bridge, hub and CLI
```

## Test

```bash
pnpm check      # biome + typecheck + unit tests
pnpm test:e2e   # browser end-to-end tests
```

`pnpm check` is what CI runs: `biome check .`, `pnpm -r typecheck`, and `vitest run`. You can also
run each of those on its own — `pnpm lint`, `pnpm typecheck`, `pnpm test` — while iterating.
`pnpm test:e2e` drives the built frontend with Playwright and needs `pnpm build` to have run first.

## Opening a pull request

1. Branch off `main` and make your change.
2. Run `pnpm check` (and `pnpm test:e2e` if the change touches the web app or anything the e2e
   specs cover) before opening the PR.
3. If your change touches the published `co-canvas` package (`apps/cli`, or anything it bundles),
   add a changeset: `pnpm changeset`, pick a bump level, and write a summary. CI's changeset gate
   blocks a PR that changes `co-canvas` without one. If the change genuinely needs no release
   (docs, tests, chores), add an empty changeset instead: `pnpm changeset add --empty`.
4. Open the PR against `main`.

## License

By contributing, you agree that your contributions are licensed under this repository's MIT
license (see [LICENSE](./LICENSE)).
