import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retryWorkflow, runGuidedWorkflow, runWorkflow, startWorkflow, workflowEvents, workflowStatus, workflowWait } from "../server.mjs";

test("runs parallel agents and resumes from completed results", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  const calls = join(root, "calls.log");
  await writeFile(mock, `#!${process.execPath}
import { appendFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const execIndex = args.indexOf("exec");
const approvalIndex = args.indexOf("-a");
if (execIndex < 0 || approvalIndex < 0 || approvalIndex > execIndex) {
  console.error("approval policy must be a global option before exec");
  process.exit(2);
}
const output = args[args.indexOf("-o") + 1];
const prompt = args.at(-1);
if (prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
await appendFile(${JSON.stringify(calls)}, prompt + "\\n");
await writeFile(output, "answer:" + prompt);
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-" + prompt }));
`, "utf8");
  await chmod(mock, 0o755);
  process.env.CODEX_BIN = mock;

  const script = `
const findings = await parallel("review", {
  one: () => agent("one"),
  two: () => agent("two"),
});
return prompt("{findings}", { findings });
`;
  const first = await runWorkflow({ name: "test", cwd: root, runId: "stable", script, concurrency: 2 });
  assert.equal(first.state, "completed");
  assert.match(first.result, /answer:one/);
  assert.match(first.result, /answer:two/);

  const resumed = await runWorkflow({ cwd: root, runId: "stable" }, true);
  assert.deepEqual(resumed.result, first.result);
  const callLines = (await readFile(calls, "utf8")).trim().split("\n");
  assert.deepEqual(callLines.sort(), ["one", "two"]);

  const status = await workflowStatus({ cwd: root, runId: "stable" });
  assert.equal(status.state, "completed");
  assert.equal(Object.keys(status.operations).length, 2);
});

test("runs in background and exposes incremental progress events", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-background-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  await writeFile(mock, `#!${process.execPath}
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
const prompt = args.at(-1);
await new Promise((resolve) => setTimeout(resolve, 250));
await writeFile(output, "answer:" + prompt);
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-" + prompt }));
`, "utf8");
  await chmod(mock, 0o755);
  process.env.CODEX_BIN = mock;

  const startedAt = Date.now();
  const started = await startWorkflow({
    name: "background-test",
    cwd: root,
    runId: "background",
    progressUpdates: true,
    script: `return agent("slow", { label: "Controllo privacy" });`,
  });
  assert.equal(started.state, "running");
  assert.equal(started.background, true);
  assert.ok(Date.now() - startedAt < 200);

  const initial = await workflowEvents({ cwd: root, runId: "background", cursor: 0 });
  assert.ok(initial.events.some((event) => event.type === "workflow.started"));

  let cursor = initial.nextCursor;
  let finalEvents = initial;
  const allEvents = [...initial.events];
  while (finalEvents.state === "running") {
    finalEvents = await workflowEvents({ cwd: root, runId: "background", cursor, waitMs: 1000 });
    cursor = finalEvents.nextCursor;
    allEvents.push(...finalEvents.events);
  }
  assert.equal(finalEvents.state, "completed");
  assert.ok(allEvents.some((event) => event.type === "agent.started" && event.label === "Controllo privacy"));
  assert.ok(allEvents.some((event) => event.type === "workflow.completed"));

  const status = await workflowStatus({ cwd: root, runId: "background" });
  assert.equal(status.progress.agents.completed, 1);
  assert.equal(status.operations["agent/1"].label, "Controllo privacy");
});

test("keeps progress events disabled unless explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-quiet-test-"));
  const result = await runWorkflow({
    name: "quiet-test",
    cwd: root,
    runId: "quiet",
    script: `await log("internal event"); return "done";`,
  });
  assert.equal(result.state, "completed");

  const status = await workflowStatus({ cwd: root, runId: "quiet" });
  assert.equal(status.progressUpdates, false);
  await assert.rejects(
    workflowEvents({ cwd: root, runId: "quiet", cursor: 0 }),
    /Progress updates are disabled/,
  );
});

test("waits for a quiet background run without returning progress events", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-wait-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  await writeFile(mock, `#!${process.execPath}
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
await new Promise((resolve) => setTimeout(resolve, 250));
await writeFile(output, "quiet result");
`, "utf8");
  await chmod(mock, 0o755);
  process.env.CODEX_BIN = mock;

  const started = await startWorkflow({
    name: "quiet-wait-test",
    cwd: root,
    runId: "quiet-wait",
    progressUpdates: false,
    script: `return agent("quiet agent");`,
  });
  assert.equal(started.state, "running");

  const heartbeat = await workflowWait({ cwd: root, runId: "quiet-wait", waitMs: 1 });
  assert.equal(heartbeat.terminal, false);
  assert.equal("progress" in heartbeat, false);
  assert.equal("events" in heartbeat, false);

  const terminal = await workflowWait({ cwd: root, runId: "quiet-wait", waitMs: 1000 });
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.result, "quiet result");
});

