import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, DataTable, Modal, Pagination, TextField } from "../src/components/ui";

describe("DataTable", () => {
  it("labels every cell so the stylesheet can turn rows into cards on phones", () => {
    render(<DataTable rows={[{ id: 1, name: "Rice", qty: 5 }]} cols={[{ key: "name", label: "Product" }, { key: "qty", label: "In stock", num: true }]} actions={() => <button>Edit</button>} />);
    expect(screen.getByRole("columnheader", { name: "Product" })).toBeInTheDocument();
    const cells = screen.getAllByRole("cell");
    expect(cells[0]).toHaveAttribute("data-label", "Product"); expect(cells[1]).toHaveAttribute("data-label", "In stock");
    expect(screen.getByRole("table")).toHaveClass("rt");
  });
  it("shows the empty state instead of an empty table", () => {
    render(<DataTable rows={[]} cols={[{ key: "a", label: "A" }]} empty={<p>Nothing to see</p>} />);
    expect(screen.getByText("Nothing to see")).toBeInTheDocument(); expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("Modal", () => {
  function Host() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Open</button><Modal open={open} title="Edit thing" onClose={() => setOpen(false)}><TextField label="Name" /><button>Save</button></Modal></>; }
  it("is an accessible dialog: focuses inside, traps Tab, closes on Escape and restores focus", async () => {
    const user = userEvent.setup(); render(<Host />);
    const opener = screen.getByRole("button", { name: "Open" }); await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Edit thing" }); expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await user.tab(); await user.tab(); await user.tab(); await user.tab();                          // cycles: Name → Save → Close → Name …
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}"); expect(screen.queryByRole("dialog")).toBeNull(); expect(opener).toHaveFocus();
  });
  it("closes when the backdrop is clicked but not when the dialog itself is", async () => {
    const user = userEvent.setup(); render(<Host />); await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("dialog")); expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(document.querySelector(".overlay")!); expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConfirmDialog and Pagination", () => {
  it("only confirms on the explicit action", async () => {
    const user = userEvent.setup(); const ok = vi.fn(); const close = vi.fn();
    render(<ConfirmDialog open danger title="Delete?" message="Gone forever" confirmLabel="Delete it" onConfirm={ok} onClose={close} />);
    await user.click(screen.getByRole("button", { name: "Cancel" })); expect(close).toHaveBeenCalled(); expect(ok).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete it" })); expect(ok).toHaveBeenCalled();
  });
  it("pages through results and disables the ends", async () => {
    const user = userEvent.setup(); const change = vi.fn();
    const { rerender } = render(<Pagination total={60} limit={25} offset={0} onChange={change} />);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" })); expect(change).toHaveBeenCalledWith(25);
    rerender(<Pagination total={60} limit={25} offset={50} onChange={change} />); expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    rerender(<Pagination total={10} limit={25} offset={0} onChange={change} />); expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });
});

describe("TextField", () => {
  it("links label, hint and error for screen readers", () => {
    render(<MemoryRouter><TextField label="Email" error="Enter a valid email" /></MemoryRouter>);
    const input = screen.getByLabelText("Email"); expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a valid email"); expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email");
  });
});
