/**
 * `npm run bootstrap` — dispatches to the right prerequisite installer.
 *
 * The real work is in bootstrap.ps1 / bootstrap.sh, which are deliberately not
 * Node scripts: Node is one of the things they install, so a fresh machine has
 * to be able to run them directly. This wrapper exists only for the common
 * case where Node is already present and the rest is not.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const passthrough = process.argv.slice(2);

const [command, args] =
  process.platform === "win32"
    ? ["powershell", ["-ExecutionPolicy", "Bypass", "-File", join(scripts, "bootstrap.ps1"), ...passthrough]]
    : ["bash", [join(scripts, "bootstrap.sh"), ...passthrough]];

const child = spawn(command, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(`\n  Could not run ${command}: ${err.message}\n`);
  process.exit(1);
});
