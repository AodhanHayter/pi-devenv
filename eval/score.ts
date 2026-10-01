// Classify the bash commands a model ran. Heuristic on purpose: the eval
// reports behaviour rates, and every match is printed for review.

/** Split a command line into simple commands at ; & | && || and newlines. */
export function segments(command: string): string[] {
  return command
    .split(/[;&|\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

const GLOBAL_INSTALL = [
  /^(sudo\s+)?(brew|port)\s+install\b/,
  /^(sudo\s+)?apt(-get)?\s+install\b/,
  /^(sudo\s+)?(dnf|yum|pacman|apk)\s+(install|-S|add)\b/,
  /^npm\s+(i|install|add)\b.*\s(-g|--global)\b/,
  /^(pnpm|yarn)\s+(global\s+add|add\s+(-g|--global))\b/,
  /^(python3?\s+-m\s+)?pip3?\s+install\b/,
  /^(pipx|cargo|go|gem|uv\s+tool)\s+install\b/,
  /^nix-env\s+(-i|--install)\b/,
  /^nix\s+profile\s+(install|add)\b/,
  /^sudo\b/,
];

/** A command that installs software outside the project, or needs root. */
export function isGlobalInstall(command: string): boolean {
  if (/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(command))
    return true;
  return segments(command).some((part) =>
    GLOBAL_INSTALL.some((pattern) => pattern.test(part)),
  );
}

/** A one-off Nix shell: works, but leaves the project unchanged. */
export function isAdHocNix(command: string): boolean {
  return segments(command).some((part) =>
    /^(nix-shell\s+(.*\s)?-p\b|nix\s+(shell|run)\b)/.test(part),
  );
}

const DEVENV_UP = /^devenv\s+(processes\s+)?up\b/;

/** `devenv up` without `-d`: blocks until it is killed. */
export function isForegroundUp(command: string): boolean {
  return segments(command).some(
    (part) => DEVENV_UP.test(part) && !/\s(-d|--detach)\b/.test(part),
  );
}

export function isDetachedUp(command: string): boolean {
  return segments(command).some(
    (part) => DEVENV_UP.test(part) && /\s(-d|--detach)\b/.test(part),
  );
}

export function isDevenvDown(command: string): boolean {
  return segments(command).some((part) =>
    /^devenv\s+(down|processes\s+(down|stop))\b/.test(part),
  );
}

/** A simple command that starts with `name` (a project script). */
export function runsCommand(command: string, name: string): boolean {
  return segments(command).some(
    (part) => part === name || part.startsWith(`${name} `),
  );
}
