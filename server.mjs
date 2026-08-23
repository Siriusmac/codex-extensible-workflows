import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Independent Codex runtime adapter for the workflow model introduced by
// https://github.com/vekexasia/pi-extensible-workflows. See NOTICE.md for the
// upstream relationship and the Codex-specific compatibility boundary.
const SERVER = { name: "codex-extensible-workflows", version: "0.3.0" };
const RUNS_DIRECTORY = join(".codex", "workflow-runs");
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"]);
const contextPath = new AsyncLocalStorage();
const activeRuns = new Map();

function json(value) {
  return JSON.stringify(value, null, 2);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function safeRunId(value) {
  assertString(value, "runId");
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("runId may contain only letters, numbers, underscores, and hyphens");
  }
  return value;
}

function assertExpectedState(state, expectedState) {
  if (expectedState !== undefined && state.state !== expectedState) {
    throw new Error(`Workflow run "${state.id}" is ${state.state}, expected ${expectedState}`);
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${json(value)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function runPaths(cwd, runId) {
  const directory = join(cwd, RUNS_DIRECTORY, runId);
  return {
    directory,
    state: join(directory, "state.json"),
    result: join(directory, "result.json"),
    events: join(directory, "events.jsonl"),
  };
}

function normalizeRetention(value) {
  if (value === undefined) return undefined;
  assertObject(value, "retention");
  const olderThanDays = value.olderThanDays;
  const maxTerminalRuns = value.maxTerminalRuns;
  if (olderThanDays !== undefined && (!Number.isInteger(olderThanDays) || olderThanDays < 0)) {
    throw new Error("retention.olderThanDays must be a non-negative integer");
  }
  if (maxTerminalRuns !== undefined && (!Number.isInteger(maxTerminalRuns) || maxTerminalRuns < 0)) {
    throw new Error("retention.maxTerminalRuns must be a non-negative integer");
  }
  if (olderThanDays === undefined && maxTerminalRuns === undefined) {
    throw new Error("retention must set olderThanDays or maxTerminalRuns");
  }
  return { olderThanDays, maxTerminalRuns };
}

async function applyRetention(cwd, retention) {
  if (!retention) return;
  const root = join(cwd, RUNS_DIRECTORY);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const terminal = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    try {
      const paths = runPaths(cwd, entry.name);
      const state = await readJson(paths.state);
      if (!TERMINAL_STATES.has(state.state)) continue;
      const details = await stat(paths.state);
      terminal.push({ id: entry.name, updatedAt: state.updatedAt ?? details.mtimeMs });
    } catch {
      // Retention is best-effort and must not make workflow launch unavailable.
    }
  }
  terminal.sort((left, right) => right.updatedAt - left.updatedAt);
  const cutoff = retention.olderThanDays === undefined
    ? undefined
    : Date.now() - retention.olderThanDays * 24 * 60 * 60 * 1000;
  const removals = terminal.filter((run, index) =>
    (cutoff !== undefined && run.updatedAt < cutoff)
    || (retention.maxTerminalRuns !== undefined && index >= retention.maxTerminalRuns));
  await Promise.allSettled(removals.map(({ id }) => rm(runPaths(cwd, id).directory, { recursive: true, force: true })));
}

async function appendEvent(paths, event) {
  await mkdir(dirname(paths.events), { recursive: true });
  await appendFile(paths.events, `${JSON.stringify({ at: Date.now(), ...event })}\n`, "utf8");
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function operationLabel(key, operation) {
  if (typeof operation?.label === "string" && operation.label.trim()) return operation.label.trim();
  const parts = key.split("/").map((part) => decodeURIComponent(part));
  const parallelIndex = parts.lastIndexOf("parallel");
  if (parallelIndex >= 0 && parts[parallelIndex + 2]) return parts[parallelIndex + 2];
  const pipelineIndex = parts.lastIndexOf("pipeline");
  if (pipelineIndex >= 0 && parts[pipelineIndex + 2]) return parts[pipelineIndex + 2];
  return `agent ${parts.at(-1) ?? ""}`.trim();
}

function workflowProgress(state) {
  const entries = Object.entries(state.operations ?? {});
  const byState = { running: 0, completed: 0, failed: 0 };
  for (const [, operation] of entries) {
    if (operation?.state in byState) byState[operation.state] += 1;
  }
  return {
    agents: { known: entries.length, ...byState },
    active: entries
      .filter(([, operation]) => operation?.state === "running")
      .map(([key, operation]) => ({
        key,
        label: operationLabel(key, operation),
        startedAt: operation.startedAt,
        elapsedMs: operation.startedAt ? Math.max(0, Date.now() - operation.startedAt) : undefined,
      })),
    elapsedMs: Math.max(0, (state.state === "running" ? Date.now() : (state.updatedAt ?? Date.now())) - state.createdAt),
  };
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async use(operation) {
    if (this.active >= this.limit) {
      await new Promise((resolveWaiter) => this.waiters.push(resolveWaiter));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

function findCodexBinary() {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) return configured;
  const bundledMacBinary = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return existsSync(bundledMacBinary) ? bundledMacBinary : "codex";
}

function agentEnvironment() {
  const environment = { ...process.env };
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const nodeDirectory = dirname(process.execPath);
  const entries = (environment[pathKey] ?? "").split(delimiter).filter(Boolean);
  environment[pathKey] = [nodeDirectory, ...entries.filter((entry) => entry !== nodeDirectory)].join(delimiter);
  return environment;
}

async function codexAgent(promptText, options, runtime) {
  assertString(promptText, "agent prompt");
  assertObject(options, "agent options");
  const retries = options.retries ?? 0;
  const timeoutMs = options.timeoutMs ?? null;
  if (!Number.isInteger(retries) || retries < 0 || retries > 255) {
    throw new Error("agent retries must be an integer from 0 to 255");
  }
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error("agent timeoutMs must be null or a positive integer");
  }
  const model = options.model ?? runtime.defaults.model;
  const sandbox = options.sandbox ?? runtime.defaults.sandbox;
  const approvalPolicy = options.approvalPolicy ?? runtime.defaults.approvalPolicy;
  const reasoningEffort = options.reasoningEffort ?? runtime.defaults.reasoningEffort;
  let schemaPath;
  if (options.outputSchema) {
    schemaPath = join(runtime.paths.directory, `schema-${runtime.fileCounter++}.json`);
    await atomicWrite(schemaPath, options.outputSchema);
  }

  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const outputPath = join(runtime.paths.directory, `agent-${runtime.fileCounter++}.txt`);
    const command = findCodexBinary();
    const args = [];
    // --ask-for-approval is a global Codex option and must precede `exec`.
    if (approvalPolicy) args.push("-a", approvalPolicy);
    args.push("exec", "--json", "--color", "never", "-C", runtime.cwd, "-o", outputPath);
    if (model) args.push("-m", model);
    if (sandbox) args.push("-s", sandbox);
    if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    if (schemaPath) args.push("--output-schema", schemaPath);
    args.push(promptText);

    const execution = await new Promise((resolveExecution, rejectExecution) => {
      const child = spawn(command, args, {
        cwd: runtime.cwd,
        env: agentEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        rejectExecution(error);
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        resolveExecution({ code, signal, stdout, stderr, timedOut });
      });
    });

    if (execution.code === 0 && !execution.timedOut) {
      const text = (await readFile(outputPath, "utf8")).trim();
      let threadId;
      for (const line of execution.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
        } catch {
          // Preserve compatibility if Codex emits a non-JSON diagnostic line.
        }
      }
      const value = options.outputSchema ? JSON.parse(text) : text;
      return { value, threadId, attempts: attempt };
    }
    const detail = execution.timedOut
      ? `timed out after ${timeoutMs}ms`
      : `${execution.code ?? execution.signal}: ${execution.stderr.trim() || execution.stdout.trim()}`;
    lastError = new Error(`Codex agent attempt ${attempt} failed (${detail})`);
    if (attempt <= retries) {
      await appendEvent(runtime.paths, { type: "agent.retrying", attempt, nextAttempt: attempt + 1, error: lastError.message });
    }
  }
  throw lastError;
}

function promptTemplate(template, values) {
  assertString(template, "prompt template");
  assertObject(values, "prompt values");
  const used = new Set();
  const rendered = template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (!(key in values)) throw new Error(`Missing prompt value "${key}"`);
    used.add(key);
    return typeof values[key] === "string" ? values[key] : json(values[key]);
  });
  const unused = Object.keys(values).find((key) => !used.has(key));
  if (unused) throw new Error(`Unused prompt value "${unused}"`);
  return rendered;
}

