import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";

const fixture = vi.hoisted(() => ({ saved: false }));
vi.mock("./Views", () => ({
  Overview: () => null,
  Catalog: () => null,
  Operations: () => null,
  SlowQueries: () => null,
  Topology: () => null,
  Access: () => null,
}));
vi.mock("./ClickHouseViews", () => ({
  default: () => <p>ClickHouse dashboard</p>,
}));
vi.mock("./ConnectionEditor", () => ({
  default: ({ onSaved }: { onSaved: (id: string) => void }) => (
    <button
      onClick={() => {
        fixture.saved = true;
        onSaved("new");
      }}
    >
      Simulate saved connection
    </button>
  ),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("saving a second connection selects it after the connection list refresh", async () => {
  fixture.saved = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const old = {
    id: "old",
    config: {
      name: "Existing server",
      engine: "mongodb",
      hosts: "mongo:27017",
      monitoring: false,
    },
    status: "connected",
  };
  const added = {
    id: "new",
    config: {
      name: "New ClickHouse",
      engine: "clickhouse",
      hosts: "",
      monitoring: false,
      clickhouse: { endpoint: "http://warehouse:8123" },
    },
    status: "connected",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    let data: unknown = { features: {} };
    if (url.endsWith("/auth/session"))
      data = {
        username: "admin",
        csrf_token: "fixture",
        must_change_password: false,
      };
    if (url.endsWith("/connections")) {
      if (fixture.saved)
        await new Promise((resolve) => setTimeout(resolve, 50));
      data = fixture.saved ? [old, added] : [old];
    }
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Existing server" });
  fireEvent.click(
    screen.getAllByRole("button", { name: "Add connection" })[0],
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Simulate saved connection" }),
  );
  expect(
    await screen.findByRole("heading", { name: "New ClickHouse" }),
  ).toBeVisible();
  expect(await screen.findByText("ClickHouse dashboard")).toBeVisible();
  client.clear();
});
