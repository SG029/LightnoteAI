/**
 * Preflight check — `npm run doctor`.
 *
 * Every dependency this project needs, verified in one shot, so a
 * failure reads as "ffmpeg is missing" instead of surfacing later as
 * an opaque stack trace three minutes into a render.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import net from "node:net";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const PASS = "\x1b[32m✓\x1b[0m";
const WARN = "\x1b[33m!\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";

let hardFailures = 0;

function report(mark, label, detail) {
  if (mark === FAIL) hardFailures++;
  console.log(`  ${mark}  ${label.padEnd(22)} ${detail}`);
}

/** Runs a command, returning its trimmed stdout or null if it isn't installed. */
async function probe(cmd, args) {
  try {
    const { stdout } = await run(cmd, args, { windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

console.log("\n  LightEdit environment check\n");

// ── Node ────────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split(".")[0]);
report(
  nodeMajor >= 20 ? PASS : FAIL,
  "node",
  `v${process.versions.node}${nodeMajor >= 20 ? "" : "  — needs >= 20"}`,
);

// ── Python ──────────────────────────────────────────────────────────
const pythonCmd = isWindows ? "python" : "python3";
const pythonVersion = await probe(pythonCmd, ["--version"]);
if (pythonVersion) {
  const [maj, min] = pythonVersion.replace("Python ", "").split(".").map(Number);
  const ok = maj === 3 && min >= 10;
  report(ok ? PASS : FAIL, "python", `${pythonVersion}${ok ? "" : "  — needs 3.10+"}`);
} else {
  report(FAIL, "python", "not found on PATH");
}

// ── Python virtualenv ───────────────────────────────────────────────
const venvPython = join(root, "ml", ".venv", isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python");
report(
  existsSync(venvPython) ? PASS : WARN,
  "ml venv",
  existsSync(venvPython) ? "ml/.venv" : "missing — run: npm run setup",
);

// ── ffmpeg / ffprobe ────────────────────────────────────────────────
for (const bin of ["ffmpeg", "ffprobe"]) {
  const out = await probe(bin, ["-version"]);
  report(
    out ? PASS : FAIL,
    bin,
    out ? out.split("\n")[0].replace(`${bin} version `, "").split(" ")[0] : "not found on PATH",
  );
}

// ── GPU ─────────────────────────────────────────────────────────────
const gpu = await probe("nvidia-smi", [
  "--query-gpu=name,memory.total",
  "--format=csv,noheader",
]);
report(
  gpu ? PASS : WARN,
  "gpu",
  gpu ? gpu.split("\n")[0] : "no NVIDIA GPU — pipeline falls back to CPU (slow)",
);

// ── MongoDB ─────────────────────────────────────────────────────────
// Checked by port rather than by asking Docker or the service manager, so a
// native install, a container and Atlas all answer the same question.
const mongoUp = await new Promise((resolve) => {
  const socket = new net.Socket();
  const done = (result) => {
    socket.destroy();
    resolve(result);
  };
  socket.setTimeout(1200);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
  socket.connect(27017, "127.0.0.1");
});
report(
  mongoUp ? PASS : FAIL,
  "mongodb",
  mongoUp ? "listening on 127.0.0.1:27017" : "nothing on 27017 — see README \"Setup\"",
);

// ── .env ────────────────────────────────────────────────────────────
const envPath = join(root, ".env");
if (!existsSync(envPath)) {
  report(FAIL, ".env", "missing — copy .env.example to .env");
} else {
  const env = readFileSync(envPath, "utf8");
  const key = env.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim();
  report(key ? PASS : FAIL, ".env", key ? "GEMINI_API_KEY is set" : "GEMINI_API_KEY is empty");
}

console.log(
  hardFailures === 0
    ? "\n  All good. Start everything with:  npm run dev\n"
    : `\n  ${hardFailures} blocking issue(s) above — see README "Setup".\n`,
);

process.exit(hardFailures === 0 ? 0 : 1);
