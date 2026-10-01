// Does the devenv briefing change what a real model does?
//
//   pnpm eval [--model provider/id] [--trials 3] [--scenario name] [--timeout 300]
//
// Runs each scenario with the briefing and without it (control), using your
// Pi model configuration. This spends tokens on the chosen model.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SCENARIOS } from "./scenarios.ts";
import { type Arm, runTrial, type TrialResult } from "./trial.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    trials: { type: "string", default: "3" },
    scenario: { type: "string" },
    timeout: { type: "string", default: "300" },
  },
});

const root = join(import.meta.dirname, "..");
const modelRuntime = await ModelRuntime.create();
const settings = SettingsManager.create(root, getAgentDir());
const [provider, ...rest] = (
  values.model ??
  `${settings.getDefaultProvider() ?? ""}/${settings.getDefaultModel() ?? ""}`
).split("/");
const model = modelRuntime.getModel(provider, rest.join("/"));
if (!model) {
  console.error(
    `Model "${provider}/${rest.join("/")}" not found. Pass --model provider/id or set a default model in Pi.`,
  );
  process.exit(1);
}

if (!(await modelRuntime.getAuth(model))) {
  console.error(
    `No credentials for ${model.provider}. Log in with Pi (/login) or set the provider's API key.`,
  );
  process.exit(1);
}

const scenarios = SCENARIOS.filter(
  (scenario) => !values.scenario || scenario.name === values.scenario,
);
const trials = Number(values.trials);
const arms: Arm[] = ["briefing", "control"];
const results: TrialResult[] = [];

for (const scenario of scenarios) {
  if (
    scenario.hostTool &&
    spawnSync("sh", ["-c", `command -v ${scenario.hostTool}`]).status === 0
  )
    console.warn(
      `! ${scenario.name}: ${scenario.hostTool} is already on PATH, so this scenario cannot show whether the model adds it to devenv.nix.`,
    );
  for (let trial = 1; trial <= trials; trial++) {
    for (const arm of arms) {
      const result = await runTrial(
        scenario,
        arm,
        {
          model,
          modelRuntime,
          thinkingLevel: settings.getDefaultThinkingLevel(),
        },
        { inputs: root, timeoutMs: Number(values.timeout) * 1000 },
      );
      results.push(result);
      const flags = Object.entries(result.outcome)
        .map(([key, value]) => `${key}=${value ? "yes" : "no"}`)
        .join(" ");
      console.log(
        `${scenario.name} #${trial} ${arm}: ${flags}${result.error ? ` error=${result.error}` : ""} (${Math.round(result.durationMs / 1000)}s)`,
      );
      for (const command of result.commands)
        console.log(`    $ ${command.split("\n")[0]}`);
    }
  }
}

console.log(`\nModel: ${model.provider}/${model.id}\n`);
console.log("| scenario | metric | briefing | control |");
console.log("| --- | --- | --- | --- |");
for (const scenario of scenarios) {
  const metrics = Object.keys(
    results.find((r) => r.scenario === scenario.name)?.outcome ?? {},
  );
  for (const metric of metrics) {
    const cell = (arm: Arm) => {
      const runs = results.filter(
        (r) => r.scenario === scenario.name && r.arm === arm,
      );
      return `${runs.filter((r) => r.outcome[metric]).length}/${runs.length}`;
    };
    console.log(
      `| ${scenario.name} | ${metric} | ${cell("briefing")} | ${cell("control")} |`,
    );
  }
}

const out = join(root, "eval-results");
mkdirSync(out, { recursive: true });
const file = join(out, `${new Date().toISOString().replaceAll(":", "-")}.json`);
writeFileSync(
  file,
  `${JSON.stringify({ model: `${model.provider}/${model.id}`, results }, null, 2)}\n`,
);
console.log(`\nWrote ${file}`);
