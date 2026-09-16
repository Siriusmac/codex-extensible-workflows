# Attribution and upstream relationship

Codex Extensible Workflows is an independent adaptation of
[pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows),
created and maintained by Andrea "vekexasia" Baccega.

The original project established the workflow DSL and orchestration direction
that this project adapts, including deterministic agents, named parallel and
pipeline composition, persisted operations, resumability, background execution,
and recovery semantics. The upstream project declares the MIT License.

This repository does not import or require the upstream npm packages at runtime.
It replaces Pi's extension APIs, in-process agent runtime, model registry,
session lifecycle, and TUI with a Codex plugin, a local stdio MCP server, and
non-interactive `codex exec --json` child processes.

Later Codex-compatible adaptations also include persistent named multi-turn
agents, deterministic call-order admission, and cancellation of active child
processes. Their implementation uses Codex CLI session resume and MCP lifecycle
tools rather than Pi session APIs.

Codex-specific work in this repository includes the declarative
`workflow_run_guided` tool, the conversational `codex-workflow-wizard`, explicit
opt-in progress reporting, compact MCP-safe terminal waiting, Codex CLI option
mapping, and bundled Node runtime propagation.

This project is not an official release of pi-extensible-workflows, Pi, Andrea
Baccega, or OpenAI. See the upstream repository for the original project:
https://github.com/vekexasia/pi-extensible-workflows