function operationKey(kind, name) {
  const parent = contextPath.getStore() ?? [];
  return [...parent, kind, encodeURIComponent(name)].join("/");
}

function workflowGlobals(runtime) {
  const counters = new Map();

  const nextAgentKey = () => {
    const parent = contextPath.getStore() ?? [];
    const base = parent.join("/");
    const count = (counters.get(base) ?? 0) + 1;
    counters.set(base, count);
    return [...parent, "agent", String(count)].join("/");
  };

  const agent = async (agentPrompt, options = {}) => {
    const key = nextAgentKey();
    const cached = runtime.state.operations[key];
    if (cached?.state === "completed") {
      await appendEvent(runtime.paths, { type: "agent.cached", key });
      return cached.value;
    }
    const label = typeof options.label === "string" && options.label.trim()
      ? options.label.trim()
      : operationLabel(key);
    runtime.state.operations[key] = { state: "running", prompt: agentPrompt, label, startedAt: Date.now() };
    runtime.state.updatedAt = Date.now();
    await atomicWrite(runtime.paths.state, runtime.state);
    await appendEvent(runtime.paths, { type: "agent.started", key, label });
    try {
      const result = await runtime.semaphore.use(() => codexAgent(agentPrompt, options, runtime));
      runtime.state.operations[key] = {
        state: "completed",
        value: result.value,
        label,
        attempts: result.attempts,
        ...(result.threadId ? { threadId: result.threadId } : {}),
        completedAt: Date.now(),
      };
      runtime.state.updatedAt = Date.now();
      await atomicWrite(runtime.paths.state, runtime.state);
      await appendEvent(runtime.paths, { type: "agent.completed", key, label, threadId: result.threadId });
      return result.value;
    } catch (error) {
      runtime.state.operations[key] = { state: "failed", error: String(error), label, failedAt: Date.now() };
      runtime.state.updatedAt = Date.now();
      await atomicWrite(runtime.paths.state, runtime.state);
      await appendEvent(runtime.paths, { type: "agent.failed", key, label, error: String(error) });
      throw error;
    }
  };

  const parallel = async (name, tasks) => {
    assertString(name, "parallel name");
    assertObject(tasks, "parallel tasks");
    const taskEntries = Object.entries(tasks);
    const settled = await Promise.allSettled(taskEntries.map(async ([taskName, task]) => {
      if (typeof task !== "function") throw new Error(`parallel task "${taskName}" must be a function`);
      const path = [...(contextPath.getStore() ?? []), "parallel", encodeURIComponent(name), encodeURIComponent(taskName)];
      const value = await contextPath.run(path, task);
      return [taskName, value];
    }));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return Object.fromEntries(settled.map((result) => result.value));
  };

  const pipeline = async (name, steps, initial = null) => {
    assertString(name, "pipeline name");
    const entries = Array.isArray(steps) ? steps.map((step, index) => [String(index + 1), step]) : Object.entries(steps ?? {});
    let value = initial;
    for (const [stepName, step] of entries) {
      if (typeof step !== "function") throw new Error(`pipeline step "${stepName}" must be a function`);
      const path = [...(contextPath.getStore() ?? []), "pipeline", encodeURIComponent(name), encodeURIComponent(stepName)];
      value = await contextPath.run(path, () => step(value));
    }
    return value;
  };

  return Object.freeze({
    agent,
    parallel,
    pipeline,
    prompt: promptTemplate,
    log: async (message) => {
      assertString(message, "log message");
      await appendEvent(runtime.paths, { type: "workflow.log", message });
    },
  });
}

