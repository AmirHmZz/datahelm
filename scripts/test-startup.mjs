import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const project = `datahelm-startup-${randomUUID().slice(0, 8)}`;
const override = join(root, "data", `${project}.yaml`);
const base = "http://localhost:18081";
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  join(root, "compose.yaml"),
  "-f",
  override,
];
const docker = (...args) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function run(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Docker startup check failed (${code})`)),
    );
  });
}
let cookie = "",
  csrf = "";
async function api(path, method = "GET", body, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      Origin: base,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  return { response, value };
}
function acceptSession(result) {
  assert.equal(result.response.status, 200);
  cookie = result.response.headers.get("set-cookie").split(";")[0];
  csrf = result.value.csrf_token;
}
let started = false;
try {
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(
    override,
    `services:\n  datahelm:\n    ports: ["127.0.0.1:18081:8080"]\n    environment:\n      DATAHELM_ORIGIN: ${base}\n      DATAHELM_ADMIN_USERNAME: admin\n`,
    { flag: "wx" },
  );
  const original = JSON.parse(
    docker(
      "compose",
      "-f",
      join(root, "compose.yaml"),
      "config",
      "--format",
      "json",
    ),
  );
  assert.equal(
    original.services.datahelm.ports,
    undefined,
    "Production Compose must not publish ports",
  );
  started = true;
  await run(
    ...compose,
    "up",
    "--no-build",
    "-d",
    "--wait",
    "--wait-timeout",
    "90",
  );
  const container = docker(...compose, "ps", "-q", "datahelm");
  const logs = docker("logs", container);
  const credentials = logs.match(
    /Initial administrator credentials[^\n]*username: ([^,]+), temporary password: ([A-Za-z0-9_-]+)\./,
  );
  assert.ok(credentials, "First startup must print temporary credentials");
  assert.equal(credentials[1], "admin");
  assert.equal(docker("exec", container, "id", "-u"), "10001");
  const keyHash = docker(
    "exec",
    container,
    "sha256sum",
    "/var/lib/datahelm/secrets/master_key",
  );
  assert.equal(
    docker(
      "exec",
      container,
      "stat",
      "-c",
      "%a",
      "/var/lib/datahelm/secrets/master_key",
    ),
    "600",
  );
  const first = await api("/auth/login", "POST", {
    username: "admin",
    password: credentials[2],
  });
  acceptSession(first);
  assert.equal(first.value.must_change_password, true);
  assert.equal((await api("/connections")).response.status, 403);
  const newPassword = randomBytes(24).toString("base64url");
  const oldCookie = cookie;
  const changed = await api("/auth/password", "POST", {
    current_password: credentials[2],
    new_password: newPassword,
  });
  acceptSession(changed);
  assert.equal(changed.value.must_change_password, false);
  assert.notEqual(cookie, oldCookie);
  assert.equal(
    (await api("/auth/session", "GET", undefined, { Cookie: oldCookie }))
      .response.status,
    401,
  );
  const saved = await api("/connections", "POST", {
    name: "Startup persistence fixture",
    hosts: "unreachable.invalid:27017",
    username: "fixture",
    password: "encrypted-connection-password",
    monitoring: false,
  });
  assert.equal(saved.response.status, 200);
  assert.equal(
    (
      await api("/auth/login", "POST", {
        username: "admin",
        password: credentials[2],
      })
    ).response.status,
    401,
  );
  // A new container must reuse both volumes, preserve the changed password,
  // and decrypt the previously saved connection without another setup step.
  await run(
    ...compose,
    "up",
    "--no-build",
    "-d",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "90",
  );
  const restarted = docker(...compose, "ps", "-q", "datahelm");
  assert.equal(
    docker(
      "exec",
      restarted,
      "sha256sum",
      "/var/lib/datahelm/secrets/master_key",
    ),
    keyHash,
  );
  assert.ok(
    !docker("logs", restarted).includes("Initial administrator credentials"),
    "Credentials must not be printed again",
  );
  const signedIn = await api("/auth/login", "POST", {
    username: "admin",
    password: newPassword,
  });
  acceptSession(signedIn);
  assert.equal(signedIn.value.must_change_password, false);
  const list = await api("/connections");
  assert.equal(list.response.status, 200);
  assert.equal(list.value[0].config.name, "Startup persistence fixture");
  assert.equal(list.value[0].has_password, true);
  assert.equal(list.value[0].config.password, null);
  assert.ok(
    !JSON.stringify(list.value).includes("encrypted-connection-password"),
  );
  console.log(
    "Automatic first startup, credential logs, forced password change, non-root key permissions, and recreation persistence passed.",
  );
} finally {
  if (started) await run(...compose, "down", "-v", "--remove-orphans");
  await rm(override, { force: true });
}
