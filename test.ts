import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(
      wrapCommand("echo hi", nested),
      "devenv --no-tui -q shell -- bash -c 'echo hi'",
    );
    assert.equal(
      wrapCommand("echo 'x'", nested),
      "devenv --no-tui -q shell -- bash -c 'echo '\\''x'\\'''",
    );

    process.env.DEVENV_ROOT = tmp;
    assert.equal(
      wrapCommand("echo hi", nested),
      "devenv --no-tui -q shell -- bash -c 'echo hi'",
    );

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
