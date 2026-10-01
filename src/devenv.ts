import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";

function canonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Walk up from `start` for devenv.nix — same rule as devenv's find_project_root. */
export function findDevenvRoot(start: string): string | null {
  let dir = canonicalPath(start);
  if (!dir) return null;

  for (;;) {
    try {
      if (statSync(join(dir, "devenv.nix")).isFile()) return dir;
    } catch {
      // No usable marker in this directory.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when Pi itself was started inside the devenv shell for `root`. */
export function insideDevenvShell(root: string): boolean {
  return canonicalPath(process.env.DEVENV_ROOT ?? "") === root;
}

export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wrap a bash command in `devenv shell --`.
 *
 * `devenv shell` prints task lifecycle lines to stderr even with `-q`, and
 * `enterShell` output lands on stdout. The command gets the caller's
 * stdout/stderr through fds 3 and 4; devenv's own output goes to a log that
 * the inner shell deletes once it starts. A log that survives means devenv
 * failed before the command ran, so it is printed. A file, not a pipe, so
 * background jobs started by `enterShell` cannot hold the command open.
 */
export function wrapCommand(command: string): string {
  // ponytail: devenv shell per command; cache print-dev-env if cold start hurts
  const inner = `rm -f -- "$1"; set --; exec 1>&3 2>&4 3>&- 4>&-\n${command}`;
  return [
    `__pi_devenv_log=$(mktemp "\${TMPDIR:-/tmp}/pi-devenv.XXXXXX") || exit 1`,
    "__pi_devenv_status=0",
    `devenv --no-tui -q shell -- bash -c ${shQuote(inner)} bash "$__pi_devenv_log" 3>&1 4>&2 >/dev/null 2>"$__pi_devenv_log" || __pi_devenv_status=$?`,
    `if [ -e "$__pi_devenv_log" ]; then cat -- "$__pi_devenv_log" >&2; rm -f -- "$__pi_devenv_log"; fi`,
    'exit "$__pi_devenv_status"',
  ].join("\n");
}

interface DevenvRun {
  /** Exit code; null when devenv could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runDevenv(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<DevenvRun> {
  return new Promise((resolve) => {
    const child = spawn("devenv", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** First useful line of devenv's (coloured, multi-line) error output. */
export function summarizeError(output: string): string {
  const lines = stripVTControlCharacters(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const summary =
    lines.filter((line) => line.startsWith("error:")).at(-1) ??
    lines[0] ??
    "no output";
  return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
}

export type Trust =
  | { status: "allowed" }
  | { status: "not-allowed" }
  | { status: "unavailable"; reason: string };

/**
 * Ask devenv whether `root` is on its allow list (`devenv allow`), the same
 * list its shell hook uses. `hook-should-activate` is hidden but needs no Nix
 * evaluation; any answer other than the two known ones counts as unavailable.
 */
export async function checkTrust(root: string): Promise<Trust> {
  const run = await runDevenv(["hook-should-activate"], root, 10_000);
  if (run.code === 0 && canonicalPath(run.stdout.trim()) === root)
    return { status: "allowed" };
  if (run.code === 2 && run.stderr.includes("is not allowed"))
    return { status: "not-allowed" };
  return {
    status: "unavailable",
    reason: `devenv trust check failed: ${summarizeError(run.stderr || run.stdout)}`,
  };
}

export interface Script {
  name: string;
  description: string;
}

export interface Inventory {
  packages: string[];
  scripts: Script[];
  processes: string[];
}

export type InventoryResult =
  | { ok: true; inventory: Inventory }
  | { ok: false; error: string };

const EvalOutput = Type.Object({
  packages: Type.Array(Type.String()),
  scripts: Type.Record(
    Type.String(),
    Type.Object({ description: Type.String() }),
  ),
  processes: Type.Record(Type.String(), Type.Object({})),
});

/** `/nix/store/<hash>-jq-1.8.2` → `jq-1.8.2` */
function storePathName(path: string): string {
  return basename(path).replace(/^[0-9a-z]{32}-/, "");
}

export function parseInventory(json: string): InventoryResult {
  let output: unknown;
  try {
    output = JSON.parse(json);
  } catch {
    return { ok: false, error: "devenv eval printed invalid JSON" };
  }
  if (!Value.Check(EvalOutput, output))
    return { ok: false, error: "devenv eval printed unexpected JSON" };

  const scripts = Object.entries(output.scripts).map(([name, script]) => ({
    name,
    description: script.description,
  }));
  const scriptNames = new Set(scripts.map((script) => script.name));
  const packages = [
    ...new Set(
      output.packages
        .map(storePathName)
        .filter((name) => !scriptNames.has(name)),
    ),
  ];
  return {
    ok: true,
    inventory: { packages, scripts, processes: Object.keys(output.processes) },
  };
}

/** Evaluate what the environment provides; devenv's eval cache keeps this fast. */
export async function readInventory(root: string): Promise<InventoryResult> {
  const run = await runDevenv(
    ["--no-tui", "-q", "eval", "packages", "scripts", "processes"],
    root,
    300_000,
  );
  if (run.code !== 0)
    return { ok: false, error: summarizeError(run.stderr || run.stdout) };
  return parseInventory(run.stdout);
}
