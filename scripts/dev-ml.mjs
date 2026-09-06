/**
 * Boots the Python ML worker using the project-local virtualenv.
 *
 * Exists because the venv interpreter lives at a different path on
 * Windows (`.venv/Scripts/python.exe`) than on macOS/Linux
 * (`.venv/bin/python`), and hardcoding either one into package.json
 * breaks the repo for everyone on the other platform.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const venvPython = join(
  root,
  "ml",
  ".venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python",
);

if (!existsSync(venvPython)) {
  console.error(
    `\n  ✗ No Python virtualenv found at:\n      ${venvPython}\n\n` +
      `  Create it first:\n` +
      (isWindows
        ? `      cd ml && python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt\n`
        : `      cd ml && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt\n`) +
      `\n  Or run the guided setup:  npm run setup\n`,
  );
  process.exit(1);
}

// `npm run sample` reuses this launcher to render the fallback test clip
// rather than making the user activate the venv by hand.
const wantsSample = process.argv.includes("--sample");

const args = wantsSample
  ? [join(root, "ml", "scripts", "make_sample_clip.py")]
  : [
      "-m",
      "uvicorn",
      "app.main:app",
      "--app-dir",
      join(root, "ml"),
      "--port",
      "8000",
      "--reload",
    ];

const child = spawn(venvPython, args, {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
