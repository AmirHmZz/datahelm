import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
if (!login.ok) throw new Error("Administration login failed");
const { csrf_token } = await login.json();
const cookie = login.headers.get("set-cookie").split(";")[0];
async function api(path, method = "GET", body) {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": csrf_token,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(`${path}: ${v.message}`);
  return v;
}
for (const [version, port] of [
  [8, 28018],
  [9, 28019],
]) {
  const db = `release_${randomUUID().replaceAll("-", "")}`;
  const role = "auditor";
  const user = "reader";
  const internal = process.env.DATAHELM_TEST_INTERNAL_NETWORK === "1";
  const host = internal
    ? `mongo${version}`
    : process.env.DATAHELM_TEST_DATABASE_HOST || "host.docker.internal";
  const shell = (code) =>
    execFileSync(
      "docker",
      [
        "exec",
        `datahelm-test-mongo${version}`,
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
      { encoding: "utf8" },
    );
  shell(
    `const d=db.getSiblingDB('${db}');d.events.insertMany([{n:1},{n:2},{n:3}]);d.createView('event_view','events',[]);d.createCollection('measurements',{timeseries:{timeField:'ts'}});d.measurements.insertMany([{ts:new Date(),n:1},{ts:new Date(),n:2}]);`,
  );
  const config = {
    name: `MongoDB ${version} release validation`,
    mode: "uri",
    uri: `mongodb://admin:datahelm-test-only@${host}:${internal ? 27017 : port}/?authSource=admin&directConnection=true`,
    monitoring: false,
  };
  await api("/connections/test", "POST", { config });
  const id = (await api("/connections", "POST", config)).id;
  const path = (suffix) => `/connections/${id}/${suffix}`;
  const capabilities = await api(path("capabilities"));
  if (!capabilities.server_version?.startsWith(`${version}.`))
    throw new Error("MongoDB version was not reported correctly");
  const databaseNames = await api(path("database-names"));
  const collectionNames = await api(path(`collection-names?db=${db}`));
  if (
    !databaseNames.includes(db) ||
    !collectionNames.includes("events") ||
    !collectionNames.includes("event_view")
  )
    throw new Error("Privilege picker metadata is missing");
  const catalog = await api(path(`collections?db=${db}`));
  if (catalog.find((c) => c.name === "events")?.count !== 3)
    throw new Error("Document count mismatch");
  if (catalog.find((c) => c.name === "event_view")?.count !== null)
    throw new Error("View statistics were fabricated");
  const series = catalog.find((c) => c.name === "measurements");
  if (series?.count !== null || series?.bucket_count !== 1)
    throw new Error("Time-series bucket metadata was reported as measurements");
  await api(path("roles"), "POST", {
    db,
    role,
    roles: [],
    privileges: [{ resource: { db, collection: "events" }, actions: ["find"] }],
  });
  await api(path("users"), "POST", {
    db,
    user,
    password: "fixture-user-password",
    roles: [{ role, db }],
    mechanisms: ["SCRAM-SHA-256"],
  });
  const access = await api(path(`users?db=${db}&name=${user}`));
  if (
    !access.users[0].inheritedPrivileges.some(
      (p) => p.resource.collection === "events",
    )
  )
    throw new Error("Effective privilege missing");
  if (access.users[0].credentials) throw new Error("Credentials leaked");
  await api(path("users"), "PATCH", {
    db,
    user,
    password: "updated-fixture-password",
    roles: [{ role: "read", db }],
  });
  await api(path("roles"), "PATCH", {
    db,
    role,
    roles: [{ role: "read", db }],
    privileges: [],
  });
  await api(path("profiler"), "PUT", { db, enabled: true, slow_ms: 0 });
  await api(path(`profiles?db=${db}`));
  await api(path("profiler"), "PUT", { db, enabled: false });
  await api(path("users"), "DELETE", { db, name: user });
  await api(path("roles"), "DELETE", { db, name: role });
  await api(`/connections/${id}`, "DELETE");
  shell(`db.getSiblingDB('${db}').dropDatabase()`);
  console.log(
    `MongoDB ${version}: catalog, views, time series, user/role CRUD, privileges, and profiling passed`,
  );
}
const bad = {
  name: "Rejected credential input",
  hosts: "user:private-password@localhost:27017",
};
let rejected = false;
try {
  await api("/connections", "POST", bad);
} catch (e) {
  if (e.message.includes("private-password"))
    throw new Error("Input password appeared in error output");
  rejected = true;
}
if (!rejected) throw new Error("Embedded host credentials accepted");
console.log("Host-form credential safety passed");