async function loadScript(params, cwd) {
  const hasScript = typeof params.script === "string";
  const hasScriptPath = typeof params.scriptPath === "string";
  if (hasScript === hasScriptPath) throw new Error("Provide exactly one of script or scriptPath");
  if (hasScript) return params.script;
  const scriptPath = resolve(cwd, params.scriptPath);
  const outside = relative(cwd, scriptPath);
  if (outside.startsWith("..") || isAbsolute(outside)) {
    throw new Error("scriptPath must stay inside cwd");
  }
  return readFile(scriptPath, "utf8");
}

function normalizeDefaults(params) {
  const concurrency = params.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("concurrency must be an integer from 1 to 16");
  }
  return {
    concurrency,
    model: params.model,
    sandbox: params.sandbox ?? "workspace-write",
    approvalPolicy: params.approvalPolicy ?? "never",
    reasoningEffort: params.reasoningEffort,
  };
}

const GUIDED_WORKFLOW_SCRIPT = `
const guidedTasks = {};
for (const task of args.tasks) {
  guidedTasks[task.id] = () => agent(
    "Workflow goal:\\n" + args.goal + "\\n\\nSubagent assignment:\\n" + task.prompt,
    task.options,
  );
}
const reports = await parallel("guided", guidedTasks);
if (!args.synthesis) return reports;
return agent(
  args.synthesis.prompt + "\\n\\nGoal:\\n" + args.goal + "\\n\\nSubagent results:\\n" + JSON.stringify(reports, null, 2),
  args.synthesis.options,
);
`;

