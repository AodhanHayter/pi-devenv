{ pkgs, ... }:
{
  packages = [ pkgs.biome ];

  languages.javascript = {
    enable = true;
    pnpm.enable = true;
    pnpm.install.enable = true;
  };
  languages.typescript.enable = true;

  git-hooks.hooks = {
    biome = {
      enable = true;
      excludes = [
        "^\\.pi/"
        "^tools/oxlint/anti-slop/"
      ];
    };
    nixfmt.enable = true;
    tsc = {
      enable = true;
      name = "TypeScript";
      entry = "tsc --noEmit";
      files = "\\.ts$";
      pass_filenames = false;
    };
    tests = {
      enable = true;
      name = "tests";
      entry = "node --experimental-strip-types --test test.ts";
      files = "\\.ts$";
      pass_filenames = false;
    };
  };
}
