import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  isAdHocNix,
  isDetachedUp,
  isDevenvDown,
  isForegroundUp,
  isGlobalInstall,
  runsCommand,
} from "./eval/score.ts";
import { bashIsBuiltin } from "./extensions/devenv.ts";
import { activeBriefing, inactiveBriefing } from "./src/briefing.ts";
import {
  checkTrust,
  findDevenvRoot,
  insideDevenvShell,
  parseInventory,
  runDevenv,
  summarizeError,
  wrapCommand,
} from "./src/devenv.ts";
import { startSession } from "./testing/pi-session.ts";

// Mimics the devenv 2.x commands the extension uses: the allow list
// (hook-should-activate, allow, revoke), eval, and shell, which prints task
// lines on stderr and enterShell output on stdout before it execs the command.
const FAKE_DEVENV = `#!/bin/sh
here=$(pwd -P)
allowed="$FAKE_DEVENV_HOME/allowed"
case "$1" in
  hook-should-activate)
    if [ -n "$FAKE_DEVENV_OLD" ]; then
      echo "error: unrecognized subcommand 'hook-should-activate'" >&2
      exit 2
    fi
    if grep -qxF "$here" "$allowed" 2>/dev/null; then echo "$here"; exit 0; fi
    echo "devenv: $here is not allowed. Run 'devenv allow' to trust this directory." >&2
    exit 2 ;;
  allow)
    echo "$here" >> "$allowed"
    echo "devenv: allowed $here" >&2
    exit 0 ;;
esac
while [ $# -gt 0 ] && [ "$1" != shell ] && [ "$1" != eval ]; do shift; done
if [ "$1" = eval ]; then
  if [ -n "$FAKE_DEVENV_ERROR" ]; then
    printf '\\033[31m×\\033[0m Failed\\n  \\033[31;1merror:\\033[0m %s\\n' "$FAKE_DEVENV_ERROR" >&2
    exit 1
  fi
  printf '%s\\n' "$FAKE_DEVENV_EVAL"
  exit 0
fi
echo "• Running devenv:enterShell" >&2
echo "WELCOME FROM ENTERSHELL"
if [ -n "$FAKE_DEVENV_ERROR" ]; then
  echo "error: $FAKE_DEVENV_ERROR" >&2
  exit 1
fi
while [ "$1" != "--" ]; do shift; done
shift
export IN_FAKE_DEVENV=yes
exec "$@"
`;

const EVAL_OUTPUT = JSON.stringify({
  packages: [
    "/nix/store/xl1h9i29pgq2q5cszjhm5wpfxfbbqwyi-jq-1.8.2",
    "/nix/store/hjqp5h6m0xclmjfk94vjfclj1v365gif-migrate",
    "/nix/store/42rxdpix0jmlb85m1dpvjzwaiy25qm6n-python3-3.14.7-env",
  ],
  scripts: {
    migrate: { description: "Run DB migrations", exec: "echo migrating" },
    lint: { description: "", exec: "echo linting" },
  },
  processes: { web: { exec: "python -m http.server" } },
});

interface Fixture {
  root: string;
  project: string;
  agentDir: string;
  scratch: string;
  allowList: string;
}

/** Fake devenv on PATH and a project with devenv.nix; undone after the test. */
function fixture(t: TestContext): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-devenv-")));
  const bin = join(root, "bin");
  const project = join(root, "project");
  const home = join(root, "devenv-home");
  const scratch = join(root, "scratch");
  for (const dir of [bin, project, home, scratch]) mkdirSync(dir);
  writeFileSync(join(project, "devenv.nix"), "{ }\n");
  writeFileSync(join(bin, "devenv"), FAKE_DEVENV);
  chmodSync(join(bin, "devenv"), 0o755);

  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    DEVENV_ROOT: undefined,
    FAKE_DEVENV_HOME: home,
    FAKE_DEVENV_EVAL: EVAL_OUTPUT,
    FAKE_DEVENV_ERROR: undefined,
    FAKE_DEVENV_OLD: undefined,
  };
  const saved = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  t.after(() => {
    apply(saved);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    agentDir: join(root, "agent"),
    scratch,
    allowList: join(home, "allowed"),
  };
}

test("find the devenv root and detect Pi inside its shell", (t) => {
  const { root, project } = fixture(t);
  const nested = join(project, "a", "b");
  mkdirSync(nested, { recursive: true });
  const linked = join(root, "linked");
  const linkedRoot = join(root, "linked-root");
  symlinkSync(nested, linked, "dir");
  symlinkSync(project, linkedRoot, "dir");

  assert.equal(findDevenvRoot(root), null);
  mkdirSync(join(root, "dir-marker", "devenv.nix"), { recursive: true });
  assert.equal(findDevenvRoot(join(root, "dir-marker")), null);
  assert.equal(findDevenvRoot(nested), project);
  assert.equal(findDevenvRoot(linked), project);

  assert.equal(insideDevenvShell(project), false);
  process.env.DEVENV_ROOT = root;
  assert.equal(insideDevenvShell(project), false);
  process.env.DEVENV_ROOT = linkedRoot;
  assert.equal(insideDevenvShell(project), true);
});