function guidedAgentOptions(value, defaultModel, defaultLabel) {
  const options = {
    label: value.label?.trim() || defaultLabel,
    model: value.model?.trim() || defaultModel,
    sandbox: value.sandbox,
    approvalPolicy: value.approvalPolicy,
    reasoningEffort: value.reasoningEffort,
    outputSchema: value.outputSchema,
    retries: value.retries,
    timeoutMs: value.timeoutMs,
  };
  return Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined));
}

function normalizeGuidedWorkflow(params) {
  assertObject(params, "guided workflow arguments");
  assertString(params.name, "name");
  assertString(params.goal, "goal");
  if (!Array.isArray(params.tasks) || params.tasks.length < 1 || params.tasks.length > 16) {
    throw new Error("tasks must contain from 1 to 16 subagents");
  }
  const defaultModel = typeof params.defaultModel === "string" && params.defaultModel.trim()
    ? params.defaultModel.trim()
    : undefined;
  const ids = new Set();
  const tasks = params.tasks.map((task, index) => {
    assertObject(task, `tasks[${index}]`);
    assertString(task.id, `tasks[${index}].id`);
    assertString(task.prompt, `tasks[${index}].prompt`);
    const id = task.id.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`tasks[${index}].id may contain only letters, numbers, underscores, and hyphens`);
    if (ids.has(id)) throw new Error(`Duplicate guided task id "${id}"`);
    ids.add(id);
    const options = guidedAgentOptions(task, defaultModel, task.label?.trim() || id);
    // Reuse the agent runtime validators before persisting the guided request.
    if (options.retries !== undefined && (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 255)) {
      throw new Error(`tasks[${index}].retries must be an integer from 0 to 255`);
    }
    if (options.timeoutMs !== undefined && options.timeoutMs !== null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new Error(`tasks[${index}].timeoutMs must be null or a positive integer`);
    }
    return { id, prompt: task.prompt.trim(), options };
  });

  let synthesis = null;
  if (params.synthesis !== false) {
    const requested = params.synthesis === undefined || params.synthesis === true ? {} : params.synthesis;
    assertObject(requested, "synthesis");
    const promptText = requested.prompt?.trim()
      || "Produce a concise, coherent, and actionable final response that highlights priorities, risks, and next steps.";
    synthesis = {
      prompt: promptText,
      options: guidedAgentOptions(requested, defaultModel, requested.label?.trim() || "Final synthesis"),
    };
  }
  return {
    goal: params.goal.trim(),
    tasks,
    synthesis,
  };
}

export async function runGuidedWorkflow(params, background = true) {
  const guided = normalizeGuidedWorkflow(params);
  const workflowParams = {
    ...params,
    script: GUIDED_WORKFLOW_SCRIPT,
    scriptPath: undefined,
    args: guided,
  };
  return background ? startWorkflow(workflowParams) : runWorkflow(workflowParams);
}

