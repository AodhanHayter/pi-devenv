import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  findDevenvRoot,
  rewriteBashToolCall,
  wrapCommand,
} from "./extensions/devenv.ts";

test("wrap only for a different devenv root", () => {
  const prev = process.env.DEVENV_ROOT;
  delete process.env.DEVENV_ROOT;
  const tmp = mkdtempSync(join(tmpdir(), "pi-devenv-"));
  const project = join(tmp, "project");
  const nested = join(project, "a", "b");
  const linked = join(tmp, "linked");
  const linkedRoot = join(tmp, "linked-root");
  mkdirSync(nested, { recursive: true });
  const canonicalProject = realpathSync(project);

  try {
    assert.equal(findDevenvRoot(tmp), null);
    assert.equal(wrapCommand("echo hi", tmp), "echo hi");

    mkdirSync(join(project, "devenv.nix"));
    assert.equal(findDevenvRoot(nested), null);
    rmSync(join(project, "devenv.nix"), { recursive: true });

    writeFileSync(join(project, "devenv.nix"), "{ }\n");
    symlinkSync(
      nested,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    symlinkSync(
      project,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(findDevenvRoot(linked), canonicalProject);
    assert.match(wrapCommand("echo hi", nested), /devenv --no-tui -q shell/);

    process.env.DEVENV_ROOT = tmp;
    assert.match(wrapCommand("echo hi", nested), /devenv --no-tui -q shell/);

    process.env.DEVENV_ROOT = project;
    assert.equal(wrapCommand("echo hi", nested), "echo hi");
    process.env.DEVENV_ROOT = linkedRoot;
    assert.equal(wrapCommand("echo hi", nested), "echo hi");
  } finally {
    if (prev === undefined) delete process.env.DEVENV_ROOT;
    else process.env.DEVENV_ROOT = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Mimics devenv 2.x: task lines on stderr, enterShell output on stdout, then
// exec of the command after `--`.
const FAKE_DEVENV = `#!/bin/sh
echo "• Running devenv:enterShell" >&2
echo "WELCOME FROM ENTERSHELL"
if [ -n "$FAKE_DEVENV_ERROR" ]; then
  echo "error: $FAKE_DEVENV_ERROR" >&2
  exit 1
fi
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`;

test("wrapped command output excludes devenv output", (t) => {
  if (process.platform === "win32") return t.skip("devenv needs a Unix shell");
  const prev = process.env.DEVENV_ROOT;
  delete process.env.DEVENV_ROOT;
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-devenv-")));
  const bin = join(tmp, "bin");
  const project = join(tmp, "project");
  const scratch = join(tmp, "scratch");
  mkdirSync(bin);
  mkdirSync(project);
  mkdirSync(scratch);
  writeFileSync(join(project, "devenv.nix"), "{ }\n");
  writeFileSync(join(bin, "devenv"), FAKE_DEVENV);
  chmodSync(join(bin, "devenv"), 0o755);

  // `prefix` mirrors Pi's shellCommandPrefix, which runs before the wrapper.
  const run = (command: string, devenvError = "", prefix = "") => {
    const script = `${prefix}\n${wrapCommand(command, project)}`;
    const result = spawnSync("bash", ["-c", script], {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        TMPDIR: scratch,
        FAKE_DEVENV_ERROR: devenvError,
      },
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  };

  try {
    assert.deepEqual(run("echo out; echo err >&2"), {
      stdout: "out\n",
      stderr: "err\n",
      status: 0,
    });
    assert.deepEqual(run(`printf '%s\\n' "it's" '$HOME'; exit 3`), {
      stdout: "it's\n$HOME\n",
      stderr: "",
      status: 3,
    });
    assert.equal(run("# comment\npwd").stdout, `${project}\n`);
    assert.equal(
      run("{ true >&3; } 2>/dev/null && echo open || echo closed").stdout,
      "closed\n",
    );

    for (const prefix of ["", "set -e"]) {
      const failed = run("echo no", "undefined variable 'bar'", prefix);
      assert.equal(failed.stdout, "");
      assert.match(failed.stderr, /error: undefined variable 'bar'/);
      assert.equal(failed.status, 1);
    }

    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    if (prev === undefined) delete process.env.DEVENV_ROOT;
    else process.env.DEVENV_ROOT = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("do not rewrite an extension-owned bash tool", () => {
  const event: BashToolCallEvent = {
    type: "tool_call",
    toolCallId: "test",
    toolName: "bash",
    input: { command: "echo hi" },
  };

  rewriteBashToolCall(event, process.cwd(), [
    { name: "bash", sourceInfo: { source: "test-extension" } },
  ]);

  assert.equal(event.input.command, "echo hi");
});
