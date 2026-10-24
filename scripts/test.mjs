// Runs the compiled tests on every OS. `node --test dist/test/*.test.js` needs a shell that expands the glob,
// which cmd.exe and Node 20 do not; this lists the files itself. Extra arguments go to `node --test`.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = new URL("../dist/test/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort().map((f) => fileURLToPath(new URL(f, dir)));
const run = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
  env: { ...process.env, SKILLROUTER_SERVICE: "0" }, // tests that exercise the warm service turn it back on themselves
});
process.exit(run.status ?? 1);
