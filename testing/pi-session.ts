// A real Pi AgentSession with this extension loaded and a scripted (faux)
// model, shared by the hermetic tests and the end-to-end test.
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export interface UserBashOutcome {
  output: string;
  exitCode: number | undefined;
}

export interface TestSession {
  session: AgentSession;
  /** System prompt sent to the model for each `prompt()` call. */
  systemPrompts: string[];
  /** Titles of `ctx.ui.select` dialogs the extension opened. */
  asked: string[];
  /** One model turn that calls bash with each command, in parallel. */
  prompt(commands: readonly string[]): Promise<ToolOutcome[]>;
  /** A user `!` command, routed through the extension's user_bash handler. */
  userBash(command: string): Promise<UserBashOutcome>;
}

/**
 * `choose` answers the extension's select dialogs; without it the session has
 * no UI, like `pi -p`.
 */
export async function startSession(
  cwd: string,
  agentDir: string,
  choose?: (title: string) => string | undefined,
): Promise<TestSession> {
  const faux = fauxProvider();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [
      join(import.meta.dirname, "../extensions/devenv.ts"),
    ],
    extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({}),
  });

  const asked: string[] = [];
  if (choose) {
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        select: async (title) => {
          asked.push(title);
          return choose(title);
        },
      },
    });
  } else {
    await session.bindExtensions({});
  }

  const systemPrompts: string[] = [];
  let turn = 0;
  return {
    session,
    systemPrompts,
    asked,
    async prompt(commands) {
      turn += 1;
      const ids = commands.map((_, i) => `t${turn}-${i}`);
      faux.setResponses([
        (context) => {
          systemPrompts.push(context.systemPrompt ?? "");
          return fauxAssistantMessage(
            commands.map((command, i) =>
              fauxToolCall("bash", { command }, { id: ids[i] }),
            ),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("done"),
      ]);
      await session.prompt("go");

      const outcomes = new Map<string, ToolOutcome>();
      for (const message of session.messages) {
        if (message.role !== "toolResult") continue;
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        outcomes.set(message.toolCallId, { text, isError: message.isError });
      }
      return ids.map(
        (id) => outcomes.get(id) ?? { text: "missing", isError: true },
      );
    },
    async userBash(command) {
      const intercepted = await session.extensionRunner.emitUserBash({
        type: "user_bash",
        command,
        excludeFromContext: false,
        cwd,
      });
      const result = await session.executeBash(command, undefined, {
        operations: intercepted?.operations,
      });
      return { output: result.output, exitCode: result.exitCode };
    },
  };
}
