# Codex Extensible Workflows handoff

## Checkpoint

- Date: 2026-08-23
- Source version: `0.3.0`
- Branch: `main`
- Repository: https://github.com/Siriusmac/codex-extensible-workflows
- Intended visibility: public
- License: MIT
- Runtime: Node.js 22.19 or newer

This checkpoint contains the first public-ready release of the independent
Codex adaptation, including the upstream compatibility update and the guided
workflow wizard.

## Upstream dependency and attribution

This project adapts Andrea "vekexasia" Baccega's
[pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows).
The comparison used for this checkpoint is upstream `main` commit
`e5e6c837a216070bd5cd7f99b36db26a1517e5c5`, reviewed on 2026-08-23.

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
- Bounded concurrency and deterministic persisted operation keys.
- Background execution, compact terminal waiting, status, optional event
  cursors, resume, and lineage-preserving retry.
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
- `CODEX_BIN` and `CODEX_WORKFLOWS_NODE` runtime overrides.

## Pi-specific capabilities intentionally not implemented

The following upstream features depend on Pi host APIs or do not yet have a
stable, equivalent Codex surface. They were not replaced with partial or
misleading simulations:

- Pi TUI commands, navigator, startup picker, background widget, inline
  confirmations, and interactive checkpoints.
- Trajectory browser UI, Gantt, transcript inspection, publisher lifecycle,
  and live actions.
- Herdr panes and live Pi-session handoff.
- Pi roles, model aliases, resource selectors, context-file policies, setup
  hooks, and extension registries.
- Registered workflow functions and catalog invocation.
- Pi-owned named worktrees and worktree lifecycle actions.
- Aggregate token/cost budgets and provider-specific accounting or recovery
  dialogs.
- Durable standalone subagent tools, live steering, stopping, retry controls,
  and the `/subagents` TUI.
- The `piewf` CLI, `piewf doctor`, and Pi package/release integration.

## Persistence and compatibility

Runs are stored under `<cwd>/.codex/workflow-runs/<runId>/`. Completed operation
keys remain reusable across resume and retry. Existing version `0.1` persisted
runs remain readable; version `0.2` and `0.3` add fields without renaming the
original operation keys.

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

The current suite contains 11 tests covering persistence, parallel execution,
resume, quiet and narrated background runs, Node runtime propagation, prompt
validation, agent retry, lineage retry, retention, timeouts, stale-state guards,
and per-agent model selection in guided workflows.

## Installation and pickup

The local marketplace previously pointed to this checkout. After reinstalling
or updating the plugin, start a new Codex task so the new `0.3.0` manifest,
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