test("wrapped command output excludes devenv output", (t) => {
  const { project, scratch } = fixture(t);

  // `prefix` mirrors Pi's shellCommandPrefix, which runs before the wrapper.
  const run = (command: string, devenvError = "", prefix = "") => {
    const result = spawnSync(
      "bash",
      ["-c", `${prefix}\n${wrapCommand(command)}`],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: scratch,
          FAKE_DEVENV_ERROR: devenvError,
        },
      },
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    };
  };

  assert.deepEqual(run("echo $IN_FAKE_DEVENV; echo err >&2"), {
    stdout: "yes\n",
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
});

test("trust follows devenv's allow list", async (t) => {
  const { project } = fixture(t);

  assert.deepEqual(await checkTrust(project), { status: "not-allowed" });
  assert.equal((await runDevenv(["allow"], project, 5_000)).code, 0);
  assert.deepEqual(await checkTrust(project), { status: "allowed" });

  process.env.FAKE_DEVENV_OLD = "1";
  assert.deepEqual(await checkTrust(project), {
    status: "unavailable",
    reason:
      "devenv trust check failed: error: unrecognized subcommand 'hook-should-activate'",
  });
});

test("parse devenv eval output", () => {
  assert.deepEqual(parseInventory(EVAL_OUTPUT), {
    ok: true,
    inventory: {
      packages: ["jq-1.8.2", "python3-3.14.7-env"],
      scripts: [
        { name: "migrate", description: "Run DB migrations" },
        { name: "lint", description: "" },
      ],
      processes: ["web"],
    },
  });
  assert.equal(parseInventory("not json").ok, false);
  assert.equal(parseInventory('{"packages": "jq"}').ok, false);
});

test("summarize devenv errors", () => {
  assert.equal(
    summarizeError(
      "\u001b[31m×\u001b[0m Failed to build\n  … while calling\n  \u001b[31;1merror:\u001b[0m undefined variable 'bar'\n",
    ),
    "error: undefined variable 'bar'",
  );
  assert.equal(summarizeError("\n  plain failure \n"), "plain failure");
  assert.equal(summarizeError(""), "no output");
});

