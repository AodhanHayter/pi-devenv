# pi-devenv

Pi extension: wrap `bash` and `!` in `devenv --no-tui -q shell --` when an ancestor has `devenv.nix`.

The agent stays outside the Devenv process. The extension skips the wrapper only when `DEVENV_ROOT` matches the current project. `devenv` must be on `PATH`.

Command output contains only the command's own stdout and stderr. Devenv prints task progress lines even with `-q`, and `enterShell` output lands on stdout; the wrapper discards both. If Devenv fails before the command starts, for example on an evaluation error, the wrapper prints Devenv's output and exits with its status.

## Install

Run this command from the checkout root:

```bash
pi install .
```

Use `/reload`, or start a new session, after installation.

## Safety and compatibility

The wrapper evaluates the discovered `devenv.nix` before it runs the requested command. It also runs the project's `enterShell` code. Pi project trust does not approve this code.

Pi applies `shellCommandPrefix` to agent `bash` calls outside the Devenv shell, so aliases from that prefix do not reach the command. For `!` commands the prefix runs inside the Devenv shell.

Pi 0.84.2 uses the first result from a `user_bash` handler. Do not combine `!` wrapping with SSH, sandbox, or execution-routing extensions unless you control their load order. The extension does not rewrite an extension-owned `bash` tool. If Pi cannot identify active `bash` ownership, the extension preserves legacy rewrite behavior.

## Check

In a Devenv project, `!printenv DEVENV_ROOT` prints the project root.

The bash call display stays the original command. The session stores the original LLM arguments. The wrapper changes execution only.

## Test

Enter the Devenv shell before you use the development scripts. The shell provides TypeScript and Biome.

```bash
devenv test
```

`devenv shell` installs pre-commit hooks for Biome, Nix formatting, TypeScript, and unit tests.

The unit tests use a fake `devenv`. To run a real Pi session against a real Devenv shell:

```bash
pnpm e2e
```

The end-to-end test builds a fixture project with this checkout's `devenv.yaml` and `devenv.lock`. Set `PI_DEVENV_E2E_INPUTS` to use another directory's input files.

## License

MIT
