/**
 * Guided first-time setup — `npm run setup`.
 *
 * Does everything the README's setup section describes, in order, and stops at
 * the first genuine failure with the specific command that fixes it. Steps that
 * are already satisfied are skipped, so it is safe to re-run.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import net from "node:net";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const D = "\x1b[2m";
const X = "\x1b[0m";

let step = 0;
function heading(text) {
  console.log(`\n${D}${String(++step).padStart(2, "0")}${X}  ${text}`);
}
function ok(text) {
  console.log(`    ${G}✓${X} ${text}`);
}
function warn(text) {
  console.log(`    ${Y}!${X} ${text}`);
}
function fail(text, fix) {
  console.log(`    ${R}✗${X} ${text}`);
  if (fix) console.log(`      ${D}fix:${X} ${fix}`);
  process.exit(1);
}

/** Streams a long-running command so the user sees progress, not a hang. */
function stream(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    // npm and docker on Windows are .cmd shims, so they need a shell. An
    // absolute path must not go through one: cmd.exe splits the command on
    // the first space, so a checkout under "C:\D Drive\..." fails as 'C:\D'.
    const useShell = isWindows && !command.includes("\\");
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: useShell });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
    child.on("error", reject);
  });
}

async function probe(command, args) {
  try {
    const { stdout } = await run(command, args, { windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

console.log("\n  LightEdit setup\n  ───────────────");

// ── 1. Toolchain ─────────────────────────────────────────────────────
heading("Checking toolchain");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) fail(`Node ${process.versions.node} is too old`, "install Node 20 or newer");
ok(`node v${process.versions.node}`);

const pythonCmd = isWindows ? "python" : "python3";
const pythonVersion = await probe(pythonCmd, ["--version"]);
if (!pythonVersion) fail(`${pythonCmd} not found on PATH`, "install Python 3.10 or newer");
ok(pythonVersion.toLowerCase());

if (!(await probe("ffmpeg", ["-version"]))) {
  fail(
    "ffmpeg not found on PATH",
    isWindows ? "winget install Gyan.FFmpeg  (then reopen this terminal)" : "brew install ffmpeg",
  );
}
ok("ffmpeg");

const gpu = await probe("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
if (gpu) ok(`gpu — ${gpu.split("\n")[0]}`);
else warn("no NVIDIA GPU detected — the pipeline will run on CPU (several minutes per clip)");

// ── 2. .env ──────────────────────────────────────────────────────────
heading("Configuring .env");

const envPath = join(root, ".env");
if (!existsSync(envPath)) {
  const template = readFileSync(join(root, ".env.example"), "utf8");
  writeFileSync(
    envPath,
    template.replace(
      "INTERNAL_SECRET=change-me-to-anything",
      `INTERNAL_SECRET=${randomBytes(24).toString("hex")}`,
    ),
  );
  ok("created .env with a generated INTERNAL_SECRET");
} else {
  ok(".env already exists");
}

const hasKey = Boolean(readFileSync(envPath, "utf8").match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim());
if (!hasKey) warn("GEMINI_API_KEY is empty — add it before running a job (aistudio.google.com/apikey)");
else ok("GEMINI_API_KEY is set");

// ── 3. Node dependencies ─────────────────────────────────────────────
heading("Installing Node dependencies");
for (const [name, dir] of [["server", "server"], ["client", "client"]]) {
  if (existsSync(join(root, dir, "node_modules"))) {
    ok(`${name} — already installed`);
  } else {
    console.log(`    installing ${name}…`);
    await stream("npm", ["install", "--no-fund", "--no-audit"], join(root, dir));
    ok(name);
  }
}

// ── 4. Python environment ────────────────────────────────────────────
heading("Building the Python environment");

const venvDir = join(root, "ml", ".venv");
const venvPython = join(venvDir, isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python");

if (!existsSync(venvPython)) {
  console.log("    creating virtualenv…");
  await stream(pythonCmd, ["-m", "venv", ".venv"], join(root, "ml"));
  ok("virtualenv created");
} else {
  ok("virtualenv already exists");
}

const torchInstalled = await probe(venvPython, ["-c", "import torch; print(torch.__version__)"]);
if (!torchInstalled) {
  // PyTorch is installed from its own index so the CUDA build is selected;
  // pulling it from PyPI silently yields the CPU-only wheel.
  console.log("    installing PyTorch with CUDA support (~2.5GB, this takes a while)…");
  await stream(venvPython, [
    "-m", "pip", "install", "torch", "torchvision",
    "--index-url", "https://download.pytorch.org/whl/cu124",
  ]);
  ok("pytorch");
} else {
  ok(`pytorch ${torchInstalled}`);
}

const cudaReady = await probe(venvPython, ["-c", "import torch; print(torch.cuda.is_available())"]);
if (cudaReady === "True") ok("CUDA available");
else warn("CUDA not available to PyTorch — it will run on CPU");

console.log("    installing remaining Python requirements…");
await stream(venvPython, ["-m", "pip", "install", "-q", "-r", join(root, "ml", "requirements.txt")]);
ok("python requirements");

// ── 5. MongoDB ───────────────────────────────────────────────────────
heading("Checking MongoDB");

/** Is anything listening on 27017? Works for a service, a container, or Atlas. */
function portOpen(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

if (await portOpen("127.0.0.1", 27017)) {
  ok("mongodb is reachable on 127.0.0.1:27017");
} else if (await probe("docker", ["--version"])) {
  // docker-compose.yml is kept as the container path for anyone who prefers it.
  await stream("docker", ["compose", "up", "-d"]);
  ok("started the lightedit-mongo container");
} else {
  warn("nothing listening on 27017");
  console.log(
    `      ${D}install:${X} ` +
      (isWindows
        ? "winget install MongoDB.Server   (installs and starts a Windows service)"
        : "brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community"),
  );
  console.log(`      ${D}or:${X}      docker compose up -d`);
}

// ── Done ─────────────────────────────────────────────────────────────
console.log(`\n  ${G}Setup complete.${X}\n`);
if (!hasKey) {
  console.log(`  ${Y}Before your first job:${X} add GEMINI_API_KEY to .env\n`);
}
console.log("  Start everything:   npm run dev");
console.log("  Make a test clip:   npm run sample");
console.log("  Re-check the env:   npm run doctor\n");