test("briefings describe the environment and how to use it", () => {
  const inventory = parseInventory(EVAL_OUTPUT);
  const active = activeBriefing("/p", false, inventory);
  assert.match(active, /^## Devenv/);
  assert.match(active, /Packages: jq-1\.8\.2, python3-3\.14\.7-env\n/);
  assert.match(
    active,
    /Scripts \(run by name\): migrate \(Run DB migrations\), lint\n/,
  );
  assert.match(active, /Processes: web\n/);
  assert.match(active, /Do not run `devenv shell` yourself/);
  assert.match(active, /add its package to `packages` in devenv\.nix/);
  assert.match(active, /`devenv up -d`/);

  const bare = activeBriefing("/p", false, {
    ok: true,
    inventory: { packages: [], scripts: [], processes: [] },
  });
  assert.doesNotMatch(bare, /Packages:|Scripts|Processes|devenv up/);

  assert.match(
    activeBriefing("/p", true, undefined),
    /Pi runs inside this devenv shell/,
  );
  assert.match(
    activeBriefing("/p", false, { ok: false, error: "error: boom" }),
    /fails to evaluate, so bash commands fail until it is fixed: error: boom/,
  );
  assert.match(
    inactiveBriefing("/p", "devenv is not allowed for it"),
    /devenv\.nix at \/p, but devenv is not allowed for it, so bash commands run outside/,
  );
});

test("only Pi's own bash tool is rewritten", () => {
  assert.equal(bashIsBuiltin([]), true);
  assert.equal(
    bashIsBuiltin([{ name: "bash", sourceInfo: { source: "builtin" } }]),
    true,
  );
  assert.equal(
    bashIsBuiltin([{ name: "bash", sourceInfo: { source: "ssh-extension" } }]),
    false,
  );
});

test("allowed project: commands run in devenv and the prompt has a briefing", async (t) => {
  const { project, agentDir } = fixture(t);
  await runDevenv(["allow"], project, 5_000);
  const pi = await startSession(project, agentDir);
  t.after(() => pi.session.dispose());

  assert.deepEqual(await pi.prompt(['echo "in=$IN_FAKE_DEVENV"']), [
    { text: "in=yes\n", isError: false },
  ]);
  assert.match(pi.systemPrompts[0], /\n\n## Devenv\n/);
  assert.match(pi.systemPrompts[0], /Packages: jq-1\.8\.2/);
  assert.deepEqual(await pi.userBash('echo "in=$IN_FAKE_DEVENV"'), {
    output: "in=yes\n",
    exitCode: 0,
  });
});

test("project that fails to evaluate: the briefing says why", async (t) => {
  const { project, agentDir } = fixture(t);
  await runDevenv(["allow"], project, 5_000);
  process.env.FAKE_DEVENV_ERROR = "undefined variable 'bar'";
  const pi = await startSession(project, agentDir);
  t.after(() => pi.session.dispose());

  const [result] = await pi.prompt(["echo hi"]);
  assert.equal(result.isError, true);
  assert.match(result.text, /error: undefined variable 'bar'/);
  assert.match(
    pi.systemPrompts[0],
    /fails to evaluate, so bash commands fail until it is fixed: error: undefined variable 'bar'/,
  );
});

test("project not allowed, no UI: commands run outside devenv", async (t) => {
  const { project, agentDir } = fixture(t);
  const pi = await startSession(project, agentDir);
  t.after(() => pi.session.dispose());

  assert.deepEqual(await pi.prompt(['echo "in=$IN_FAKE_DEVENV"']), [
    { text: "in=\n", isError: false },
  ]);
  assert.match(pi.systemPrompts[0], /but devenv is not allowed for it/);
  assert.doesNotMatch(pi.systemPrompts[0], /Packages:/);
  assert.equal((await pi.userBash("echo $IN_FAKE_DEVENV")).output, "\n");
});

test("project not allowed, user allows it: devenv allow then wrap", async (t) => {
  const { project, agentDir, allowList } = fixture(t);
  const pi = await startSession(project, agentDir, () => "Allow");
  t.after(() => pi.session.dispose());

  assert.deepEqual(await pi.prompt(["echo $IN_FAKE_DEVENV", "echo again"]), [
    { text: "yes\n", isError: false },
    { text: "again\n", isError: false },
  ]);
  assert.match(pi.systemPrompts[0], /Packages: jq-1\.8\.2/);
  await pi.prompt(["true"]);
  assert.equal(pi.asked.length, 1);
  assert.match(pi.asked[0], new RegExp(`devenv shell for ${project}\\?`));
  assert.equal(readFileSync(allowList, "utf8"), `${project}\n`);
});

test("project not allowed, user declines: asked once, commands run outside", async (t) => {
  const { project, agentDir } = fixture(t);
  const pi = await startSession(project, agentDir, () => "Not now");
  t.after(() => pi.session.dispose());

  assert.deepEqual(await pi.prompt(["echo $IN_FAKE_DEVENV"]), [
    { text: "\n", isError: false },
  ]);
  assert.equal((await pi.userBash("echo $IN_FAKE_DEVENV")).output, "\n");
  await pi.prompt(["true"]);
  assert.equal(pi.asked.length, 1);
  assert.match(pi.systemPrompts[1], /but devenv is not allowed for it/);
});

test("eval classifies the commands a model ran", () => {
  for (const command of [
    "brew install shellcheck",
    "sudo apt-get install -y shellcheck",
    "npm install --save-dev x && npm i -g shellcheck",
    "pip install shellcheck-py",
    "python3 -m pip install shellcheck-py",
    "nix profile install nixpkgs#shellcheck",
    "curl -fsSL https://example.com/install.sh | bash",
  ])
    assert.equal(isGlobalInstall(command), true, command);
  for (const command of [
    "npm install",
    "echo 'brew install x'",
    "uv pip list",
    "shellcheck deploy.sh",
  ])
    assert.equal(isGlobalInstall(command), false, command);

  assert.equal(
    isAdHocNix("nix-shell -p shellcheck --run 'shellcheck x'"),
    true,
  );
  assert.equal(isAdHocNix("nix run nixpkgs#shellcheck -- x"), true);
  assert.equal(isAdHocNix("nix flake check"), false);

  assert.equal(isForegroundUp("devenv up"), true);
  assert.equal(isForegroundUp("cd x && devenv processes up web"), true);
  assert.equal(isForegroundUp("devenv up -d && devenv processes wait"), false);
  assert.equal(isDetachedUp("devenv up --detach"), true);
  assert.equal(isDetachedUp("devenv up"), false);
  assert.equal(isDevenvDown("devenv processes stop; devenv down"), true);
  assert.equal(isDevenvDown("devenv up -d"), false);

  assert.equal(runsCommand("migrate", "migrate"), true);
  assert.equal(runsCommand("cd /p && migrate --dry-run", "migrate"), true);
  assert.equal(runsCommand("python migrate.py", "migrate"), false);
});
