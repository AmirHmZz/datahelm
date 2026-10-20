import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { inheritedRoles, passwordError } from "./clickhouse-api";
import ConnectionEditor from "./ConnectionEditor";
afterEach(cleanup);
test("password limits use UTF-8 bytes and never truncate", () => {
  expect(passwordError("é".repeat(36))).toBe("");
  expect(passwordError("é".repeat(37))).toContain("72 UTF-8");
  expect(passwordError("a\0b")).not.toBe("");
});
test("inherited roles follow nested assignments with a cycle bound", () => {
  const row = (
    role_name: string | null,
    granted_role_name: string,
    user_name: string | null = null,
  ) => ({
    role_name,
    granted_role_name,
    user_name,
    granted_role_is_default: 0,
    with_admin_option: 0,
  });
  expect([
    ...inheritedRoles({ kind: "user", name: "alice" }, [
      row(null, "reader", "alice"),
      row("reader", "base"),
      row("base", "reader"),
      row(null, "other", "bob"),
    ]),
  ]).toEqual(["reader", "base"]);
});
test("ClickHouse connection fields replace MongoDB fields and send a typed config", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ id: "new" }), { status: 200 }),
    );
  const saved = vi.fn();
  render(<ConnectionEditor onClose={vi.fn()} onSaved={saved} />);
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Database engine" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("option", { name: "ClickHouse" }));
  expect(
    screen.queryByRole("combobox", { name: "Connection method" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Connection name"), {
    target: { value: "Warehouse" },
  });
  expect(screen.getByLabelText("HTTP(S) endpoint")).toHaveValue(
    "http://localhost:8123",
  );
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), {
    target: { value: "secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await vi.waitFor(() => expect(saved).toHaveBeenCalledWith("new"));
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(body.engine).toBe("clickhouse");
  expect(body.clickhouse.password).toBe("secret");
  fetcher.mockRestore();
});