export async function runWorkflow(params, resume = false, lifecycle = {}) {
  assertObject(params, "workflow arguments");
  const cwd = resolve(params.cwd ?? process.cwd());
  await access(cwd, fsConstants.R_OK | fsConstants.W_OK);
  const defaults = normalizeDefaults(params);
  let runId;
  let script;
  let args;
  let state;

  if (resume) {
    runId = safeRunId(params.runId);
    const paths = runPaths(cwd, runId);
    state = await readJson(paths.state);
    assertExpectedState(state, params.expectedState);
    if (params.progressUpdates !== undefined) {
      state.progressUpdates = params.progressUpdates === true;
    }
    script = state.script;
    args = state.args;
  } else {
    assertString(params.name, "name");
    await applyRetention(cwd, normalizeRetention(params.retention));
    runId = params.runId ? safeRunId(params.runId) : randomUUID();
    script = await loadScript(params, cwd);
    args = params.args ?? null;
    const paths = runPaths(cwd, runId);
    try {
      await access(paths.state);
      throw new Error(`Workflow run "${runId}" already exists; use workflow_resume`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    state = {
      id: runId,
      name: params.name.trim(),
      cwd,
      state: "running",
      script,
      args,
      defaults,
      progressUpdates: params.progressUpdates === true,
      operations: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  const paths = runPaths(cwd, runId);
  state.state = "running";
  delete state.error;
  state.updatedAt = Date.now();
  await atomicWrite(paths.state, state);
  await appendEvent(paths, { type: resume ? "workflow.resumed" : "workflow.started", runId });
  lifecycle.onStarted?.({ runId, state: state.state, runDirectory: paths.directory });
  const runtime = {
    cwd,
    paths,
    state,
    defaults: resume ? state.defaults : defaults,
    semaphore: new Semaphore((resume ? state.defaults : defaults).concurrency),
    fileCounter: 1,
  };
  const globals = workflowGlobals(runtime);
  const context = vm.createContext({
    ...globals,
    args,
    console: Object.freeze({ log: (...values) => globals.log(values.map(String).join(" ")) }),
  }, { codeGeneration: { strings: false, wasm: false } });

  try {
    const compiled = new vm.Script(`(async () => {\n"use strict";\n${script}\n})()`, {
      filename: `workflow:${state.name}`,
    });
    const result = await compiled.runInContext(context, { timeout: 1000 });
    state.state = "completed";
    state.result = result ?? null;
    state.updatedAt = Date.now();
    await atomicWrite(paths.result, state.result);
    await atomicWrite(paths.state, state);
    await appendEvent(paths, { type: "workflow.completed", runId });
    return { runId, state: state.state, result: state.result, runDirectory: paths.directory };
  } catch (error) {
    state.state = "failed";
    state.error = error instanceof Error ? error.message : String(error);
    state.updatedAt = Date.now();
    await atomicWrite(paths.state, state);
    await appendEvent(paths, { type: "workflow.failed", runId, error: state.error });
    throw Object.assign(new Error(state.error), { runId, runDirectory: paths.directory });
  }
}

export async function startWorkflow(params, resume = false) {
  assertObject(params, "workflow arguments");
  const cwd = resolve(params.cwd ?? process.cwd());
  const requestedRunId = resume
    ? safeRunId(params.runId)
    : (params.runId ? safeRunId(params.runId) : randomUUID());
  const key = `${cwd}\u0000${requestedRunId}`;
  if (activeRuns.has(key)) throw new Error(`Workflow run "${requestedRunId}" is already active`);

  let resolveStarted;
  let rejectStarted;
  let didStart = false;
  const started = new Promise((resolvePromise, rejectPromise) => {
    resolveStarted = resolvePromise;
    rejectStarted = rejectPromise;
  });
  const execution = runWorkflow(
    { ...params, cwd, runId: requestedRunId },
    resume,
    {
      onStarted(info) {
        didStart = true;
        resolveStarted(info);
      },
    },
  );
  activeRuns.set(key, execution);
  void execution.catch((error) => {
    if (!didStart) rejectStarted(error);
  }).finally(() => {
    activeRuns.delete(key);
  });
  const info = await started;
  return { ...info, background: true };
}

export async function retryWorkflow(params, lifecycle = {}) {
  assertObject(params, "retry arguments");
  const cwd = resolve(params.cwd ?? process.cwd());
  const sourceRunId = safeRunId(params.runId);
  const source = await readJson(runPaths(cwd, sourceRunId).state);
  assertExpectedState(source, params.expectedState);
  if (source.state !== "failed") {
    throw new Error(`Workflow run "${sourceRunId}" is ${source.state}; only failed runs can be retried`);
  }
  const childRunId = params.newRunId ? safeRunId(params.newRunId) : randomUUID();
  const childPaths = runPaths(cwd, childRunId);
  try {
    await access(childPaths.state);
    throw new Error(`Workflow run "${childRunId}" already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const completedOperations = Object.fromEntries(
    Object.entries(source.operations ?? {}).filter(([, operation]) => operation?.state === "completed"),
  );
  const child = {
    ...source,
    id: childRunId,
    state: "failed",
    operations: completedOperations,
    parentRunId: sourceRunId,
    retry: {
      sourceRunId,
      lineageRootRunId: source.retry?.lineageRootRunId ?? sourceRunId,
      reusedOperationKeys: Object.keys(completedOperations),
    },
    progressUpdates: params.progressUpdates ?? source.progressUpdates ?? false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  delete child.error;
  delete child.result;
  await atomicWrite(childPaths.state, child);
  return runWorkflow({ cwd, runId: childRunId, progressUpdates: child.progressUpdates }, true, lifecycle);
}

export async function startRetryWorkflow(params) {
  assertObject(params, "retry arguments");
  const cwd = resolve(params.cwd ?? process.cwd());
  const childRunId = params.newRunId ? safeRunId(params.newRunId) : randomUUID();
  const key = `${cwd}\u0000${childRunId}`;
  if (activeRuns.has(key)) throw new Error(`Workflow run "${childRunId}" is already active`);
  let resolveStarted;
  let rejectStarted;
  let didStart = false;
  const started = new Promise((resolvePromise, rejectPromise) => {
    resolveStarted = resolvePromise;
    rejectStarted = rejectPromise;
  });
  const execution = retryWorkflow(
    { ...params, cwd, newRunId: childRunId },
    { onStarted(info) { didStart = true; resolveStarted(info); } },
  );
  activeRuns.set(key, execution);
  void execution.catch((error) => {
    if (!didStart) rejectStarted(error);
  }).finally(() => activeRuns.delete(key));
  return { ...(await started), background: true, parentRunId: params.runId };
}

export async function workflowStatus(params) {
  assertObject(params, "status arguments");
  const cwd = resolve(params.cwd ?? process.cwd());
  const runId = safeRunId(params.runId);
  const paths = runPaths(cwd, runId);
  const state = await readJson(paths.state);
  return {
    ...state,
    script: undefined,
    progress: workflowProgress(state),
    activeInThisServer: activeRuns.has(`${cwd}\u0000${runId}`),
    runDirectory: paths.directory,
  };
}

async function readEvents(paths) {
  try {
    const contents = await readFile(paths.events, "utf8");
    return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function workflowEvents(params) {
  assertObject(params, "events arguments");
  const cwd = resolve(params.cwd ?? process.cwd());
  const runId = safeRunId(params.runId);
  const cursor = params.cursor ?? 0;
  const limit = params.limit ?? 100;
  const waitMs = params.waitMs ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer from 1 to 500");
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new Error("waitMs must be an integer from 0 to 30000");
  const paths = runPaths(cwd, runId);
  const deadline = Date.now() + waitMs;
  let events;
  let state;
  do {
    events = await readEvents(paths);
    state = await readJson(paths.state);
    if (state.progressUpdates !== true) {
      throw new Error("Progress updates are disabled for this run; start or resume it with progressUpdates=true after an explicit user request");
    }
    if (events.length > cursor || TERMINAL_STATES.has(state.state) || Date.now() >= deadline) break;
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  } while (true);
  const selected = events.slice(cursor, cursor + limit);
  return {
    runId,
    state: state.state,
    events: selected,
    nextCursor: cursor + selected.length,
    hasMore: events.length > cursor + selected.length,
    progress: workflowProgress(state),
    runDirectory: paths.directory,
  };
}

export async function workflowWait(params) {
  assertObject(params, "wait arguments");
  const cwd = resolve(params.cwd ?? process.cwd());
  const runId = safeRunId(params.runId);
  const waitMs = params.waitMs ?? 50000;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 55000) {
    throw new Error("waitMs must be an integer from 0 to 55000");
  }
  const paths = runPaths(cwd, runId);
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  let state;
  do {
    state = await readJson(paths.state);
    if (TERMINAL_STATES.has(state.state) || Date.now() >= deadline) break;
    await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
  } while (true);

  const terminal = TERMINAL_STATES.has(state.state);
  return {
    runId,
    state: state.state,
    terminal,
    waitedMs: Date.now() - startedAt,
    activeInThisServer: activeRuns.has(`${cwd}\u0000${runId}`),
    ...(terminal && state.state === "completed" ? { result: state.result ?? null } : {}),
    ...(terminal && state.state === "failed" ? { error: state.error ?? "Workflow failed" } : {}),
    ...(terminal && state.state === "stopped" ? { error: state.error ?? "Workflow stopped" } : {}),
    runDirectory: paths.directory,
  };
}

const TOOLS = [
  {
    name: "workflow_run",
    description: "Run a deterministic Codex workflow. Background execution defaults to true; use workflow_wait for token-efficient terminal waiting. Live progress remains explicit opt-in.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        script: { type: "string" },
        scriptPath: { type: "string" },
        args: {},
        cwd: { type: "string" },
        runId: { type: "string" },
        concurrency: { type: "integer", minimum: 1, maximum: 16, default: 4 },
        model: { type: "string" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"], default: "workspace-write" },
        approvalPolicy: { type: "string", enum: ["on-request", "never"], default: "never" },
        reasoningEffort: { type: "string" },
        retention: {
          type: "object",
          additionalProperties: false,
          properties: {
            olderThanDays: { type: "integer", minimum: 0 },
            maxTerminalRuns: { type: "integer", minimum: 0 }
          },
          description: "Optional best-effort cleanup policy for terminal runs, applied before launch."
        },
        background: { type: "boolean", default: true, description: "Return a runId immediately instead of risking the 300-second foreground tool timeout." },
        progressUpdates: { type: "boolean", default: false, description: "Enable workflow_events. Use only when the user explicitly requests progress updates." }
      },
      oneOf: [{ required: ["script"] }, { required: ["scriptPath"] }]
    }
  },
  {
    name: "workflow_run_guided",
    description: "Run a workflow from a declarative list of subagents. Designed for a conversational setup wizard: no JavaScript authoring is required, and every subagent may use a different Codex model.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "goal", "tasks"],
      properties: {
        name: { type: "string", minLength: 1 },
        goal: { type: "string", minLength: 1 },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "prompt"],
            properties: {
              id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
              label: { type: "string" },
              prompt: { type: "string", minLength: 1 },
              model: { type: "string", description: "Exact Codex model ID for this subagent; omit to use defaultModel or the user's Codex default." },
              sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
              approvalPolicy: { type: "string", enum: ["on-request", "never"] },
              reasoningEffort: { type: "string" },
              outputSchema: { type: "object" },
              retries: { type: "integer", minimum: 0, maximum: 255 },
              timeoutMs: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }
            }
          }
        },
        defaultModel: { type: "string", description: "Fallback model for subagents and synthesis without an explicit model." },
        synthesis: {
          description: "Omit or set true for a final synthesis agent, false to return raw reports, or provide its configuration.",
          anyOf: [
            { type: "boolean" },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                prompt: { type: "string" },
                label: { type: "string" },
                model: { type: "string" },
                sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
                approvalPolicy: { type: "string", enum: ["on-request", "never"] },
                reasoningEffort: { type: "string" },
                outputSchema: { type: "object" },
                retries: { type: "integer", minimum: 0, maximum: 255 },
                timeoutMs: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }
              }
            }
          ]
        },
        cwd: { type: "string" },
        runId: { type: "string" },
        concurrency: { type: "integer", minimum: 1, maximum: 16, default: 4 },
        sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"], default: "workspace-write" },
        approvalPolicy: { type: "string", enum: ["on-request", "never"], default: "never" },
        reasoningEffort: { type: "string" },
        retention: {
          type: "object",
          additionalProperties: false,
          properties: {
            olderThanDays: { type: "integer", minimum: 0 },
            maxTerminalRuns: { type: "integer", minimum: 0 }
          }
        },
        background: { type: "boolean", default: true },
        progressUpdates: { type: "boolean", default: false, description: "Enable only when the user explicitly requests narrated progress." }
      }
    }
  },
  {
    name: "workflow_status",
    description: "Inspect a persisted workflow run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: { runId: { type: "string" }, cwd: { type: "string" } }
    }
  },
  {
    name: "workflow_events",
    description: "Read opt-in workflow progress events. Available only when the run was explicitly started or resumed with progressUpdates=true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string" },
        cwd: { type: "string" },
        cursor: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        waitMs: { type: "integer", minimum: 0, maximum: 30000, default: 0 }
      }
    }
  },
  {
    name: "workflow_wait",
    description: "Wait compactly for a workflow terminal state without returning progress events. Safe for token-efficient runs and bounded below the MCP host timeout.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string" },
        cwd: { type: "string" },
        waitMs: { type: "integer", minimum: 0, maximum: 55000, default: 50000 }
      }
    }
  },
  {
    name: "workflow_resume",
    description: "Resume a workflow run, reusing every completed agent result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string" },
        cwd: { type: "string" },
        background: { type: "boolean", default: true },
        expectedState: { type: "string", enum: ["running", "completed", "failed", "stopped"] },
        progressUpdates: { type: "boolean", description: "Enable or disable workflow_events for the resumed run; enable only after an explicit user request." }
      }
    }
  },
  {
    name: "workflow_retry",
    description: "Retry a failed workflow as a new durable run, reusing completed agent results and preserving lineage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Failed source run ID." },
        newRunId: { type: "string", description: "Optional stable ID for the retry child." },
        cwd: { type: "string" },
        background: { type: "boolean", default: true },
        expectedState: { type: "string", enum: ["failed"], default: "failed" },
        progressUpdates: { type: "boolean", description: "Enable progress events only after an explicit user request." }
      }
    }
  }
];

async function callTool(name, args) {
  const background = args.background !== false;
  if ((name === "workflow_run" || name === "workflow_run_guided" || name === "workflow_resume" || name === "workflow_retry") && args.progressUpdates === true && !background) {
    throw new Error("progressUpdates=true requires background=true");
  }
  if (name === "workflow_run") return background ? startWorkflow(args) : runWorkflow(args);
  if (name === "workflow_run_guided") return runGuidedWorkflow(args, background);
  if (name === "workflow_status") return workflowStatus(args);
  if (name === "workflow_events") return workflowEvents(args);
  if (name === "workflow_wait") return workflowWait(args);
  if (name === "workflow_resume") return background ? startWorkflow(args, true) : runWorkflow(args, true);
  if (name === "workflow_retry") return background ? startRetryWorkflow(args) : retryWorkflow(args);
  throw new Error(`Unknown tool "${name}"`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || message.id === undefined) return;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: SERVER,
      };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools: TOOLS };
    } else if (message.method === "tools/call") {
      const value = await callTool(message.params?.name, message.params?.arguments ?? {});
      result = { content: [{ type: "text", text: json(value) }], structuredContent: value };
    } else {
      throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: error?.code && Number.isInteger(error.code) ? error.code : -32000,
        message: error instanceof Error ? error.message : String(error),
        data: {
          ...(error?.runId ? { runId: error.runId } : {}),
          ...(error?.runDirectory ? { runDirectory: error.runDirectory } : {}),
        },
      },
    });
  }
}

function startServer() {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch (error) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } });
      }
    }
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) startServer();
