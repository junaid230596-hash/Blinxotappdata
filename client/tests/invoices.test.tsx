import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../server/src/db.js";
import { renderApp, resetDb, seedBusiness, seedUser, startServer, stopServer } from "./harness";

beforeAll(async () => { await startServer(); await resetDb(); });
afterAll(stopServer);

async function audit(label: string) {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  expect(r.violations, `${label}\n${r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.html.slice(0, 120)}`).join("\n")}`).toEqual([]);
}
const accept = (b: any, id: string, s = "accepted") => b.owner.s.req("PATCH", `${b.base}/orders/${id}/status`, { status: s });

describe("automatic numbers in the UI", () => {
  it("creates a product without typing a SKU and shows the assigned number", async () => {
    const b = await seedBusiness("Numbering Co"); const user = userEvent.setup();
    renderApp("/app/products/new", b.owner.s);
    const sku = await screen.findByLabelText("SKU");
    expect(sku).not.toBeRequired(); expect(sku).toHaveAttribute("placeholder", "Auto-generated");
    await user.type(screen.getByLabelText("Name"), "Brass Tap");
    await user.click(screen.getByRole("button", { name: "Create product" }));
    expect(await screen.findByDisplayValue("SKU-000001")).toBeInTheDocument();             // the saved product opens with its generated SKU
  });

  it("shows customer numbers in the customer list", async () => {
    const b = await seedBusiness("Customer Numbers"); await b.owner.s.req("POST", `${b.base}/customers`, { name: "Asha Rao" });
    renderApp("/app/customers", b.owner.s);
    expect(await screen.findByText("CUS-000001")).toBeInTheDocument();
  });
});

describe("invoices", () => {
  async function sold(name: string) {
    const b = await seedBusiness(name);
    const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: "Copper Pan", sellingPrice: 400, taxRate: 18, openingStock: 9 })).product;
    const o = (await b.owner.s.req("POST", `${b.base}/orders`, { items: [{ productId: p.id, quantity: 2 }] })).order;
    return { b, p, o };
  }

  it("lists, opens and offers printing for an invoice issued on acceptance; marks it void on cancellation", async () => {
    const { b, o } = await sold("Invoice Works"); const user = userEvent.setup();
    const none = renderApp("/app/invoices", b.owner.s);
    expect(await screen.findByText("No invoices yet")).toBeInTheDocument(); none.unmount();

    await accept(b, o.id);
    const a = renderApp("/app/invoices", b.owner.s);
    await user.click(await screen.findByRole("link", { name: /^INV\/\d\d-\d\d\/000001$/ }));
    const doc = await screen.findByRole("article", { name: /^Invoice INV\/\d\d-\d\d\/000001$/ });
    expect(within(doc).getByText("Invoice Works")).toBeInTheDocument();
    expect(within(doc).getByText("Copper Pan")).toBeInTheDocument();
    expect(within(doc).getAllByText(/₹944\.00/).length).toBeGreaterThan(0);                  // 2 × 400 + 18% tax
    expect(screen.getByRole("button", { name: "Print / Save as PDF" })).toBeInTheDocument();
    expect(within(doc).queryByText(/VOID/)).toBeNull();
    await audit("invoice"); a.unmount();

    await accept(b, o.id, "cancelled");
    renderApp(`/app/orders/${o.id}`, b.owner.s);
    await user.click(await screen.findByRole("link", { name: /Invoice INV\/\d\d-\d\d\/000001/ }));
    expect(await screen.findByText(/VOID/)).toBeInTheDocument();
  });

  it("order screen links to the invoice, and individual buyers see their own copy", async () => {
    const { b, p } = await sold("Buyer Invoice Co"); await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    const buyer = await seedUser("individual", "Divya Nair");
    const order = (await buyer.s.req("POST", "/api/me/orders", { businessId: b.biz.id, items: [{ productId: p.id, quantity: 1 }], deliveryAddress: "7 Hill View, Udaipur", phone: "+91 98290 55555" })).order;
    const first = renderApp(`/app/my-orders/${order.id}`, buyer.s);
    await screen.findByRole("heading", { level: 1, name: /ORD-/ });
    expect(screen.queryByRole("link", { name: /^Invoice INV\// })).toBeNull(); first.unmount();       // none until accepted
    const sellerOrder = (await b.owner.s.req("GET", `${b.base}/orders`)).orders.find((x: any) => x.buyerType === "individual");
    await accept(b, sellerOrder.id);
    const user = userEvent.setup(); renderApp(`/app/my-orders/${order.id}`, buyer.s);
    await user.click(await screen.findByRole("link", { name: /Invoice INV\// }));
    const doc = await screen.findByRole("article", { name: /Invoice INV\// });
    expect(within(doc).getByText("Divya Nair")).toBeInTheDocument();
    expect(within(doc).getByText("Buyer Invoice Co")).toBeInTheDocument();
    expect(within(doc).queryByText(/@example\.com/)).toBeNull();
  });
});
