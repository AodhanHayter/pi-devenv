import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findDevenvRoot, wrapCommand } from "./extensions/devenv.ts";

test("wrap only when devenv.nix is present", () => {
  const prev = process.env.DEVENV_ROOT;
  delete process.env.DEVENV_ROOT;
  const tmp = mkdtempSync(join(tmpdir(), "pi-devenv-"));
  const nested = join(tmp, "a", "b");
  mkdirSync(nested, { recursive: true });

  try {
    assert.equal(findDevenvRoot(tmp), null);
    assert.equal(wrapCommand("echo hi", tmp), "echo hi");

    writeFileSync(join(tmp, "devenv.nix"), "{ }\n");
    assert.equal(findDevenvRoot(nested), tmp);
    assert.equal(
      wrapCommand("echo hi", nested),
      "devenv --no-tui -q shell -- bash -lc 'echo hi'",
    );
    assert.equal(
      wrapCommand("echo 'x'", nested),
      "devenv --no-tui -q shell -- bash -lc 'echo '\\''x'\\'''",
    );

    process.env.DEVENV_ROOT = "/already";
    assert.equal(wrapCommand("echo hi", nested), "echo hi");
  } finally {
    if (prev === undefined) delete process.env.DEVENV_ROOT;
    else process.env.DEVENV_ROOT = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});
