import { afterEach, expect, test, vi } from "vitest";
import { api, setCsrf } from "./api";
import {
  formatBytes,
  formatNumber,
  dateValue,
  dateTimestamp,
} from "./lib/utils";
afterEach(() => vi.restoreAllMocks());
test("a stale unauthorized response cannot discard a rotated session", async () => {
  let complete!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const events = vi.spyOn(window, "dispatchEvent");
  setCsrf("old-session-csrf");
  const pending = api("/connections").catch(() => undefined);
  setCsrf("new-session-csrf");
  complete(new Response('{"message":"Session expired"}', { status: 401 }));
  await pending;
  expect(events).not.toHaveBeenCalled();
});
test("mutations carry the CSRF token and credentials, GET requests do not carry the token", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  setCsrf("session-csrf");
  await api("/connections", "POST", { name: "private" });
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    credentials: "same-origin",
    headers: { "X-CSRF-Token": "session-csrf" },
    body: '{"name":"private"}',
  });
  await api("/connections");
  expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty("X-CSRF-Token");
});
test("failed requests preserve the server error message", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response('{"message":"Permission denied"}', { status: 403 }),
  );
  await expect(api("/connections")).rejects.toThrow("Permission denied");
});
test("missing telemetry stays visibly unavailable", () => {
  expect(formatBytes(null)).toBe("—");
  expect(formatNumber(undefined)).toBe("—");
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1048576)).toBe("1 MB");
});
test("canonical BSON dates preserve their numeric timestamp", () => {
  expect(dateTimestamp({ $date: { $numberLong: "1791970000000" } })).toBe(
    1791970000000,
  );
  expect(dateValue({ $date: { $numberLong: "1791970000000" } })).not.toBe("—");
  expect(formatNumber(NaN)).toBe("—");
});
test("an initial signed-out session does not emit an expiry event", async () => {
  const listener = vi.fn();
  window.addEventListener("session-expired", listener);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response('{"message":"Sign in"}', { status: 401 }),
  );
  await expect(api("/auth/session")).rejects.toThrow("Sign in");
  expect(listener).not.toHaveBeenCalled();
  window.removeEventListener("session-expired", listener);
});
