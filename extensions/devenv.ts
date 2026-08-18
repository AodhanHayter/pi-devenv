import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Walk up from `start` for devenv.nix — same rule as devenv's find_project_root. */
export function findDevenvRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "devenv.nix"))) return dir;
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
  if (process.env.DEVENV_ROOT) return command;
  if (!findDevenvRoot(cwd)) return command;
  // ponytail: devenv shell per command; cache print-dev-env if cold start hurts
  return `devenv --no-tui -q shell -- bash -lc ${shQuote(command)}`;
}

export default async function (pi: ExtensionAPI) {
  const { createLocalBashOperations, isToolCallEventType } = await import(
    "@earendil-works/pi-coding-agent"
  );

  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (typeof event.input.command !== "string") return;
    event.input.command = wrapCommand(event.input.command, ctx.cwd);
  });

  pi.on("user_bash", () => {
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
