import { expect, test, vi } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ConnectionEditor from "./ConnectionEditor";
test("URI mode offers a protected credential input and hidden SSH secrets", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(<ConnectionEditor onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Connection method" }),
    { key: "ArrowDown" },
  );
  fireEvent.click(
    await screen.findByRole("option", { name: "Connection URI" }),
  );
  expect(screen.getByLabelText(/MongoDB URI/)).toHaveAttribute(
    "autocomplete",
    "off",
  );
  fireEvent.click(screen.getByRole("button", { name: "SSH tunnel" }));
  expect(screen.getByLabelText("SSH password")).toHaveAttribute(
    "type",
    "password",
  );
  expect(screen.getByLabelText("Key passphrase")).toHaveAttribute(
    "type",
    "password",
  );
  cleanup();
});
