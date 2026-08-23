---
name: codex-workflow-wizard
description: Configure and launch a Codex multi-agent workflow through a short conversational wizard. Use when the user asks to start, configure, or run a guided workflow without writing JavaScript, especially when choosing progress visibility or a different GPT model for each subagent.
---

# Codex Workflow Wizard

Guide the user from a project goal to one confirmed `workflow_run_guided` call.
Keep the setup short and use the current project as `cwd`.

## Wizard

If the user's goal is not already clear, ask for it. Then collect these choices
in one concise message:

1. Progress narration: recommend `No`. Explain that `Yes` enables intermediate
   updates and consumes additional conversation tokens.
2. Model strategy: `Codex default`, `one model for all`, or `different models`.
   Preserve exact model IDs supplied by the user. Do not invent availability or
   silently substitute a model.

Inspect the project read-only when needed, then propose two to four independent
subagents plus an optional synthesis agent. Give every subagent a short stable
ID, label, focused prompt, and model column. If the user chose different models,
ask them to fill or adjust the model column. `Codex default` means omitting the
model field.

Show the final compact configuration and obtain confirmation before launch.
Do not ask again for values the user already provided.

## Launch

Call `workflow_run_guided` with:

- a stable descriptive `name`;
- the confirmed project `goal`;
- the confirmed `tasks` and exact optional `model` per task;
- `synthesis: false` when the user wants raw reports, otherwise a synthesis
  object with its independently selected model when supplied;
- `background: true`;
- `progressUpdates: true` only when the user explicitly chose progress
  narration, otherwise `false`.

Use `read-only` for analysis and review agents. Use `workspace-write` only when
the requested workflow is meant to change the project. Never select
`danger-full-access` without explicit authorization.

For quiet runs, call `workflow_wait` with `waitMs: 50000` until terminal and do
not narrate heartbeats. For narrated runs, use `workflow_events` with its cursor
and report only meaningful changes. Preserve the run ID for resume or retry.

## Fast path

If the user provides the goal, progress choice, task list, and model mapping in
the initial request, skip the questions, show the final configuration once, and
launch after confirmation.
