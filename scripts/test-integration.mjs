import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

// All database mutations run against this named disposable Compose project.
const root = resolve(import.meta.dirname, "..");
const compose = [
  "compose",
  "-p",
  "datahelm-fixtures",
  "-f",
  "compose.tests.yaml",
  "--profile",
  "integration",
];
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (
    ![
      "--skip-build",
      "--browser",
      "--topology-version=8",
      "--topology-version=9",
    ].includes(arg)
  )
    throw new Error(`Unknown option: ${arg}`);
}
const occupied = execFileSync(
  "docker",
  [
    "ps",
    "-a",
    "--filter",
    "label=com.docker.compose.project=datahelm-fixtures",
    "--format",
    "{{.Names}}",
  ],
  { encoding: "utf8" },
).trim();
const named = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter((name) =>
    [
      "datahelm-test-mongo8",
      "datahelm-test-mongo9",
      "datahelm-tls-validation",
    ].includes(name),
  );
if (occupied || named.length) {
  throw new Error(
    "Existing DataHelm fixture containers found. Remove the disposable fixtures before running this isolated suite; existing containers will not be overwritten.",
  );
}

const secretDir = join(root, "data", `integration-${randomUUID()}`);
const env = {
  ...process.env,
  DATAHELM_TEST_SECRET_DIR: secretDir,
  DATAHELM_E2E_PASSWORD_FILE: join(secretDir, "active_admin_password"),
  DATAHELM_E2E_URL: "http://localhost:18080",
  DATAHELM_TLS_URL: "http://localhost:18080",
  DATAHELM_TEST_INTERNAL_NETWORK: "1",
  DATAHELM_FIXTURE_MONGO_IMAGE: args.has("--topology-version=9")
    ? "mongo:9.0"
    : "mongo:8.0",
  DATAHELM_TEST_SSH_HOST: "ssh",
  DATAHELM_TEST_SSH_PORT: "22",
  DATAHELM_E2E_MONGO_URI:
    "mongodb://admin:datahelm-test-only@mongo8:27017/?authSource=admin&directConnection=true",
};
function run(command, parameters) {
  return new Promise((done, reject) => {
    const child = spawn(command, parameters, {
      cwd: root,
      env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? done()
        : reject(new Error(`${command} exited with ${code ?? signal}`)),
    );
  });
}
async function ready(predicate, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`${label} was not ready within ${timeout / 1000}s`, {
    cause: lastError,
  });
}
let started = false;
try {
  await mkdir(secretDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(secretDir, "master_key"),
    randomBytes(32).toString("base64"),
    { mode: 0o444 },
  );
  const bootstrapPassword = randomBytes(24).toString("base64url");
  await writeFile(join(secretDir, "active_admin_password"), bootstrapPassword, {
    mode: 0o600,
  });
  await writeFile(join(secretDir, "admin_password"), bootstrapPassword, {
    mode: 0o444,
  });
  await chmod(secretDir, 0o700);
  await run("bun", ["install", "--cwd", "frontend", "--frozen-lockfile"]);
  if (!args.has("--skip-build")) {
    await run("docker", [
      "build",
      "--target",
      "test",
      "-t",
      "datahelm:test",
      ".",
    ]);
    await run("docker", ["build", "-t", "datahelm:phase1", "."]);
  }
  started = true;
  await run("docker", [
    ...compose,
    "up",
    "--build",
    "-d",
    "--wait",
    "--wait-timeout",
    "120",
  ]);
  await ready(
    async () =>
      (
        await fetch(`${env.DATAHELM_E2E_URL}/health`, {
          signal: AbortSignal.timeout(3000),
        })
      ).ok,
    "DataHelm",
  );
  // Replica-set startup is independent of the standalone health checks.
  for (const service of [
    "rs1",
    "rs2",
    "rs3",
    "config",
    "shard1",
    "shard2",
    "tls-mongo",
  ]) {
    await ready(() => {
      const tls =
        service === "tls-mongo"
          ? [
              "--tls",
              "--tlsCAFile",
              "/tls/ca.crt",
              "--tlsCertificateKeyFile",
              "/tls/client.pem",
            ]
          : [];
      execFileSync(
        "docker",
        [
          ...compose,
          "exec",
          "-T",
          service,
          "mongosh",
          ...tls,
          "--quiet",
          "--eval",
          "db.adminCommand({ping:1})",
        ],
        { cwd: root, env, stdio: "ignore", timeout: 10000 },
      );
      return true;
    }, service);
  }
  // mongos cannot answer requests until its config replica set is initialized.
  await run(process.execPath, [join("scripts", "init-fixtures.mjs")]);
  const firstLoginAt = Date.now();
  await run(process.execPath, [join("scripts", "complete-first-login.mjs")]);
  for (const script of [
    "validate-administration.mjs",
    "validate-fixtures.mjs",
    "validate-tls.mjs",
    "validate-recovery.mjs",
  ]) {
    await run(process.execPath, [join("scripts", script)]);
  }
  await run("bun", ["run", "--cwd", "frontend", "test"]);
  if (args.has("--browser")) {
    // Bootstrap plus four API sign-ins and two browser tests exceed the production
    // five-per-minute login cap. Honor its window instead of disabling it.
    const remaining = firstLoginAt + 61000 - Date.now();
    if (remaining > 0) {
      console.log(
        "Waiting for the login rate-limit window before browser tests.",
      );
      await new Promise((done) => setTimeout(done, remaining));
    }
    await run("bun", ["run", "--cwd", "frontend", "e2e"]);
  }
  console.log("Disposable MongoDB 8/9 integration suite passed.");
} finally {
  try {
    if (started)
      await run("docker", [...compose, "down", "-v", "--remove-orphans"]);
  } finally {
    const insideData = relative(join(root, "data"), secretDir);
    if (insideData.startsWith("..") || isAbsolute(insideData))
      throw new Error("Unsafe test-secret cleanup path");
    await rm(secretDir, { recursive: true, force: true });
  }
}
