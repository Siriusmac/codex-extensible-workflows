# Changelog

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