test("adds the workflow Node runtime to the child agent PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-path-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  await writeFile(mock, `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const nodeCheck = spawnSync("node", ["--version"], { encoding: "utf8" });
if (nodeCheck.status !== 0) {
  console.error(nodeCheck.error?.message ?? nodeCheck.stderr ?? "node unavailable");
  process.exit(3);
}
const output = args[args.indexOf("-o") + 1];
await writeFile(output, nodeCheck.stdout.trim());
`, "utf8");
  await chmod(mock, 0o755);

  const previousCodexBin = process.env.CODEX_BIN;
  const previousPath = process.env.PATH;
  process.env.CODEX_BIN = mock;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const result = await runWorkflow({
      name: "path-test",
      cwd: root,
      script: `return agent("validate runtime");`,
    });
    assert.equal(result.state, "completed");
    assert.match(result.result, /^v\d+\./);
  } finally {
    if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBin;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("validates prompt placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-test-"));
  await assert.rejects(
    runWorkflow({
      name: "bad-prompt",
      cwd: root,
      script: `return prompt("{present}", { present: "yes", unused: "no" });`,
    }),
    /Unused prompt value/,
  );
});

test("retries a failed agent up to its configured limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-agent-retry-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  const marker = join(root, "attempt.marker");
  await writeFile(mock, `#!${process.execPath}
import { access, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
try { await access(${JSON.stringify(marker)}); }
catch { await writeFile(${JSON.stringify(marker)}, "failed once"); process.exit(7); }
await writeFile(output, "recovered");
`, "utf8");
  await chmod(mock, 0o755);
  process.env.CODEX_BIN = mock;

  const result = await runWorkflow({
    name: "agent-retry",
    cwd: root,
    script: `return agent("flaky", { retries: 1 });`,
  });
  assert.equal(result.result, "recovered");
  const status = await workflowStatus({ cwd: root, runId: result.runId });
  assert.equal(status.operations["agent/1"].attempts, 2);
});

test("retries a failed workflow as a new lineage run and reuses completed operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-lineage-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  const calls = join(root, "calls.log");
  const failedOnce = join(root, "failed-once.marker");
  await writeFile(mock, `#!${process.execPath}
import { access, appendFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
const prompt = args.at(-1);
await appendFile(${JSON.stringify(calls)}, prompt + "\\n");
if (prompt === "bad") {
  try { await access(${JSON.stringify(failedOnce)}); }
  catch { await writeFile(${JSON.stringify(failedOnce)}, "failed once"); process.exit(8); }
}
await writeFile(output, "answer:" + prompt);
`, "utf8");
  await chmod(mock, 0o755);
  process.env.CODEX_BIN = mock;

  const script = `
const values = await parallel("work", {
  good: () => agent("good"),
  bad: () => agent("bad"),
});
return values;
`;
  await assert.rejects(runWorkflow({ name: "lineage", cwd: root, runId: "source", script }));
  const retried = await retryWorkflow({ cwd: root, runId: "source", newRunId: "child", expectedState: "failed" });
  assert.equal(retried.state, "completed");
  const child = await workflowStatus({ cwd: root, runId: "child" });
  assert.equal(child.parentRunId, "source");
  assert.equal(child.retry.lineageRootRunId, "source");
  const callLines = (await readFile(calls, "utf8")).trim().split("\n").sort();
  assert.deepEqual(callLines, ["bad", "bad", "good"]);
});

test("applies opt-in retention only to terminal workflow runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-retention-test-"));
  for (const runId of ["one", "two"]) {
    await runWorkflow({ name: runId, cwd: root, runId, script: `return ${JSON.stringify(runId)};` });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await runWorkflow({
    name: "three",
    cwd: root,
    runId: "three",
    script: `return "three";`,
    retention: { maxTerminalRuns: 1 },
  });
  await assert.rejects(workflowStatus({ cwd: root, runId: "one" }), /ENOENT/);
  assert.equal((await workflowStatus({ cwd: root, runId: "two" })).state, "completed");
  assert.equal((await workflowStatus({ cwd: root, runId: "three" })).state, "completed");
});

test("enforces agent timeouts and expected-state recovery guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-guards-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  await writeFile(mock, `#!${process.execPath}
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
await new Promise((resolve) => setTimeout(resolve, 250));
await writeFile(output, "late");
`, "utf8");
  await chmod(mock, 0o755);
  process.env.CODEX_BIN = mock;

  await assert.rejects(
    runWorkflow({ name: "timeout", cwd: root, runId: "timeout", script: `return agent("slow", { timeoutMs: 10 });` }),
    /timed out after 10ms/,
  );
  const completed = await runWorkflow({ name: "completed", cwd: root, runId: "completed", script: `return "done";` });
  await assert.rejects(
    runWorkflow({ cwd: root, runId: completed.runId, expectedState: "failed" }, true),
    /is completed, expected failed/,
  );
  assert.equal((await workflowStatus({ cwd: root, runId: completed.runId })).state, "completed");
});

test("runs a declarative guided workflow with a different model per agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workflow-guided-test-"));
  await mkdir(join(root, ".git"));
  const mock = join(root, "mock-codex.mjs");
  const calls = join(root, "guided-calls.log");
  await writeFile(mock, `#!${process.execPath}
import { appendFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
const prompt = args.at(-1);
const modelIndex = args.indexOf("-m");
const model = modelIndex < 0 ? null : args[modelIndex + 1];
await appendFile(${JSON.stringify(calls)}, JSON.stringify({ model, prompt }) + "\\n");
await writeFile(output, "answer:" + model);
`, "utf8");
  await chmod(mock, 0o755);
  process.env.CODEX_BIN = mock;

  const result = await runGuidedWorkflow({
    name: "guided",
    goal: "Review the project",
    cwd: root,
    tasks: [
      { id: "code", label: "Code", prompt: "Review the code", model: "gpt-code" },
      { id: "tests", label: "Tests", prompt: "Review the tests", model: "gpt-tests" },
    ],
    synthesis: { prompt: "Summarize", model: "gpt-summary" },
  }, false);
  assert.equal(result.state, "completed");
  assert.equal(result.result, "answer:gpt-summary");
  const entries = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(entries.map(({ model }) => model).sort(), ["gpt-code", "gpt-summary", "gpt-tests"]);
  assert.ok(entries.some(({ prompt }) => prompt.includes("Workflow goal:\nReview the project")));
  assert.ok(entries.some(({ prompt }) => prompt.includes("Subagent results:")));
});
