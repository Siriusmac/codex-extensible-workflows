---
name: codex-extensible-workflows
description: Create and run deterministic, resumable multi-agent Codex workflows when a task benefits from parallel specialist agents, aggregation, or recovery without repeating completed work.
---

# Codex Extensible Workflows

Use the `workflow_run` MCP tool for work that has at least two independent branches or a stable multi-step pipeline. Keep simple tasks in the current Codex task.

When the user wants a guided setup, does not want to author JavaScript, or wants
to choose a model per subagent, use the companion `codex-workflow-wizard` skill
and `workflow_run_guided` instead.

## Default workflow

1. Give the run a stable, descriptive `name`.
2. Write an inline trusted JavaScript `script`.
3. Fan out independent work with `parallel(name, tasks)`.
4. Await all results and pass them to one final `agent(...)` with `prompt(...)`.
5. Start with `background: true` and `progressUpdates: false`.
6. Call `workflow_wait` with `waitMs: 50000` until `terminal` is true. Do not
   narrate or summarize non-terminal waits.
7. Return the final JSON-compatible value.
8. Enable progress reporting only when the user explicitly asks for updates.
9. If a run is interrupted, call `workflow_resume` in background with the
   returned `runId`, then continue with `workflow_wait`.
10. If a run failed and should be tried again, call `workflow_retry`; it creates
    a new run ID and reuses completed operations without rewriting history.

Example:

```js
const reviews = await parallel("review", {
  correctness: () => agent("Review the current changes for correctness."),
  security: () => agent("Review the current changes for security."),
  tests: () => agent("Find missing or weak tests."),
});

return await agent(
  prompt("Prioritize these findings:\n\n{reviews}", { reviews }),
);
```

Use `args` for user-supplied JSON values. Use `scriptPath` only for a reviewed file inside `cwd`.

Per-agent options may set `model`, `sandbox`, `approvalPolicy`, `reasoningEffort`, `outputSchema`, `retries`, and `timeoutMs`.
They may also set a short `label` for progress reporting. Parallel agents use
their task key as the default label.

Child agents inherit an augmented `PATH` containing the Node runtime that
launched the plugin. Prefer the project's existing package-manager commands;
do not install another Node runtime merely because the system shell lacks one.

## Quiet terminal waiting

Do not run multi-agent workflows in the foreground: the MCP host may terminate
a single `tools/call` after 300 seconds even while valid work is still running.
The default token-efficient pattern is:

1. Call `workflow_run` with `background: true` and `progressUpdates: false`.
2. Retain the returned `runId`.
3. Call `workflow_wait` with `{ runId, cwd, waitMs: 50000 }`.
4. If `terminal` is false and `activeInThisServer` is true, call
   `workflow_wait` again without reporting an update to the user.
5. If `terminal` is false and `activeInThisServer` is false, resume the same
   run with `workflow_resume`, `background: true`, and
   `progressUpdates: false`; completed agents will be reused.
6. Report only the terminal result or failure.

`workflow_wait` is not progress polling: it returns no event list, agent
summary, or intermediate output. Its short heartbeat exists only to stay below
the MCP host timeout.

## Background progress

Progress reporting consumes conversation tokens and is disabled by default.
Do not infer consent from task length, complexity, parallelism, or use of
background execution. Enable it only when the user explicitly asks for live,
periodic, or intermediate updates.

After an explicit request for feedback during execution:

1. Call `workflow_run` with `background: true` and `progressUpdates: true`, and
   retain its `runId`.
2. Call `workflow_events` with `{ runId, cwd, cursor: 0 }`.
3. Summarize agent starts, completions, failures, workflow logs, and phase
   changes in commentary. Do not expose hidden reasoning.
4. Continue with `{ cursor: nextCursor, waitMs: 30000 }` until the returned
   workflow state is `completed` or `failed`.
5. Use `workflow_status` when a full snapshot or elapsed-time summary is useful.

Without an explicit request, leave `progressUpdates` unset or false, never call
`workflow_events`, and use only `workflow_wait` for terminal waiting. Do not
periodically poll `workflow_status`; use it only for recovery or a
user-requested snapshot. Events remain persisted locally even when reporting
is disabled.

Do not repeatedly return unchanged updates. A wait that produces no new event
is only a heartbeat; mention elapsed time and active labels at most once per
minute.

## Safety

- Workflow scripts are trusted code even though they execute in a restricted VM.
- Default child agents to `workspace-write` and approval policy `never`; failures are returned to the workflow instead of prompting invisibly.
- Use `read-only` for reviews and research.
- Do not use `danger-full-access` unless the user explicitly authorizes it.
- Do not put secrets in scripts, args, prompts, or persisted results.
- Use `expectedState` on automated resume/retry calls to avoid acting on stale
  state. Configure `retention` only when deletion of older terminal run
  directories is intended; active runs are never removed.

## Current limits

This adaptation supports `agent`, `parallel`, `pipeline`, `prompt`, `log`, persistent run state, background execution, compact terminal waiting, opt-in progress events, structured final output, guarded resume, lineage-preserving retry, agent retry/timeout controls, and opt-in terminal-run retention. It does not yet provide Pi's interactive checkpoints, workflow navigator or Trajectory UI, registered extension functions, aggregate token/cost budgets, standalone subagent controls, named worktrees, or live steering.
