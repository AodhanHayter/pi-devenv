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

/** Wrap a bash command in `devenv shell --` when cwd is a devenv project. */
export function wrapCommand(command: string, cwd: string): string {
  const root = findDevenvRoot(cwd);
  if (!root || canonicalPath(process.env.DEVENV_ROOT ?? "") === root)
    return command;
  // ponytail: devenv shell per command; cache print-dev-env if cold start hurts
  return `devenv --no-tui -q shell -- bash -c ${shQuote(command)}`;
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
