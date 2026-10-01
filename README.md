# pi-devenv

Pi extension for [Devenv](https://devenv.sh) projects. When an ancestor of the working directory has `devenv.nix`, the extension:

- runs the agent's `bash` tool and `!` commands in `devenv --no-tui -q shell --`;
- tells the model what the environment provides and how to extend it;
- runs a project's Devenv code only after you allow the project.

The agent stays outside the Devenv process. `devenv` 2.1 or later must be on `PATH`.

## Install

Run this command from the checkout root:

```bash
pi install .
```

Use `/reload`, or start a new session, after installation.

## Trust

Devenv evaluates `devenv.nix` and runs `enterShell` code. The extension does this only for projects on Devenv's allow list, the same list that `devenv allow` and Devenv's shell hook use. A project you already allowed for the shell hook works without a prompt.

For a project that is not on the list, Pi asks once per session whether to allow it. **Allow** runs `devenv allow`. **Not now** keeps commands outside Devenv for the session. Without a UI, for example with `pi -p`, commands run outside Devenv until you run `devenv allow` in the project.

The allow list stores directories. Devenv does not ask again after `devenv.nix` changes.

## Commands

- `/devenv` or `/devenv status` shows the project root and where commands run.
- `/devenv allow` adds the project to Devenv's allow list.
- `/devenv revoke` removes it. Pi does not ask again in that session.

## Model briefing

Before each prompt, the extension appends a `## Devenv` section to the system prompt. The section comes from `devenv eval packages scripts processes`, which Devenv caches. It lists:

- the packages, scripts, and processes the environment provides;
- an instruction to add missing tools to `packages` in `devenv.nix`, not to install them globally;
- the commands that start, inspect, and stop processes without blocking (`devenv up -d`, `devenv processes`, `devenv down`).

A command runs in a fresh Devenv shell, so a package that the agent adds is available in the next command. If `devenv.nix` does not evaluate, the section includes the error. If evaluation takes more than 10 seconds, the prompt uses the last result. For a project that is not allowed, the section says that commands run outside Devenv.

## Command output

Command output contains only the command's own stdout and stderr. Devenv prints task progress lines even with `-q`, and `enterShell` output lands on stdout; the wrapper discards both. If Devenv fails before the command starts, for example on an evaluation error, the wrapper prints Devenv's output and exits with its status.

The bash call display stays the original command. The session stores the original LLM arguments. The wrapper changes execution only.

## Compatibility

If Pi starts inside the project's Devenv shell (`DEVENV_ROOT` matches the project), commands are not wrapped. They inherit Pi's environment, so `devenv.nix` changes apply after Pi restarts. The briefing says so.

The trust check uses `devenv hook-should-activate`, an internal command that Devenv's shell hook uses. If it fails, for example with an older Devenv, commands run outside Devenv and Pi shows a warning.

Pi applies `shellCommandPrefix` to agent `bash` calls outside the Devenv shell, so aliases from that prefix do not reach the command. For `!` commands the prefix runs inside the Devenv shell.

Pi 0.84.2 uses the first result from a `user_bash` handler. Do not combine `!` wrapping with SSH, sandbox, or execution-routing extensions unless you control their load order. The extension does not rewrite an extension-owned `bash` tool. If Pi cannot identify active `bash` ownership, the extension preserves legacy rewrite behavior.

## Check

In an allowed Devenv project, `!printenv DEVENV_ROOT` prints the project root.

## Test

Enter the Devenv shell before you use the development scripts. The shell provides TypeScript and Biome.

```bash
devenv test
```

`devenv shell` installs pre-commit hooks for Biome, Nix formatting, TypeScript, and unit tests.

The unit tests drive real Pi sessions against a fake `devenv`. To run a real Pi session against a real Devenv shell:

```bash
pnpm e2e
```

The end-to-end test builds a fixture project with this checkout's `devenv.yaml` and `devenv.lock`, and keeps trust decisions in a temporary `DEVENV_HOME`. Set `PI_DEVENV_E2E_INPUTS` to use another directory's input files.

## Evaluate the briefing

`pnpm eval` measures whether the briefing changes what a real model does. It runs each scenario with the briefing and without it, using your Pi model configuration, and prints how often each behaviour occurred. It spends tokens on that model.

```bash
pnpm eval --model anthropic/claude-sonnet-4-5 --trials 3
```

| Scenario | Prompt | Behaviours reported |
| --- | --- | --- |
| `migrate` | Apply the pending database migrations. | task done; used the project's `migrate` script |
| `missing-tool` | Run shellcheck on deploy.sh … | task done; added shellcheck to `devenv.nix`; used a one-off Nix shell; tried a global install |
| `service` | Start the web server, confirm it serves health.txt, then shut it down. | task done; used `devenv up -d`; ran `devenv up` in the foreground; stopped the processes |

Each trial uses a new copy of a small fixture project and a temporary `DEVENV_HOME`. The eval blocks global installs and `sudo`, and records the attempt. Without `--model`, the eval uses Pi's default model. Results go to `eval-results/`. If shellcheck is already on `PATH`, the `missing-tool` scenario cannot show a difference, and the eval prints a warning.

## License

MIT
