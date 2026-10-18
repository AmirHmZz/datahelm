import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Only the disposable integration deployment uses this helper.
const base = process.env.DATAHELM_E2E_URL;
const file = process.env.DATAHELM_E2E_PASSWORD_FILE;
if (!base || !file)
  throw new Error("Configure the disposable test URL and password file");
const current = readFileSync(file, "utf8").trim();
const response = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: current }),
});
if (!response.ok) throw new Error("Fixture bootstrap login failed");
const session = await response.json();
if (session.must_change_password) {
  const password = randomBytes(24).toString("base64url");
  const changed = await fetch(`${base}/api/v1/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: response.headers.get("set-cookie").split(";")[0],
      "X-CSRF-Token": session.csrf_token,
      Origin: base,
    },
    body: JSON.stringify({ current_password: current, new_password: password }),
  });
  if (!changed.ok || (await changed.json()).must_change_password)
    throw new Error("Fixture first-login password change failed");
  writeFileSync(file, password, { mode: 0o600 });
}
console.log("Disposable administrator completed first-login password setup.");
