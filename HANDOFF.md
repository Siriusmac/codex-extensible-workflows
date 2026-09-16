# Codex Extensible Workflows handoff

## Checkpoint

- Date: 2026-09-16
- Source version: `0.4.0`
- Branch: `main`
- Repository: https://github.com/Siriusmac/codex-extensible-workflows
- Intended visibility: public
- License: MIT
- Runtime: Node.js 22.19 or newer

This checkpoint updates the public independent Codex adaptation through the
Codex-compatible portions of upstream `v5.14.0`, while preserving the guided
workflow wizard and the explicit Pi/Codex boundary.

## Upstream dependency and attribution

This project adapts Andrea "vekexasia" Baccega's
[pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows).
The comparison used for this checkpoint is upstream `v5.14.0` commit
`0292536c0c106feb006ba622168cf0fb44c686f2`, reviewed on 2026-09-16.

The dependency is architectural and conceptual, not a runtime npm dependency.
The workflow DSL, deterministic operation structure, parallel and pipeline
composition, persisted results, resumability, background execution, and
recovery direction originate in the upstream project. Codex-specific execution
is implemented locally through MCP and `codex exec --json`.

The upstream project declares the MIT License. This repository uses the same
license type and includes explicit attribution in `README.md` and `NOTICE.md`.

## Implemented Codex surface

- Local stdio MCP server exposed through a Codex plugin manifest.
- Trusted scripted workflows with `agent`, `parallel`, `pipeline`, `prompt`,
  and `log`.
- Declarative `workflow_run_guided` workflows without JavaScript authoring.
- Conversational `codex-workflow-wizard` skill.
- Per-subagent and synthesis-agent model selection.
- Per-agent sandbox, approval policy, reasoning effort, output schema, retry,
  timeout, and progress label.
- Persistent named multi-turn agents implemented with
  `agent.create({ name, ... }).send(...)` and Codex session resume.
- Bounded concurrency and deterministic persisted operation keys.
- FIFO admission in JavaScript call order when concurrency is bounded.
- Background execution, compact terminal waiting, status, optional event
  cursors, resume, and lineage-preserving retry.
- Explicit `workflow_stop` for active local runs, including child-process
  termination and durable stopped state.
- Best-effort terminal-run retention.
- Codex bundled Node runtime propagation for child package-manager commands.

## Codex-specific additions beyond upstream

- Codex plugin packaging and an MCP tool interface.
- Separate non-interactive Codex child sessions instead of Pi's in-process
  transport.
- A guided declarative launcher and conversational setup wizard.
- Explicit consent for narrated progress to control conversation-token usage.
- Compact 50-second terminal waits designed around the MCP host timeout.
- Codex CLI model, sandbox, approval, reasoning, and schema mapping.
- Codex CLI session resume for persistent handle turns.
- `CODEX_BIN` and `CODEX_WORKFLOWS_NODE` runtime overrides.

## Pi-specific capabilities intentionally not implemented

The following upstream features depend on Pi host APIs or do not yet have a
stable, equivalent Codex surface. They were not replaced with partial or
misleading simulations:

- Pi TUI commands, navigator, startup picker, background widget, inline
  confirmations, pending-pause cancellation, and interactive checkpoints.
- Trajectory browser UI, Gantt, transcript inspection, publisher lifecycle,
  and live actions.
- Herdr panes and live Pi-session handoff.
- Pi roles, model aliases, resource selectors, context-file policies, setup
  hooks, extension registries, and namespaced extension settings.
- Registered workflow functions and catalog invocation.
- Pi-owned named worktrees and worktree lifecycle actions.
- Aggregate token/cost budgets and provider-specific accounting or recovery
  dialogs.
- Durable standalone subagent tools, live steering, stopping, retry controls,
  and the `/subagents` TUI.
- The `piewf` CLI, `piewf doctor`, portable workflow bundles, and Pi
  package/release integration.

## Persistence and compatibility

Runs are stored under `<cwd>/.codex/workflow-runs/<runId>/`. Completed operation
keys remain reusable across resume and retry. Existing version `0.1` persisted
runs remain readable; versions `0.2` through `0.4` add fields and new operation
key families without renaming the original operation keys. Persistent handle
turns use `agent/handle/<name>/turn:<n>` and store the Codex thread ID needed by
the next turn.

Progress events are persisted, but MCP progress delivery remains disabled
unless `progressUpdates: true` was explicitly selected. Background execution
alone is never treated as progress consent.

## Validation baseline

The release handoff requires all of the following to pass:

- `node --test`
- `node --check server.mjs`
- Skill validation for both bundled skills
- Plugin manifest validation
- MCP initialize and `tools/list` smoke test
- `git diff --check`
- tracked-file secrets and temporary-artifact review

The current suite contains 15 tests covering persistence, parallel execution,
resume, quiet and narrated background runs, Node runtime propagation, prompt
validation, agent retry, lineage retry, retention, timeouts, stale-state guards,
per-agent model selection in guided workflows, persistent handle turns, FIFO
admission, workflow stop, and cancellation of outstanding work on failure.

## Installation and pickup

The local marketplace previously pointed to this checkout. After reinstalling
or updating the plugin, start a new Codex task so the new `0.4.0` manifest,
skills, and MCP tool schema are loaded.

The source package remains marked `private` in `package.json` only to prevent
accidental npm publication. The GitHub repository is intended to be public.

## Safe continuation

Before adding upstream features, verify the latest upstream changelog and keep
the Pi/Codex boundary explicit. Do not claim support for Trajectory, Herdr,
worktrees, roles, budgets, or standalone subagents until a real Codex-native
implementation and persistence migration exist.

Do not commit workflow-run directories, marketplace archives, secrets, cache
files, or machine-specific configuration.
