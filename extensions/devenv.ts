import { setTimeout as delay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { activeBriefing, inactiveBriefing } from "../src/briefing.ts";
import {
  checkTrust,
  findDevenvRoot,
  type InventoryResult,
  insideDevenvShell,
  readInventory,
  runDevenv,
  summarizeError,
  wrapCommand,
} from "../src/devenv.ts";

const ALLOW = "Allow";
const NOT_NOW = "Not now";
/** How long a prompt waits for `devenv eval` before using the last result. */
const BRIEFING_WAIT_MS = 10_000;
const NOT_ALLOWED =
  "devenv is not allowed for it (the user can run `/devenv allow`)";

/**
 * - entered: Pi already runs inside this project's devenv shell.
 * - allowed: Pi wraps commands in the devenv shell.
 * - inactive: commands run outside devenv, for `reason`.
 */
type Activation =
  | { root: string; mode: "entered" | "allowed" }
  | { root: string; mode: "inactive"; reason: string };

interface ToolOwnership {
  name: string;
  sourceInfo: { source: string };
}

/** Only Pi's own bash tool is rewritten; an extension-owned one runs as is. */
export function bashIsBuiltin(tools: readonly ToolOwnership[]): boolean {
  const bashTool = tools.find((tool) => tool.name === "bash");
  return !bashTool || bashTool.sourceInfo.source === "builtin";
}

export default async function (pi: ExtensionAPI) {
  const { createLocalBashOperations, isToolCallEventType } = await import(
    "@earendil-works/pi-coding-agent"
  );

  /** Roots the user declined (or revoked) this session; not asked again. */
  const declined = new Set<string>();
  const prompts = new Map<string, Promise<boolean>>();
  const warned = new Set<string>();
  const evaluations = new Map<string, Promise<InventoryResult>>();
  const lastInventory = new Map<string, InventoryResult>();

  async function askToAllow(
    root: string,
    ctx: ExtensionContext,
  ): Promise<boolean> {
    const choice = await ctx.ui.select(
      `Run Pi commands in the devenv shell for ${root}?\nThis evaluates devenv.nix, runs its enterShell, and adds the directory to devenv's allow list (devenv allow).`,
      [ALLOW, NOT_NOW],
    );
    if (choice === ALLOW) {
      const run = await runDevenv(["allow"], root, 30_000);
      if (run.code === 0) return true;
      ctx.ui.notify(
        `devenv allow failed: ${summarizeError(run.stderr)}`,
        "error",
      );
    }
    declined.add(root);
    return false;
  }

  async function activate(
    cwd: string,
    ctx: ExtensionContext,
  ): Promise<Activation | null> {
    const root = findDevenvRoot(cwd);
    if (!root) return null;
    if (insideDevenvShell(root)) return { root, mode: "entered" };

    const trust = await checkTrust(root);
    if (trust.status === "allowed") return { root, mode: "allowed" };
    if (trust.status === "unavailable") {
      if (!warned.has(root)) {
        warned.add(root);
        ctx.ui.notify(`pi-devenv: ${trust.reason}`, "warning");
      }
      return { root, mode: "inactive", reason: trust.reason };
    }
    if (ctx.hasUI && !declined.has(root)) {
      let prompt = prompts.get(root);
      if (!prompt) {
        prompt = askToAllow(root, ctx).finally(() => prompts.delete(root));
        prompts.set(root, prompt);
      }
      if (await prompt) return { root, mode: "allowed" };
    }
    return { root, mode: "inactive", reason: NOT_ALLOWED };
  }

  /** Fresh inventory if devenv answers quickly, else the last one seen. */
  async function inventory(root: string): Promise<InventoryResult | undefined> {
    let pending = evaluations.get(root);
    if (!pending) {
      pending = readInventory(root)
        .then((result) => {
          lastInventory.set(root, result);
          return result;
        })
        .finally(() => evaluations.delete(root));
      evaluations.set(root, pending);
    }
    const wait = new AbortController();
    const waited = delay(BRIEFING_WAIT_MS, undefined, {
      signal: wait.signal,
    }).catch(() => undefined);
    const result = await Promise.race([pending, waited]);
    wait.abort();
    return result ?? lastInventory.get(root);
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const activation = await activate(ctx.cwd, ctx);
    if (!activation) return;
    const briefing =
      activation.mode === "inactive"
        ? inactiveBriefing(activation.root, activation.reason)
        : activeBriefing(
            activation.root,
            activation.mode === "entered",
            await inventory(activation.root),
          );
    return { systemPrompt: `${event.systemPrompt}\n\n${briefing}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!bashIsBuiltin(pi.getAllTools())) return;
    const activation = await activate(ctx.cwd, ctx);
    if (activation?.mode === "allowed")
      event.input.command = wrapCommand(event.input.command);
  });

  pi.on("user_bash", async (event, ctx) => {
    const activation = await activate(event.cwd, ctx);
    if (activation?.mode !== "allowed") return;
    const local = createLocalBashOperations();
    return {
      operations: {
        exec(command, cwd, options) {
          return local.exec(wrapCommand(command), cwd, options);
        },
      },
    };
  });

  pi.registerCommand("devenv", {
    description: "Show devenv status, or allow/revoke devenv for this project",
    getArgumentCompletions: (prefix: string) => {
      const items = ["status", "allow", "revoke"]
        .filter((action) => action.startsWith(prefix))
        .map((action) => ({ value: action, label: action }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const root = findDevenvRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify(
          "No devenv.nix in this directory or its parents.",
          "info",
        );
        return;
      }
      const action = args.trim() || "status";

      if (action === "allow" || action === "revoke") {
        const run = await runDevenv([action], root, 30_000);
        if (run.code !== 0) {
          ctx.ui.notify(
            `devenv ${action} failed: ${summarizeError(run.stderr)}`,
            "error",
          );
          return;
        }
        if (action === "allow") declined.delete(root);
        else declined.add(root);
        ctx.ui.notify(summarizeError(run.stderr || run.stdout), "info");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /devenv [status|allow|revoke]", "warning");
        return;
      }

      let commands = "run inside the devenv shell Pi was started in";
      if (!insideDevenvShell(root)) {
        const trust = await checkTrust(root);
        if (trust.status === "allowed") commands = "run in the devenv shell";
        else if (trust.status === "not-allowed")
          commands = "run outside devenv (not allowed; /devenv allow)";
        else commands = `run outside devenv (${trust.reason})`;
      }
      ctx.ui.notify(`devenv project: ${root}\nCommands ${commands}.`, "info");
    },
  });
}
