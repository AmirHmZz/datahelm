import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PasswordForm from "./PasswordForm";
import App from "./App";
import { api } from "./api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fillPasswords(confirmation = "new-password-456") {
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "current-password-123" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "new-password-456" },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: confirmation },
  });
}

test("password confirmation prevents submission of mismatched passwords", async () => {
  render(<PasswordForm onChanged={vi.fn()} />);
  fillPasswords("different-password-789");
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
  expect(api).not.toHaveBeenCalled();
});

test("password changes return the rotated session and clear password inputs", async () => {
  const session = {
    username: "admin",
    csrf_token: "rotated-csrf",
    must_change_password: false,
  };
  vi.mocked(api).mockResolvedValue(session);
  const changed = vi.fn();
  render(<PasswordForm onChanged={changed} />);
  fillPasswords();
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(session));
  expect(api).toHaveBeenCalledWith("/auth/password", "POST", {
    current_password: "current-password-123",
    new_password: "new-password-456",
  });
  expect(screen.getByLabelText("New password")).toHaveValue("");
  expect(screen.getByLabelText("Current password")).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
});

test("first-login sessions cannot render the dashboard or fetch connections", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.mocked(api).mockResolvedValue({
    username: "admin",
    csrf_token: "setup-csrf",
    must_change_password: true,
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={query}>
      <App />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("heading", { name: "Set your password" }),
  ).toBeVisible();
  expect(screen.getByLabelText("Temporary password")).toHaveAttribute(
    "type",
    "password",
  );
  expect(
    screen.queryByRole("button", { name: /MongoDB instances/ }),
  ).not.toBeInTheDocument();
  expect(
    vi.mocked(api).mock.calls.every(([path]) => path === "/auth/session"),
  ).toBe(true);
  query.clear();
  vi.unstubAllGlobals();
});
