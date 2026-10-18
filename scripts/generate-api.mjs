import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const docker = process.argv.includes("--docker");
const result = spawnSync(
  docker ? "docker" : "cargo",
  docker
    ? [
        "run",
        "--rm",
        "--entrypoint",
        "datahelm",
        "datahelm:phase1",
        "--openapi",
      ]
    : ["run", "--quiet", "--", "--openapi"],
  { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr || "API generation failed");
  process.exit(1);
}
JSON.parse(result.stdout);
writeFileSync(resolve(root, "openapi.json"), result.stdout);
const types = spawnSync("bun", ["run", "types"], {
  cwd: resolve(root, "frontend"),
  stdio: "inherit",
});
process.exit(types.status ?? 1);
