# Changelog

This changelog covers the independent Codex adaptation. The original project
has its own release history at
https://github.com/vekexasia/pi-extensible-workflows/blob/main/CHANGELOG.md.

## 0.4.0 - 2026-09-16

- Compared the Codex adaptation with upstream `v5.14.0` at commit
  `0292536c0c106feb006ba622168cf0fb44c686f2`.
- Added persistent named agents through `agent.create({ name, ... }).send(...)`;
  later turns resume the same Codex thread and completed turns remain replayable.
- Reserved concurrency permits in JavaScript call order so bounded workflows
  start agents deterministically even when persistence operations finish out of
  order.
- Added `workflow_stop` and process cancellation for runs active in the current
  MCP server, with durable `stopped` agent and workflow events.
- Cancelled and awaited outstanding Codex child work before recording a failed
  workflow, matching upstream's bridge-work ownership direction.
- Kept Pi-only extension settings, roles, portable `piewf` bundles, Trajectory,
  Herdr, TUI pause/checkpoint flows, and Pi worktree lifecycle out of the Codex
  compatibility boundary.

## 0.3.0 - 2026-08-23

- Added `workflow_run_guided`, a declarative workflow launcher that does not
  require users or skills to generate JavaScript.
- Added per-subagent and synthesis-agent model selection with an optional shared
  default model.
- Added the `codex-workflow-wizard` skill for choosing progress narration,
  planning subagent roles, assigning models, confirming, and launching.
- Kept progress narration disabled by default and preserved quiet terminal
  waiting for token-efficient runs.

## 0.2.0 - 2026-08-23

- Synced the Codex-compatible runtime concepts from upstream 5.1 through 5.7.
- Added `workflow_retry` with a new run ID, parent/lineage metadata, and reuse
  of completed operations from failed runs.
- Added optional `expectedState` guards to resume and retry requests.
- Added per-agent bounded `retries` and `timeoutMs` controls with persisted
  attempt counts and retry events.
- Made parallel phases settle every sibling before recording workflow failure,
  so completed sibling results are safely reusable by retry.
- Added opt-in best-effort terminal-run retention by age and/or maximum count.
- Recognized `stopped` as a terminal persisted state for forward compatibility.
- Raised the documented Node.js requirement to 22.19 or newer.
- Aligned the approval-policy schema with the current Codex CLI values.
- Kept Pi TUI, Trajectory, role/resource selection, worktrees, and standalone
  subagent controls outside the Codex compatibility boundary.

## 0.1.0 - 2026-08-03

- Added an installable Codex plugin and local MCP server.
- Added the `agent`, `parallel`, `pipeline`, `prompt`, and `log` workflow APIs.
- Added persisted state, deterministic operation keys, and resumable runs.
- Added bounded agent concurrency and structured output schemas.
- Added background execution and compact `workflow_wait` terminal waiting.
- Made intermediate progress reporting explicitly opt-in.
- Added incremental event cursors for requested live progress.
- Propagated Codex's bundled Node runtime through the child-agent `PATH`.
- Corrected Codex CLI global approval-option placement.
- Added regression coverage for resume, background progress, quiet waits,
  disabled progress, Node runtime propagation, and prompt validation.
