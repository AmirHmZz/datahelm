import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const base = process.env.DATAHELM_E2E_URL || "http://localhost:18080";
const password = readFileSync(
  process.env.DATAHELM_E2E_PASSWORD_FILE ||
    resolve(import.meta.dirname, "../secrets/admin_password"),
  "utf8",
).trim();
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password }),
});
if (!login.ok) throw new Error("Recovery test login failed");
const { csrf_token } = await login.json();
const cookie = login.headers.get("set-cookie").split(";")[0];
async function api(path, method = "GET", body) {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf_token,
      Cookie: cookie,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.message);
  return v;
}
async function until(predicate, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Recovery condition timed out");
}
const config = {
  name: "Recovery validation",
  mode: "form",
  hosts: "rs1:27017",
  replica_set: "datahelm-rs",
  monitoring: true,
  ssh: {
    enabled: true,
    host: "ssh",
    port: 22,
    username: "root",
    password: "datahelm-test-only",
  },
};
config.ssh.fingerprint = (
  await api("/connections/ssh-fingerprint", "POST", { config })
).fingerprint;
const id = (await api("/connections", "POST", config)).id;
const latest = () => api(`/connections/${id}/metrics/latest`);
const first = await until(async () => {
  const m = await latest();
  return m?.ops_per_second != null && m;
});
const topology = await api(`/connections/${id}/topology`);
const primary = topology.replica.members
  .find((m) => m.stateStr === "PRIMARY")
  .name.split(":")[0];
try {
  execFileSync(
    "docker",
    [
      "compose",
      "-p",
      "datahelm-fixtures",
      "-f",
      "compose.tests.yaml",
      "exec",
      "-T",
      primary,
      "mongosh",
      "--quiet",
      "--eval",
      "rs.stepDown(30)",
    ],
    { stdio: "ignore" },
  );
} catch {}
const switched = await until(async () => {
  const m = await latest();
  return m && !m.error && m.source !== first.source && m;
});
if (switched.ops_per_second !== null)
  throw new Error("Failover did not produce a rate gap");
console.log("Replica failover and source-change rate gap passed");
execFileSync(
  "docker",
  [
    "compose",
    "-p",
    "datahelm-fixtures",
    "-f",
    "compose.tests.yaml",
    "restart",
    "ssh",
  ],
  { stdio: "ignore" },
);
const recovered = await until(async () => {
  const m = await latest();
  return m && !m.error && m.timestamp > switched.timestamp + 10000 && m;
});
console.log("SSH tunnel recovery passed");
const history = await api(
  `/connections/${id}/metrics?from=${first.timestamp}&to=${recovered.timestamp}`,
);
if (history.length < 2) throw new Error("Metrics history was not persisted");
await api(`/connections/${id}`, "DELETE");
console.log("Continuous persisted monitoring passed");
