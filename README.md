# pi-devenv

Pi extension: wrap `bash` and `!` in `devenv --no-tui -q shell --` when an ancestor has `devenv.nix`.

The agent itself stays outside devenv (no devenv TUI). Skip wrap if `DEVENV_ROOT` is already set. Needs `devenv` on `PATH`.

## Install

```bash
pi install /Users/aodhan/development/pi-devenv
```

`/reload` or new session after install.

## Check

In a devenv project: `!printenv DEVENV_ROOT` prints the project root.

The bash call display stays the original command. Session stores LLM args; wrap is exec-only.

## Test

```bash
devenv test
```

`devenv shell` installs pre-commit hooks: biome (format + lint), `tsc --noEmit`, and unit tests.

## License

MIT
