import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BashToolCallEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

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

export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wrap a bash command in `devenv shell --` when cwd is a devenv project.
 *
 * `devenv shell` prints task lifecycle lines to stderr even with `-q`, and
 * `enterShell` output lands on stdout. The command gets the caller's
 * stdout/stderr through fds 3 and 4; devenv's own output goes to a log that
 * the inner shell deletes once it starts. A log that survives means devenv
 * failed before the command ran, so it is printed. A file, not a pipe, so
 * background jobs started by `enterShell` cannot hold the command open.
 */
export function wrapCommand(command: string, cwd: string): string {
  const root = findDevenvRoot(cwd);
  if (!root || canonicalPath(process.env.DEVENV_ROOT ?? "") === root)
    return command;
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

interface ToolOwnership {
  name: string;
  sourceInfo: { source: string };
}

export function rewriteBashToolCall(
  event: BashToolCallEvent,
  cwd: string,
  tools: readonly ToolOwnership[],
): void {
  const bashTool = tools.find((tool) => tool.name === "bash");
  if (bashTool && bashTool.sourceInfo.source !== "builtin") return;
  event.input.command = wrapCommand(event.input.command, cwd);
}

export default async function (pi: ExtensionAPI) {
  const { createLocalBashOperations, isToolCallEventType } = await import(
    "@earendil-works/pi-coding-agent"
  );

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    rewriteBashToolCall(event, ctx.cwd, pi.getAllTools());
  });

  pi.on("user_bash", (event) => {
    if (wrapCommand(event.command, event.cwd) === event.command) return;
    const local = createLocalBashOperations();
    return {
      operations: {
        exec(command, cwd, options) {
          return local.exec(wrapCommand(command, cwd), cwd, options);
        },
      },
    };
  });
}
