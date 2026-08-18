# pi-devenv

Pi extension: wrap `bash` and `!` in `devenv --no-tui -q shell --` when an ancestor has `devenv.nix`.

The agent stays outside the Devenv process. The extension skips the wrapper only when `DEVENV_ROOT` matches the current project. `devenv` must be on `PATH`.

## Install

Run this command from the checkout root:

```bash
pi install .
```

Use `/reload`, or start a new session, after installation.

## Safety and compatibility

The wrapper evaluates the discovered `devenv.nix` before it runs the requested command. It also runs the project's `enterShell` code. Pi project trust does not approve this code.

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

## License

MIT
