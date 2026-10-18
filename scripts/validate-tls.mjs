import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const base = process.env.DATAHELM_TLS_URL || "http://localhost:18080";
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
if (!login.ok) throw new Error("Container login failed");
const { csrf_token } = await login.json();
const cookie = login.headers.get("set-cookie").split(";")[0];
async function api(path, body) {
  const r = await fetch(`${base}/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf_token,
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.message);
  return v;
}
const compose = [
  "compose",
  "-p",
  "datahelm-fixtures",
  "-f",
  "compose.tests.yaml",
];
const read = (name) =>
  execFileSync(
    "docker",
    [...compose, "exec", "-T", "ssh", "cat", `/fixtures/tls/${name}`],
    { encoding: "utf8" },
  );
const code =
  "if (!db.getSiblingDB('$external').getUser('O=DatahelmClient,CN=datahelm-client')) db.getSiblingDB('$external').createUser({user:'O=DatahelmClient,CN=datahelm-client',roles:[{role:'root',db:'admin'}]})";
execFileSync(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "tls-mongo",
    "mongosh",
    "--tls",
    "--tlsCAFile",
    "/tls/ca.crt",
    "--tlsCertificateKeyFile",
    "/tls/client.pem",
    "--quiet",
    "--eval",
    code,
  ],
  { stdio: "ignore" },
);
const config = {
  name: "TLS validation",
  mode: "form",
  hosts: "tls-mongo:27017",
  username: "O=DatahelmClient,CN=datahelm-client",
  mechanism: "MONGODB-X509",
  auth_database: "$external",
  monitoring: false,
  tls: {
    enabled: true,
    ca_pem: read("ca.crt"),
    client_pem: read("client.pem"),
  },
};
await api("/connections/test", { config });
console.log("Verified TLS, custom CA, and X.509 client authentication passed");
let mismatch = false;
try {
  await api("/connections/test", {
    config: { ...config, username: "CN=wrong-client" },
  });
} catch {
  mismatch = true;
}
if (!mismatch) throw new Error("Mismatched certificate identity was accepted");
console.log("Explicit X.509 identity validation passed");
let denied = false;
try {
  await api("/connections/test", {
    config: { ...config, tls: { ...config.tls, ca_pem: null } },
  });
} catch {
  denied = true;
}
if (!denied) throw new Error("An untrusted TLS certificate was accepted");
console.log("Untrusted TLS certificate rejection passed");
const count = execFileSync(
  "docker",
  [
    "exec",
    "datahelm-tls-validation",
    "sh",
    "-c",
    "find /run/datahelm -type f | wc -l",
  ],
  { encoding: "utf8" },
).trim();
if (count !== "0")
  throw new Error("Runtime TLS files leaked after connection tests");
console.log("Private TLS file cleanup passed");
