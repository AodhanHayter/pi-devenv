import type { InventoryResult } from "./devenv.ts";

const MAX_PACKAGES = 40;

function list(items: readonly string[], max = items.length): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

/**
 * System prompt section for a project whose devenv shell Pi commands use.
 * Deterministic for a given environment, so it does not churn the prompt cache.
 */
export function activeBriefing(
  root: string,
  entered: boolean,
  result: InventoryResult | undefined,
): string {
  const lines = [
    "## Devenv",
    "",
    `This project's tools come from devenv (${root}/devenv.nix).`,
    entered
      ? "Pi runs inside this devenv shell, so bash commands inherit its environment. Edits to devenv.nix apply only after Pi restarts from a fresh devenv shell; until then, run `devenv shell -- <command>` to use them."
      : "Bash commands already run inside its shell, which picks up devenv.nix changes on the next command. Do not run `devenv shell` yourself.",
  ];

  if (result?.ok === false) {
    lines.push(
      "",
      `devenv.nix currently fails to evaluate, so bash commands fail until it is fixed: ${result.error}`,
    );
  }
  const inventory = result?.ok ? result.inventory : undefined;
  if (inventory) {
    lines.push("");
    if (inventory.packages.length > 0)
      lines.push(`Packages: ${list(inventory.packages, MAX_PACKAGES)}`);
    if (inventory.scripts.length > 0) {
      const scripts = inventory.scripts.map((script) =>
        script.description
          ? `${script.name} (${script.description})`
          : script.name,
      );
      lines.push(`Scripts (run by name): ${list(scripts)}`);
    }
    if (inventory.processes.length > 0)
      lines.push(`Processes: ${list(inventory.processes)}`);
  }

  lines.push(
    "",
    "- If a command is missing, add its package to `packages` in devenv.nix (for example `pkgs.ripgrep`) and use it in the next command. Do not install tools globally (brew, apt, nix profile, npm -g, pip --user, curl | sh). `devenv search <name>` finds package attribute names but takes about a minute.",
  );
  if (inventory?.scripts.length)
    lines.push(
      "- Prefer the project scripts and `devenv test` over ad-hoc equivalents.",
    );
  else lines.push("- `devenv test` runs the project's tests and git hooks.");
  if (inventory?.processes.length)
    lines.push(
      "- Start processes with `devenv up -d`, then `devenv processes wait`. Inspect them with `devenv processes list` and `devenv processes logs <name>`; stop them with `devenv down`. Never run `devenv up` without `-d`; it does not exit.",
    );
  return lines.join("\n");
}

/** System prompt section for a project whose devenv shell Pi does not use. */
export function inactiveBriefing(root: string, reason: string): string {
  return [
    "## Devenv",
    "",
    `This project has a devenv.nix at ${root}, but ${reason}, so bash commands run outside its environment and project tools may be missing. If you need them, tell the user. Do not run \`devenv allow\` yourself.`,
  ].join("\n");
}
