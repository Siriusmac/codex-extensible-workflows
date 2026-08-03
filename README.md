# Codex Extensible Workflows

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Proof-of-concept Codex adaptation of
[vekexasia/pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows).

It preserves the central authoring style:

```js
const reviews = await parallel("review", {
  correctness: () => agent("Review correctness."),
  security: () => agent("Review security."),
  tests: () => agent("Review test coverage."),
});

return agent(prompt("Prioritize:\n{reviews}", { reviews }));
```

The plugin exposes five local MCP tools:

- `workflow_run`: launch an inline script or a reviewed `scriptPath`; progress
  reporting is disabled by default.
- `workflow_status`: inspect persisted state and an agent progress summary.
- `workflow_events`: read events incrementally from a cursor, with an optional
  wait of up to 30 seconds for the next update.
- `workflow_wait`: wait up to 55 seconds for only the terminal state, without
  returning progress events.
- `workflow_resume`: rerun the script while reusing completed agent calls; it
  also supports background mode.

Each `agent(...)` is a non-interactive `codex exec --json` session. Runs are
stored under `<cwd>/.codex/workflow-runs/<runId>/`.

The server prepends the directory of the Node executable that launched the
plugin to every child agent's `PATH`. This makes project commands such as
`pnpm test`, `pnpm lint`, and `pnpm run build` work when Codex uses its bundled
Node runtime and the system shell does not provide `node` globally.

## Live progress

Long workflows should use background execution plus `workflow_wait`. A single
foreground MCP call is subject to the host's 300-second timeout, while a
workflow may legitimately take longer. Background mode therefore defaults to
true. Call `workflow_wait` with `waitMs: 50000` until it returns
`terminal: true`; do not narrate non-terminal waits. This is terminal waiting,
not progress reporting, and its response stays deliberately compact.

Live progress is opt-in because each update consumes conversation tokens. Do
not poll status or events unless the user explicitly asks for progress updates.
After such a request, start the workflow with both `background: true` and
`progressUpdates: true`. Then call `workflow_events` with `cursor: 0`. Keep the
returned `nextCursor` and use it in the next call with `waitMs: 30000`.

Background execution by itself does not enable progress events. A run without
`progressUpdates: true` still persists events locally for recovery, but
`workflow_events` will refuse to return them. Use `workflow_status` only for a
requested snapshot, recovery, or the final result—not for periodic polling.

Agent events include a readable label. Parallel tasks automatically use their
task name; a direct agent can set one explicitly:

```js
return agent("Review privacy boundaries.", { label: "Privacy review" });
```

The event stream reports operational state and final outcomes. It does not
expose hidden model reasoning.

## Requirements

- Codex CLI available as `codex`, or its path supplied through `CODEX_BIN`.
- Node.js 22 or newer.
- A writable project directory.

## Local validation

```sh
npm test
```

## Differences from the Pi project

The upstream project is tightly integrated with Pi's extension API, session
manager, model registry, TUI, and in-process agent runtime. This adaptation uses
a Codex plugin plus MCP server and launches Codex agents through the supported
non-interactive CLI surface.

Version 0.1 includes the workflow DSL core, bounded concurrency, structured
agent output, persistent operation results, background execution, compact
terminal waiting, opt-in progress events, status, and resume. It does not yet
include interactive checkpoints, the navigator UI, registered extension
functions, aggregate budgets, named worktrees, or live steering.

The upstream repository is MIT licensed. See [NOTICE.md](NOTICE.md) for
attribution. This proof of concept is an independent adapter and is not an
official upstream release or an OpenAI product.
