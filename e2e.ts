// End-to-end check against a real Pi session and a real devenv.
// Needs `devenv` (2.1 or later) on PATH and Nix inputs it can fetch. The
// fixture copies devenv.yaml and devenv.lock from PI_DEVENV_E2E_INPUTS
// (default: this repo), so it reuses inputs already in the Nix store. Trust
// decisions go to a temporary DEVENV_HOME, not your real allow list.
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
import { startSession } from "./testing/pi-session.ts";

const hasDevenv = spawnSync("devenv", ["version"]).status === 0;

test("Pi runs commands in a real devenv shell and briefs the model", {
  skip: !hasDevenv && "devenv is not on PATH",
  timeout: 600_000,
}, async (t) => {
  const saved = {
    DEVENV_ROOT: process.env.DEVENV_ROOT,
    DEVENV_HOME: process.env.DEVENV_HOME,
  };
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-devenv-e2e-")));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  delete process.env.DEVENV_ROOT;
  process.env.DEVENV_HOME = join(tmp, "devenv-home");

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
    `{ pkgs, ... }: {
  packages = [ pkgs.hello ];
  env.PI_DEVENV_E2E = "inside";
  scripts.greet.exec = "hello";
  scripts.greet.description = "Say hello";
  processes.sleeper.exec = "sleep 1000";
  enterShell = ''
    echo noisy-enter-shell
    echo noisy-enter-shell-stderr >&2
  '';
}
`,
  );

  const pi = await startSession(nested, join(tmp, "agent"), () => "Allow");
  t.after(() => pi.session.dispose());

  const envCommand = `printf '%s\\n' "$PI_DEVENV_E2E"; pwd`;
  assert.deepEqual(
    await pi.prompt([envCommand, "greet", "echo failing; exit 3"]),
    [
      { text: `inside\n${nested}\n`, isError: false },
      { text: "Hello, world!\n", isError: false },
      { text: "failing\n\n\nCommand exited with code 3", isError: true },
    ],
  );
  assert.equal(pi.asked.length, 1);

  const briefing = pi.systemPrompts[0];
  assert.match(briefing, /\n## Devenv\n/);
  assert.match(briefing, /Packages: .*hello-\d/);
  assert.match(briefing, /Scripts \(run by name\): greet \(Say hello\)\n/);
  assert.match(briefing, /Processes: sleeper\n/);

  const storedCommands = pi.session.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "toolCall" ? [part.arguments.command] : [],
        )
      : [],
  );
  assert.deepEqual(storedCommands, [
    envCommand,
    "greet",
    "echo failing; exit 3",
  ]);

  assert.deepEqual(await pi.userBash('echo "$PI_DEVENV_E2E"'), {
    output: "inside\n",
    exitCode: 0,
  });
});
