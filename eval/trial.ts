import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  isToolCallEventType,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { runDevenv } from "../src/devenv.ts";
import { FIXTURE_FILES, type Scenario } from "./scenarios.ts";
import { isGlobalInstall } from "./score.ts";

/** `briefing`: the extension as shipped. `control`: same, minus the briefing. */
export type Arm = "briefing" | "control";

export interface TrialResult {
  scenario: string;
  arm: Arm;
  commands: string[];
  outcome: Record<string, boolean>;
  /** Set when the session failed or ran out of time. */
  error?: string;
  durationMs: number;
}

export interface TrialModel {
  model: Model<Api>;
  modelRuntime?: ModelRuntime;
  thinkingLevel?: ReturnType<SettingsManager["getDefaultThinkingLevel"]>;
}

/** Global installs would change the machine running the eval; refuse them. */
const guard: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event) => {
    if (
      isToolCallEventType("bash", event) &&
      isGlobalInstall(event.input.command)
    )
      return {
        block: true,
        reason:
          "Blocked: installing software globally or with sudo is not allowed on this machine.",
      };
  });
};

/** Control arm: drop the `## Devenv` section the extension appends. */
const stripBriefing: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event) => {
    const start = event.systemPrompt.indexOf("\n\n## Devenv\n");
    if (start !== -1)
      return { systemPrompt: event.systemPrompt.slice(0, start) };
  });
};

export interface TrialOptions {
  /** devenv.yaml and devenv.lock are copied from here. */
  inputs: string;
  timeoutMs: number;
  /** Extra extensions, e.g. a faux provider for dry runs. */
  extensionFactories?: ExtensionFactory[];
}

export async function runTrial(
  scenario: Scenario,
  arm: Arm,
  trialModel: TrialModel,
  options: TrialOptions,
): Promise<TrialResult> {
  const started = Date.now();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-devenv-eval-")));
  const project = join(tmp, "project");
  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  for (const file of ["devenv.yaml", "devenv.lock"]) {
    if (existsSync(join(options.inputs, file)))
      copyFileSync(join(options.inputs, file), join(project, file));
  }

  const saved = {
    DEVENV_HOME: process.env.DEVENV_HOME,
    DEVENV_ROOT: process.env.DEVENV_ROOT,
  };
  process.env.DEVENV_HOME = join(tmp, "devenv-home");
  delete process.env.DEVENV_ROOT;

  const agentDir = join(tmp, "agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [
      join(import.meta.dirname, "../extensions/devenv.ts"),
    ],
    extensionFactories: [
      ...(options.extensionFactories ?? []),
      guard,
      ...(arm === "control" ? [stripBriefing] : []),
    ],
  });

  let error: string | undefined;
  let commands: string[] = [];
  let outputs: string[] = [];
  let processesRunning = false;
  try {
    const allowed = await runDevenv(["allow"], project, 30_000);
    if (allowed.code !== 0) throw new Error(`devenv allow: ${allowed.stderr}`);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: project,
      agentDir,
      model: trialModel.model,
      modelRuntime: trialModel.modelRuntime,
      thinkingLevel: trialModel.thinkingLevel,
      resourceLoader,
      sessionManager: SessionManager.inMemory(project),
      settingsManager: SettingsManager.inMemory({}),
    });
    try {
      await session.bindExtensions({});
      const timer = setTimeout(() => {
        error = `timed out after ${options.timeoutMs / 1000}s`;
        void session.abort();
      }, options.timeoutMs);
      try {
        await session.prompt(scenario.prompt);
      } finally {
        clearTimeout(timer);
      }
      for (const message of session.messages) {
        if (message.role === "assistant") {
          for (const part of message.content)
            if (part.type === "toolCall" && part.name === "bash")
              commands.push(String(part.arguments.command));
          if (message.stopReason === "error")
            error ??= message.errorMessage ?? "model error";
        }
        if (message.role === "toolResult" && message.toolName === "bash")
          outputs.push(
            message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
          );
      }
    } finally {
      session.dispose();
    }
    const list = await runDevenv(["processes", "list"], project, 60_000);
    processesRunning = list.code === 0;
  } catch (cause) {
    error ??= cause instanceof Error ? cause.message : String(cause);
  } finally {
    await runDevenv(["down"], project, 60_000);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const outcome = scenario.score({
    project,
    commands,
    outputs,
    processesRunning,
  });
  rmSync(tmp, { recursive: true, force: true });
  commands = commands.map((command) => command.slice(0, 500));
  outputs = [];
  return {
    scenario: scenario.name,
    arm,
    commands,
    outcome,
    error,
    durationMs: Date.now() - started,
  };
}
