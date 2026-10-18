import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
const base = process.env.DATAHELM_E2E_URL || "http://localhost:8080";
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
if (!login.ok) throw new Error("Fixture login failed");
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
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${data.message}`);
  return data;
}
const config = {
  name: "Replica-set SSH validation",
  mode: "form",
  hosts: "rs1:27017",
  replica_set: "datahelm-rs",
  monitoring: false,
  ssh: {
    enabled: true,
    host: process.env.DATAHELM_TEST_SSH_HOST || "localhost",
    port: Number(process.env.DATAHELM_TEST_SSH_PORT || 2223),
    username: "root",
    password: "datahelm-test-only",
  },
};
const probe = await api("/connections/ssh-fingerprint", "POST", { config });
config.ssh.fingerprint = probe.fingerprint;
await api("/connections/test", "POST", { config });
console.log("SSH password authentication and replica-set discovery passed");
const id = (await api("/connections", "POST", config)).id;
const path = (suffix) => `/connections/${id}/${suffix}`;
const topo = await api(path("topology"));
if (topo.replica?.members?.length !== 3)
  throw new Error("Expected three replica members");
console.log("Replica-set topology and member health passed");
let rejected = false;
try {
  await api("/connections/test", "POST", {
    config: {
      ...config,
      ssh: { ...config.ssh, fingerprint: "SHA256:wrong-key" },
    },
  });
} catch {
  rejected = true;
}
if (!rejected) throw new Error("Changed SSH host key was accepted");
console.log("SSH host-key rejection passed");
const key = execFileSync(
  "docker",
  [
    "compose",
    "-p",
    "datahelm-fixtures",
    "-f",
    "compose.tests.yaml",
    "exec",
    "-T",
    "ssh",
    "cat",
    "/fixtures/client_key",
  ],
  { encoding: "utf8" },
);
await api("/connections/test", "POST", {
  config: {
    ...config,
    ssh: {
      ...config.ssh,
      password: null,
      private_key: key,
      passphrase: "fixture-key-passphrase",
    },
  },
});
console.log("Encrypted SSH private-key authentication passed");
const sharded = {
  ...config,
  name: "Sharded SSH validation",
  hosts: "router:27017",
  replica_set: "",
};
const sid = (await api("/connections", "POST", sharded)).id;
const shards = await api(`/connections/${sid}/topology`);
if (shards.shards?.shards?.length !== 2) throw new Error("Expected two shards");
console.log("Sharding topology through SSH passed");
const catalog = await api(`/connections/${sid}/collections?db=fixture`);
const event = catalog.find((c) => c.name === "events");
const memberStats = ["shard1", "shard2"].map((shard) =>
  JSON.parse(
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
        shard,
        "mongosh",
        "--quiet",
        "--eval",
        "const s=db.getSiblingDB('fixture').runCommand({collStats:'events'}); print(JSON.stringify({count:s.count,size:s.size,storage:s.storageSize,indexes:s.nindexes}))",
      ],
      { encoding: "utf8" },
    ).trim(),
  ),
);
if (
  !event ||
  event.count !== 2 ||
  event.indexes !== 1 ||
  event.size !== memberStats.reduce((sum, s) => sum + s.size, 0) ||
  event.storage_size !== memberStats.reduce((sum, s) => sum + s.storage, 0)
)
  throw new Error("Sharded statistics mismatch");
console.log("Sharded collection statistics passed");
// An intentionally slow, tagged query on the disposable standalone fixture.
const standalone = (
  await api("/connections", "POST", {
    name: "Cancellation fixture",
    mode: "uri",
    uri:
      process.env.DATAHELM_E2E_MONGO_URI ||
      "mongodb://admin:datahelm-test-only@localhost:28018/?authSource=admin&directConnection=true",
    monitoring: false,
  })
).id;
const code =
  "db.getSiblingDB('cancel_fixture').events.insertOne({n:1}); db.getSiblingDB('cancel_fixture').events.aggregate([{$project:{value:{$function:{body:function(){const t=Date.now();while(Date.now()-t<30000){};return 1;},args:[],lang:'js'}}}}],{comment:'datahelm-cancel-validation'}).toArray()";
const operationProcess = spawn(
  "docker",
  [
    "exec",
    "datahelm-test-mongo8",
    "mongosh",
    "-u",
    "admin",
    "-p",
    "datahelm-test-only",
    "--authenticationDatabase",
    "admin",
    "--quiet",
    "--eval",
    code,
  ],
  { stdio: "ignore" },
);
let operation;
for (let i = 0; i < 50; i++) {
  const ops = await api(`/connections/${standalone}/operations`);
  operation = ops.find(
    (o) => o.operation.command?.comment === "datahelm-cancel-validation",
  );
  if (operation) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!operation?.killable)
  throw new Error("Tagged client operation was not cancellable");
await api(`/connections/${standalone}/operations/kill`, "POST", {
  token: operation.token,
});
console.log("Revalidated operation cancellation passed");
if (operationProcess.exitCode === null && operationProcess.signalCode === null)
  await new Promise((r) => operationProcess.once("exit", r));
for (const target of [id, sid, standalone])
  await api(`/connections/${target}`, "DELETE");
