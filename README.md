# Codex Extensible Workflows

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Upstream: pi-extensible-workflows](https://img.shields.io/badge/upstream-pi--extensible--workflows-blue)](https://github.com/vekexasia/pi-extensible-workflows)

Deterministic, resumable multi-agent workflow orchestration for Codex.

> [!IMPORTANT]
> This project is an independent Codex adaptation of Andrea "vekexasia"
> Baccega's original
> [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows).
> The workflow authoring model, deterministic operation structure, persistence
> concepts, parallel and pipeline composition, and recovery direction originate
> in that project. This repository is not an official upstream distribution and
> is not affiliated with vekexasia, Pi, or OpenAI.

There is no runtime package dependency on the Pi project. Pi-specific host
integration is replaced by a Codex plugin, a local MCP server, and separate
non-interactive `codex exec --json` processes. Both projects use the MIT
License; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

## Quick start

After installing the plugin, ask Codex:

> Start the workflow wizard for this project.

The wizard asks only for missing information:

1. What should the workflow accomplish?
2. Should Codex narrate intermediate progress? The recommended default is no,
   because progress updates consume additional conversation tokens.
3. Should agents use the configured Codex default model, one shared model, or
   a different model for each subagent?

Codex then proposes two to four focused subagents and an optional synthesis
agent, shows the complete model assignment for confirmation, and launches the
workflow in the background.

## Guided workflows without JavaScript

`workflow_run_guided` accepts a declarative configuration. Every subagent and
the synthesis agent may use a different model:

```json
{
  "name": "review-release",
  "goal": "Verify this project before release",
  "tasks": [
    {
      "id": "correctness",
      "label": "Correctness review",
      "prompt": "Review correctness and regression risks",
      "model": "gpt-model-a",
      "sandbox": "read-only"
    },
    {
      "id": "tests",
      "label": "Test review",
      "prompt": "Review test coverage and identify missing cases",
      "model": "gpt-model-b",
      "sandbox": "read-only"
    }
  ],
  "synthesis": {
    "prompt": "Prioritize the findings and recommend next steps",
    "model": "gpt-model-c",
    "sandbox": "read-only"
  },
  "background": true,
  "progressUpdates": false
}
```

Model IDs are passed unchanged to the Codex CLI. Omitting `model` uses
`defaultModel`, when provided, or the user's configured Codex default.

## Scripted workflow DSL

Advanced users can keep the authoring style introduced by the original Pi
project:

```js
const reviews = await parallel("review", {
  correctness: () => agent("Review correctness."),
  security: () => agent("Review security."),
  tests: () => agent("Review test coverage."),
});

return agent(prompt("Prioritize:\n{reviews}", { reviews }));
```

Supported workflow globals are `agent`, `parallel`, `pipeline`, `prompt`, and
`log`. Per-agent options include `model`, `sandbox`, `approvalPolicy`,
`reasoningEffort`, `outputSchema`, `retries`, `timeoutMs`, and `label`.

When one specialist should retain its Codex transcript across several turns,
create a named persistent handle:

```js
const reviewer = agent.create({ name: "reviewer", model: "gpt-model-a" });
const findings = await reviewer.send("Review the implementation.");
return reviewer.send(prompt("Verify these fixes:\n{findings}", { findings }));
```

Handle turns use stable operation keys and resume the previous Codex thread.
Completed turns are replayed from persisted state without contacting the model.

## MCP tools

The plugin exposes eight local MCP tools:

- `workflow_run`: run a trusted inline script or reviewed `scriptPath`.
- `workflow_run_guided`: run a declarative workflow with per-agent models.
- `workflow_status`: inspect persisted state and the agent summary.
- `workflow_events`: read explicitly enabled progress events from a cursor.
- `workflow_wait`: wait compactly for terminal state without progress output.
- `workflow_resume`: resume an interrupted run and reuse completed calls.
- `workflow_retry`: create a child run from a failed run while preserving
  lineage and reusing completed calls.
- `workflow_stop`: stop a run active in the current MCP server and terminate
  its running Codex child processes.

Each ordinary `agent(...)` launches a non-interactive Codex session; named
handle turns resume their prior session. Runs are stored in
`<cwd>/.codex/workflow-runs/<runId>/`.

## Quiet execution and progress

Background execution defaults to true. Use `workflow_wait` with a wait below
the MCP host timeout; the bundled skills use 50-second waits and do not narrate
unchanged heartbeats.

Progress narration is deliberately opt-in. `background: true` does not imply
permission to consume tokens with periodic updates. `workflow_events` is
available only when the run was explicitly started or resumed with
`progressUpdates: true`.

Events report operational state and outcomes, not hidden model reasoning.

## Upstream relationship

The comparison below is based on upstream `v5.14.0` at commit
`0292536c0c106feb006ba622168cf0fb44c686f2`, reviewed on 2026-09-16. Consult
the [upstream repository](https://github.com/vekexasia/pi-extensible-workflows)
and its [changelog](https://github.com/vekexasia/pi-extensible-workflows/blob/main/CHANGELOG.md)
for later changes.

### Concepts adapted from the original project

- Deterministic named `parallel` and `pipeline` composition.
- Agent orchestration with structured outputs.
- Stable persisted operation keys and reusable completed results.
- Durable run state, background execution, status inspection, and recovery.
- Retry concepts, bounded concurrency, agent timeouts, and terminal-run
  retention.
- Persistent named agent handles whose turns retain one transcript.
- Call-order admission under bounded concurrency and cancellation of running
  agent work when a workflow is stopped or fails.
- Trusted workflow scripts and JSON-compatible final results.

### Pi-specific capabilities not implemented in this Codex adaptation

These features depend on Pi extension APIs, Pi session ownership, Pi's model and
resource registries, or Pi's TUI. They have not been simulated with incomplete
substitutes:

- Pi's `/workflow` command, startup recovery picker, navigator, inline workflow
  widget, confirmation dialogs, and interactive checkpoints.
- Trajectory's browser UI, Gantt timeline, transcript and tool inspection,
  steering controls, and Pi session publisher lifecycle.
- Herdr panes and live Pi-session handoff.
- Pi role files, model aliases, extension and skill selectors, tool resource
  policies, setup hooks, and `contextFiles` resolution.
- Registered workflow functions such as `defineWorkflowFunction` and nested
  catalog invocation.
- Pi-owned named worktrees and worktree cleanup actions.
- Aggregate token and cost budgets, accounting summaries, budget-exhaustion
  dialogs, and provider-specific recovery state.
- Durable standalone `subagents_*` tools, including live steer, stop, retry,
  session handoff, and the `/subagents` TUI.
- The `piewf` CLI, `piewf doctor`, Pi package discovery, and Pi release UI.

Some of these capabilities may be added later only if Codex exposes an
equivalent stable interface with compatible safety and persistence semantics.

### Codex-specific additions beyond the original project

- Installable Codex plugin packaging with `.codex-plugin/plugin.json` and a
  local stdio MCP server.
- Separate `codex exec --json` child sessions instead of Pi's in-process agent
  runtime.
- `workflow_run_guided`, a declarative launcher that requires no JavaScript.
- `codex-workflow-wizard`, a conversational setup flow for goals, progress
  visibility, agent roles, and model selection per subagent and synthesis.
- Explicit `progressUpdates` consent and compact `workflow_wait` calls designed
  to control conversation-token usage and remain below the MCP host timeout.
- Codex CLI sandbox, approval-policy, reasoning-effort, and output-schema
  mapping for every agent.
- Codex bundled-Node `PATH` propagation so child agents can run project package
  managers even when the system shell has no global Node.js installation.
- `CODEX_BIN` and `CODEX_WORKFLOWS_NODE` overrides for desktop and local setups.

## Requirements

- Codex CLI available as `codex`, or its path supplied through `CODEX_BIN`.
- Node.js 22.19 or newer.
- A writable project directory for persisted workflow runs.

## Development and validation

```sh
npm test
```

The package remains marked `private` in `package.json` to prevent accidental
npm publication. That flag does not restrict the GitHub repository's public
visibility.

## Project status

Version 0.4 is a working community adaptation with persistence, background
execution, quiet waits, optional progress, guided and scripted launches,
per-agent model selection, persistent multi-turn agents, deterministic
admission, stop, retry, timeout, resume, and retention support. It is not a
drop-in replacement for the full Pi package.

See [HANDOFF.md](HANDOFF.md) for the current implementation checkpoint and
[CHANGELOG.md](CHANGELOG.md) for release history.

## License and attribution

This project is distributed under the MIT License, matching the license
declared by the original Pi project. See [LICENSE](LICENSE).

The original project is maintained by Andrea "vekexasia" Baccega:
[github.com/vekexasia/pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows).
See [NOTICE.md](NOTICE.md) for the full attribution statement.
