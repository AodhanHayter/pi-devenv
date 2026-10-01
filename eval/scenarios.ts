import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isAdHocNix,
  isDetachedUp,
  isDevenvDown,
  isForegroundUp,
  isGlobalInstall,
  runsCommand,
} from "./score.ts";

/** What a trial left behind, for scoring. */
export interface TrialRun {
  project: string;
  /** Bash commands as the model wrote them. */
  commands: string[];
  /** Text of every bash result. */
  outputs: string[];
  /** Whether devenv processes were still running when the model finished. */
  processesRunning: boolean;
}

export interface Scenario {
  name: string;
  prompt: string;
  /** Host command that makes the scenario inconclusive if already on PATH. */
  hostTool?: string;
  /** Behaviours to report. `success` means the task itself got done. */
  score(run: TrialRun): Record<string, boolean>;
}

export const HEALTH_TOKEN = "pi-devenv-eval-web-ok";
const MIGRATED = ".migrations-applied";

/** The fixture project: devenv.nix plus the files the scenarios use. */
export const FIXTURE_FILES = {
  "devenv.nix": `{ pkgs, ... }:
{
  languages.python.enable = true;

  scripts.migrate.exec = "python migrate.py";
  scripts.migrate.description = "Apply pending database migrations";

  processes.web.exec = "python -m http.server 8137 --directory public";
}
`,
  "migrate.py": `from pathlib import Path

Path("${MIGRATED}").write_text("3\\n")
print("applied 3 migrations")
`,
  "deploy.sh": `#!/bin/sh
for f in $(ls *.txt); do
  echo $f
done
cd $1
`,
  "public/health.txt": `${HEALTH_TOKEN}\n`,
  "README.md": "# Inventory service\n\nA small Python service.\n",
};

export const SCENARIOS: Scenario[] = [
  {
    name: "migrate",
    prompt: "Apply the pending database migrations.",
    score: (run) => ({
      success: existsSync(join(run.project, MIGRATED)),
      usedProjectScript: run.commands.some((c) => runsCommand(c, "migrate")),
    }),
  },
  {
    name: "missing-tool",
    prompt:
      "Run shellcheck on deploy.sh and tell me what it reports. Don't change deploy.sh.",
    hostTool: "shellcheck",
    score: (run) => ({
      success: run.outputs.some((output) => /SC\d{4}/.test(output)),
      addedToDevenvNix: readFileSync(
        join(run.project, "devenv.nix"),
        "utf8",
      ).includes("shellcheck"),
      adHocNix: run.commands.some(isAdHocNix),
      globalInstall: run.commands.some(isGlobalInstall),
    }),
  },
  {
    name: "service",
    prompt:
      "Start the web server, confirm it serves health.txt, then shut it down.",
    score: (run) => ({
      success: run.outputs.some((output) => output.includes(HEALTH_TOKEN)),
      detachedUp: run.commands.some(isDetachedUp),
      foregroundUp: run.commands.some(isForegroundUp),
      stopped: run.commands.some(isDevenvDown) && !run.processesRunning,
    }),
  },
];
