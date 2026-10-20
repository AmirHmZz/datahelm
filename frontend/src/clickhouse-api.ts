import { useQuery } from "@tanstack/react-query";
import type { components } from "./api-types";
import { api, connectionPath } from "./api";
export type CH<K extends keyof components["schemas"]> =
  components["schemas"][K];
export const chPath = (id: string, path: string) =>
  connectionPath(id, `clickhouse/${path}`);
export const chApi = <T>(
  id: string,
  path: string,
  method = "GET",
  body?: unknown,
) => api<T>(chPath(id, path), method, body);

// All reachable role privileges are labelled inherited; default-role activation can
// still narrow a particular session. Partial revokes remain visible, not flattened.
export function inheritedRoles(
  target: CH<"Target">,
  assignments: CH<"RoleGrantRow">[],
) {
  const result = new Set<string>();
  let pending = assignments
    .filter((r) =>
      target.kind === "user"
        ? r.user_name === target.name
        : r.role_name === target.name,
    )
    .map((r) => r.granted_role_name);
  while (pending.length) {
    const name = pending.pop()!;
    if (result.has(name)) continue;
    result.add(name);
    pending = pending.concat(
      assignments
        .filter((r) => r.role_name === name)
        .map((r) => r.granted_role_name),
    );
  }
  return result;
}
export function passwordError(password: string) {
  return !password ||
    new TextEncoder().encode(password).length > 72 ||
    password.includes("\0")
    ? "Use 1–72 UTF-8 bytes without NUL; passwords are never truncated."
    : "";
}

export function useCH<T>(
  id: string,
  path: string,
  interval?: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ["clickhouse", id, path],
    queryFn: () => chApi<T>(id, path),
    enabled,
    retry: false,
    refetchInterval: interval,
  });
}
