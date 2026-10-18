import type { components } from "./api-types";
export type ConnectionConfig = Omit<
  components["schemas"]["ConnectionConfig"],
  "tls" | "ssh"
> & {
  tls: components["schemas"]["TlsConfig"];
  ssh: components["schemas"]["SshConfig"];
};
export type Connection = Omit<
  components["schemas"]["ConnectionView"],
  "config"
> & { config: ConnectionConfig };
export type Metric = components["schemas"]["Metric"];
export type Session = components["schemas"]["SessionView"];
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const requestCsrf = csrf;
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "X-CSRF-Token": requestCsrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({
    message:
      response.status === 422
        ? "Invalid input. Check required fields and numeric ranges."
        : "The server returned an invalid response",
  }));
  if (!response.ok) {
    if (
      response.status === 401 &&
      requestCsrf === csrf &&
      path !== "/auth/login" &&
      path !== "/auth/session"
    )
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(data.message || "Request failed");
  }
  return data;
}
export const connectionPath = (id: string, suffix: string) =>
  `/connections/${encodeURIComponent(id)}/${suffix}`;
