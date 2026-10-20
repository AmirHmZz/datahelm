import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--skip-build", "--browser"].includes(arg))
    throw new Error(`Unknown option: ${arg}`);
const project = "datahelm-clickhouse-fixtures";
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  "compose.clickhouse-tests.yaml",
];
if (
  execFileSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.ID}}",
    ],
    { encoding: "utf8" },
  ).trim()
)
  throw new Error(
    "Existing ClickHouse fixture containers found; refusing to overwrite them",
  );
const secretDir = resolve(root, "data", `clickhouse-${randomUUID()}`);
const env = {
  ...process.env,
  DATAHELM_E2E_URL: "http://localhost:18082",
  DATAHELM_E2E_PASSWORD_FILE: resolve(secretDir, "admin_password"),
  DATAHELM_CLICKHOUSE_E2E: "1",
};
const base = env.DATAHELM_E2E_URL;
const run = (cmd, args, options = {}) =>
  new Promise((yes, no) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env,
      stdio: "inherit",
      ...options,
    });
    child.on("error", no);
    child.on("exit", (code) =>
      code === 0 ? yes() : no(new Error(`${cmd} exited ${code}`)),
    );
  });
const docker = (...args) =>
  execFileSync("docker", [...compose, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
const sql = (query) =>
  docker(
    "exec",
    "-T",
    "clickhouse",
    "clickhouse-client",
    "--user",
    "admin",
    "--password",
    "datahelm-test-only",
    "--multiquery",
    "--query",
    query,
  );
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "",
  csrf = "";
async function api(path, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${value.message || response.status}`,
  );
  if (path === "/auth/login" || path === "/auth/password") {
    cookie = response.headers.get("set-cookie").split(";")[0];
    csrf = value.csrf_token;
  }
  return value;
}
async function ready() {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await delay(1000);
  }
  throw new Error("Disposable app did not become healthy");
}
const config = {
  name: "ClickHouse fixture",
  engine: "clickhouse",
  clickhouse: {
    endpoint: "http://clickhouse:8123",
    database: "default",
    username: "operator",
    password: "datahelm-test-only",
  },
  monitoring: true,
};
try {
  await mkdir(secretDir, { recursive: true });
  if (!args.has("--skip-build"))
    await run("docker", ["build", "-t", "datahelm:phase1", "."]);
  await run("docker", [...compose, "up", "--build", "-d"]);
  await ready();
  sql(
    "CREATE USER operator IDENTIFIED WITH bcrypt_password BY 'datahelm-test-only'; GRANT ALL ON *.* TO operator WITH GRANT OPTION; CREATE DATABASE fixture; CREATE TABLE fixture.records (id UInt64,value String) ENGINE=MergeTree ORDER BY id; INSERT INTO fixture.records VALUES (1,'one'),(2,'two'); CREATE USER restricted IDENTIFIED WITH bcrypt_password BY 'datahelm-test-only';",
  );
  // Fresh servers create system.query_log on the first log flush. Seed a
  // SELECT and flush explicitly so history checks do not race that timer.
  const historyQuery = "SELECT id FROM fixture.records ORDER BY id";
  sql(`${historyQuery}; SYSTEM FLUSH LOGS query_log;`);
  await api("/auth/login", "POST", {
    username: "admin",
    password: "clickhouse-fixture-admin-password",
  });
  const adminPassword = `fixture-${randomUUID()}`;
  await api("/auth/password", "POST", {
    current_password: "clickhouse-fixture-admin-password",
    new_password: adminPassword,
  });
  await writeFile(env.DATAHELM_E2E_PASSWORD_FILE, adminPassword, {
    mode: 0o600,
  });
  const noCsrf = await fetch(`${base}/api/v1/connections`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(
    (await api("/connections/test", "POST", { config })).engine,
    "clickhouse",
  );
  const { id } = await api("/connections", "POST", config);
  const path = (suffix) => `/connections/${id}/clickhouse/${suffix}`;
  let saved = (await api("/connections")).find((c) => c.id === id);
  assert.equal(saved.has_password, true);
  assert.equal(saved.config.clickhouse.password, null);
  await api(`/connections/${id}`, "PUT", {
    ...saved.config,
    name: "ClickHouse fixture edited",
  });
  await api("/connections/test", "POST", {
    config: saved.config,
    saved_id: id,
  });
  await api(
    `/connections/${id}`,
    "PUT",
    { ...saved.config, engine: "mongodb", clickhouse: null },
    400,
  );
  await api(`/connections/${id}/databases`, "GET", undefined, 400);
  const capabilities = await api(`/connections/${id}/capabilities`);
  assert.equal(capabilities.features.create_user.available, true);
  assert.equal(capabilities.features.history.available, true);
  assert((await api(path("databases"))).some((d) => d.name === "fixture"));
  assert.equal((await api(path("tables?database=fixture")))[0].total_rows, "2");
  assert.equal(
    (await api(path("columns?database=fixture&table=records"))).length,
    2,
  );
  await api(path("replicas"));
  assert(
    (await api(path("history"))).some((entry) =>
      entry.query.startsWith(historyQuery),
    ),
    "History must include the seeded SELECT after the fixture log flush",
  );
  console.log(
    "Verified saved connections, engine isolation, catalog, and history",
  );
  const name = "datahelm_api_user",
    role = "datahelm_api_role",
    parent = "datahelm_parent";
  await api(path("users"), "POST", { name, password: "temporary-pass" });
  await api(path("roles"), "POST", { name: role });
  await api(path("roles"), "POST", { name: parent });
  const target = { kind: "role", name: parent };
  const grant = {
    target,
    privilege: "SELECT",
    database: "fixture",
    table: "records",
    column: "id",
    grant_option: true,
  };
  await api(path("grants"), "POST", grant);
  await api(path("role-grants"), "POST", {
    target: { kind: "role", name: role },
    role: parent,
    admin_option: false,
  });
  const assignment = {
    target: { kind: "user", name },
    role,
    admin_option: true,
  };
  await api(path("role-grants"), "POST", assignment);
  await api(path("default-roles"), "PUT", {
    user: name,
    mode: "list",
    roles: [role],
  });
  const userConfig = {
    ...config,
    name: "user-test",
    clickhouse: {
      ...config.clickhouse,
      username: name,
      password: "temporary-pass",
    },
    monitoring: false,
  };
  await api("/connections/test", "POST", { config: userConfig });
  sql(`SELECT id FROM fixture.records SETTINGS max_threads=1`);
  // Verify actual inherited and column-level permissions through a separate client.
  assert.equal(
    docker(
      "exec",
      "-T",
      "clickhouse",
      "clickhouse-client",
      "--user",
      name,
      "--password",
      "temporary-pass",
      "--query",
      "SELECT count(id) FROM fixture.records",
    ).trim(),
    "2",
  );
  assert(
    (await api(path("grants"))).some(
      (g) =>
        g.role_name === parent && g.column === "id" && g.grant_option === 1,
    ),
  );
  assert(
    (await api(path("role-grants"))).some(
      (g) => g.user_name === name && g.with_admin_option === 1,
    ),
  );
  await api(path("grants"), "DELETE", grant);
  assert(
    (await api(path("grants"))).some(
      (g) =>
        g.role_name === parent && g.column === "id" && g.grant_option === 0,
    ),
  );
  await api(path("role-grants"), "DELETE", assignment);
  assert(
    (await api(path("role-grants"))).some(
      (g) => g.user_name === name && g.with_admin_option === 0,
    ),
  );
  await api(path("users"), "PATCH", { name, password: "changed-pass" });
  await api("/connections/test", "POST", { config: userConfig }, 400);
  await api("/connections/test", "POST", {
    config: {
      ...userConfig,
      clickhouse: { ...userConfig.clickhouse, password: "changed-pass" },
    },
  });
  const before = (await api(path("users"))).find((u) => u.name === name);
  await api(path("users"), "PATCH", { name, password: "" });
  assert.deepEqual(
    (await api(path("users"))).find((u) => u.name === name).host_ip,
    before.host_ip,
  );
  await api(path("networks"), "PUT", {
    user: name,
    mode: "ip",
    addresses: ["127.0.0.1/32", "::1/128"],
  });
  await api(
    "/connections/test",
    "POST",
    {
      config: {
        ...userConfig,
        clickhouse: { ...userConfig.clickhouse, password: "changed-pass" },
      },
    },
    400,
  );
  await api(path("networks"), "PUT", {
    user: name,
    mode: "any",
    addresses: [],
  });
  await api(path("users"), "PATCH", { name, password: "é".repeat(37) }, 400);
  await api(
    path("grants"),
    "POST",
    { ...grant, privilege: "SELECT; DROP USER operator" },
    400,
  );
  const configUser = (await api(path("users"))).find((u) => u.name === "admin");
  assert.equal(configUser.readonly, true);
  await api(
    path("users"),
    "PATCH",
    { name: "admin", password: "not-allowed" },
    400,
  );
  const restricted = {
    ...config,
    name: "restricted",
    clickhouse: { ...config.clickhouse, username: "restricted" },
    monitoring: false,
  };
  const restrictedId = (await api("/connections", "POST", restricted)).id;
  assert.equal(
    (await api(`/connections/${restrictedId}/capabilities`)).features
      .create_user.available,
    false,
  );
  await api(
    `/connections/${restrictedId}/clickhouse/users`,
    "POST",
    { name: "should-not-exist", password: "private-attempt" },
    403,
  );
  await api(`/connections/${restrictedId}`, "DELETE");
  console.log(
    "Verified user/role CRUD, inherited grants, passwords, network restrictions, and denied permissions",
  );
  const ca = docker("exec", "-T", "ssh", "cat", "/fixtures/tls/ca.crt");
  const tls = {
    ...config,
    monitoring: false,
    clickhouse: { ...config.clickhouse, endpoint: "https://clickhouse:8443" },
    tls: { enabled: true, ca_pem: ca },
  };
  await api("/connections/test", "POST", { config: tls });
  await api(
    "/connections/test",
    "POST",
    { config: { ...tls, tls: { enabled: true } } },
    400,
  );
  const ssh = {
    enabled: true,
    host: "ssh",
    port: 22,
    username: "root",
    password: "datahelm-test-only",
  };
  const fingerprint = (
    await api("/connections/ssh-fingerprint", "POST", {
      config: { ...tls, ssh },
    })
  ).fingerprint;
  await api("/connections/test", "POST", {
    config: { ...tls, ssh: { ...ssh, fingerprint } },
  });
  const private_key = docker(
    "exec",
    "-T",
    "ssh",
    "cat",
    "/fixtures/client_key",
  );
  await api("/connections/test", "POST", {
    config: {
      ...tls,
      ssh: {
        ...ssh,
        password: null,
        fingerprint,
        private_key,
        passphrase: "fixture-key-passphrase",
      },
    },
  });
  await api(
    "/connections/test",
    "POST",
    { config: { ...tls, ssh: { ...ssh, fingerprint: "SHA256:wrong" } } },
    400,
  );
  console.log(
    "Verified HTTPS, custom CA rejection, SSH passwords/keys, and host-key rejection",
  );
  // A real running query is cancelled only through the protected API reference.
  const running = run(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "clickhouse",
      "clickhouse-client",
      "--user",
      "operator",
      "--password",
      "datahelm-test-only",
      "--query_id",
      "fixture-cancel-query",
      "--query",
      "SELECT sleepEachRow(0.1) FROM numbers(1000) SETTINGS max_block_size=1,max_threads=1",
    ],
    { stdio: "ignore" },
  ).catch(() => {});
  let query;
  for (let i = 0; i < 30 && !query; i++) {
    await delay(200);
    query = (await api(path("queries"))).find(
      (q) => q.query_id === "fixture-cancel-query",
    );
  }
  assert(query?.kill_token);
  await api(path("queries/kill"), "POST", { token: query.kill_token });
  await running;
  await api(path("queries/kill"), "POST", { token: query.kill_token }, 400);
  await delay(11000);
  assert((await api(`/connections/${id}/metrics/latest`)).clickhouse);
  assert(
    (await api(`/connections/${id}/metrics`)).some(
      (m) => m.clickhouse?.queries_per_second != null,
    ),
  );
  await run("docker", [...compose, "restart", "clickhouse", "app"]);
  await ready();
  await api("/auth/login", "POST", {
    username: "admin",
    password: adminPassword,
  });
  for (let i = 0; i < 30; i++) {
    try {
      await api("/connections/test", "POST", {
        config: (await api("/connections")).find((c) => c.id === id).config,
        saved_id: id,
      });
      break;
    } catch (e) {
      if (i === 29) throw e;
      await delay(1000);
    }
  }
  assert((await api(path("users"))).some((u) => u.name === name));
  assert((await api(path("roles"))).some((r) => r.name === role));
  if (args.has("--browser"))
    await run("bun", ["run", "--cwd", "frontend", "e2e", "clickhouse.spec.ts"]);
  await api(path("grants"), "DELETE", { ...grant, grant_option: false });
  assert(
    !(await api(path("grants"))).some(
      (g) => g.role_name === parent && g.column === "id",
    ),
  );
  await api(path("role-grants"), "DELETE", {
    ...assignment,
    admin_option: false,
  });
  assert(!(await api(path("role-grants"))).some((g) => g.user_name === name));
  await api(path("users"), "DELETE", { name });
  await api(path("roles"), "DELETE", { name: role });
  await api(path("roles"), "DELETE", { name: parent });
  const audit = JSON.stringify(await api("/audit"));
  assert(
    !audit.includes("changed-pass") &&
      !audit.includes("temporary-pass") &&
      !audit.includes("private-attempt"),
  );
  await api(`/connections/${id}`, "DELETE");
  console.log(
    "ClickHouse API, RBAC, HTTP/TLS/SSH, monitoring, cancellation, and restart persistence passed",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await run("docker", [...compose, "down", "-v", "--remove-orphans"]);
  // Only the exact UUID directory created by this runner is removed.
  if (
    secretDir.startsWith(
      resolve(root, "data") + (process.platform === "win32" ? "\\" : "/"),
    )
  )
    await rm(secretDir, { recursive: true, force: true });
}
