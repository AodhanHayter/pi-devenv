// End-to-end check against a real Pi session and a real devenv.
// Needs `devenv` on PATH and Nix inputs it can fetch. The fixture copies
// devenv.yaml and devenv.lock from PI_DEVENV_E2E_INPUTS (default: this repo),
// so it reuses inputs already in the Nix store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const hasDevenv = spawnSync("devenv", ["version"]).status === 0;

test("bash tool and ! run inside devenv without devenv output", {
  skip: !hasDevenv && "devenv is not on PATH",
  timeout: 600_000,
}, async () => {
  const prev = process.env.DEVENV_ROOT;
  delete process.env.DEVENV_ROOT;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-devenv-e2e-")));
  const project = join(tmp, "project");
  const nested = join(project, "nested");
  mkdirSync(nested, { recursive: true });
  const inputs = process.env.PI_DEVENV_E2E_INPUTS ?? import.meta.dirname;
  for (const file of ["devenv.yaml", "devenv.lock"]) {
    if (existsSync(join(inputs, file)))
      copyFileSync(join(inputs, file), join(project, file));
  }
  writeFileSync(
    join(project, "devenv.nix"),
    `{ ... }: {
  env.PI_DEVENV_E2E = "inside";
  enterShell = ''
    echo noisy-enter-shell
    echo noisy-enter-shell-stderr >&2
  '';
}
`,
  );

  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "bash",
          { command: `printf '%s\\n' "$PI_DEVENV_E2E"; pwd` },
          { id: "env" },
        ),
        fauxToolCall(
          "bash",
          { command: "echo failing; exit 3" },
          { id: "exit" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const agentDir = join(tmp, "agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: nested,
    agentDir,
    additionalExtensionPaths: [
      join(import.meta.dirname, "extensions/devenv.ts"),
    ],
    extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: nested,
    agentDir,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(nested),
    settingsManager: SettingsManager.inMemory({}),
  });

  try {
    await session.bindExtensions({});
    await session.prompt("go");

    const results = new Map<string, { text: string; isError: boolean }>();
    for (const message of session.messages) {
      if (message.role !== "toolResult") continue;
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      results.set(message.toolCallId, { text, isError: message.isError });
    }
    assert.deepEqual(results.get("env"), {
      text: `inside\n${nested}\n`,
      isError: false,
    });
    assert.deepEqual(results.get("exit"), {
      text: "failing\n\n\nCommand exited with code 3",
      isError: true,
    });

    const storedCommands = session.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) =>
            part.type === "toolCall" ? [part.arguments.command] : [],
          )
        : [],
    );
    assert.deepEqual(storedCommands, [
      `printf '%s\\n' "$PI_DEVENV_E2E"; pwd`,
      "echo failing; exit 3",
    ]);

    const command = 'echo "$PI_DEVENV_E2E"';
    const intercepted = await session.extensionRunner.emitUserBash({
      type: "user_bash",
      command,
      excludeFromContext: false,
      cwd: nested,
    });
    assert.ok(intercepted?.operations);
    const userBash = await session.executeBash(command, undefined, {
      operations: intercepted.operations,
    });
    assert.equal(userBash.output, "inside\n");
    assert.equal(userBash.exitCode, 0);
  } finally {
    session.dispose();
    if (prev === undefined) delete process.env.DEVENV_ROOT;
    else process.env.DEVENV_ROOT = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});
