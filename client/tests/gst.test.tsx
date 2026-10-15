import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../server/src/db.js";
import { gstinCheckChar } from "../../server/src/lib/gst.js";
import { renderApp, resetDb, seedBusiness, seedUser, startServer, stopServer } from "./harness";

beforeAll(async () => { await startServer(); await resetDb(); });
afterAll(stopServer);

const gstin = (state: string, pan: string) => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f); };
const RJ = gstin("08", "AABCU9603R");
async function audit(label: string) {
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } }, resultTypes: ["violations"] });
  expect(r.violations, `${label}\n${r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes[0]?.html.slice(0, 120)}`).join("\n")}`).toEqual([]);
}

describe("business tax profile and presence settings", () => {
  it("saves legal name and GSTIN (state follows), and rejects an invalid GSTIN with a clear message", async () => {
    const b = await seedBusiness("Settings GST Co"); const user = userEvent.setup();
    renderApp("/app/settings", b.owner.s);
    const field = await screen.findByLabelText("GSTIN");
    await user.type(field, "27AAPFU0939F1ZX"); await user.type(screen.getByLabelText(/Legal name/), "Settings GST Pvt Ltd");
    await user.click(screen.getAllByRole("button", { name: /^Save/ })[0]);
    expect(await screen.findByText(/valid 15-character GSTIN/)).toBeInTheDocument();
    await user.clear(field); await user.type(field, RJ.toLowerCase());
    await user.click(screen.getAllByRole("button", { name: /^Save/ })[0]);
    await waitFor(async () => expect((await b.owner.s.req("GET", b.base)).business).toMatchObject({ gstin: RJ, stateCode: "08", legalName: "Settings GST Pvt Ltd" }));
  });

  it("lets an owner set opening hours and social links that appear on the public page", async () => {
    const b = await seedBusiness("Presence Co"); const user = userEvent.setup();
    renderApp("/app/settings", b.owner.s);
    await screen.findByText("Opening hours and social links");
    await user.click(screen.getAllByRole("checkbox", { name: "Closed" })[6]);                         // Sunday
    const monOpen = screen.getByLabelText("Monday opens"); await user.clear(monOpen); await user.type(monOpen, "10:00");
    await user.type(screen.getByLabelText("Instagram link"), "https://instagram.com/presence");
    const save = screen.getAllByRole("button", { name: "Save" }); await user.click(save[save.length - 1]);
    await waitFor(async () => {
      const biz = (await b.owner.s.req("GET", b.base)).business;
      expect(biz.businessHours.mon).toEqual({ open: "10:00", close: "18:00" }); expect(biz.businessHours.sun).toEqual({ closed: true });
      expect(biz.socialLinks).toEqual({ instagram: "https://instagram.com/presence" });
    });
  });
});

describe("GST invoice and credit note documents", () => {
  it("shows a Tax Invoice with GSTINs, CGST/SGST, HSN summary and amount in words, then the credit note after a return", async () => {
    const b = await seedBusiness("Registered Traders"); await b.owner.s.req("PATCH", b.base, { gstin: RJ, legalName: "Registered Traders Pvt Ltd", address: "5 Market Road, Udaipur" });
    const cust = (await b.owner.s.req("POST", `${b.base}/customers`, { name: "Local Buyer", gstin: gstin("08", "AAACL5555L") })).customer;
    const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: "Steel Pot", sellingPrice: 1000, taxRate: 18, hsnCode: "73239990", openingStock: 10 })).product;
    const o = (await b.owner.s.req("POST", `${b.base}/orders`, { customerId: cust.id, requireOtp: false, items: [{ productId: p.id, quantity: 3 }] })).order;
    for (const s of ["accepted", "processing", "ready", "delivered"]) await b.owner.s.req("PATCH", `${b.base}/orders/${o.id}/status`, { status: s });
    const item = (await b.owner.s.req("GET", `${b.base}/orders/${o.id}`)).order.items[0];
    await b.owner.s.req("POST", `${b.base}/orders/${o.id}/returns`, { reason: "Dented", items: [{ orderItemId: item.id, quantity: 1, condition: "damaged" }] });
    const inv = (await b.owner.s.req("GET", `${b.base}/invoices/by-order/${o.id}`)).invoice;

    renderApp(`/app/invoices/${inv.id}`, b.owner.s);
    const doc = await screen.findByRole("article", { name: /^Tax Invoice INV\// });
    for (const t of ["Registered Traders Pvt Ltd", `GSTIN: ${RJ}`.replace("GSTIN: ", ""), "Local Buyer", "Rupees Three Thousand Five Hundred Forty Only"]) expect(within(doc).getAllByText(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length).toBeGreaterThan(0);
    expect(within(doc).getAllByRole("columnheader", { name: "CGST" })).toHaveLength(2); expect(within(doc).getAllByRole("columnheader", { name: "SGST" })).toHaveLength(2);   // item table + HSN summary
    expect(within(doc).queryByRole("columnheader", { name: "IGST" })).toBeNull();
    expect(within(doc).getAllByText("73239990").length).toBeGreaterThan(1);                                           // item row and HSN summary
    expect(within(doc).getByText(/Place of supply:/)).toBeInTheDocument();
    const cn = await screen.findByRole("article", { name: /^Credit Note CN\// });
    expect(within(cn).getByText(/Against invoice INV\//)).toBeInTheDocument(); expect(within(cn).getByText(/Dented/)).toBeInTheDocument();
    expect(within(cn).getByText("Rupees One Thousand One Hundred Eighty Only")).toBeInTheDocument();
    await audit("gst invoice");
  });

  it("shows IGST for another state and the simple layout for an unregistered seller", async () => {
    const b = await seedBusiness("Interstate Seller"); await b.owner.s.req("PATCH", b.base, { gstin: RJ });
    const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: "Cloth", sellingPrice: 100, taxRate: 5, openingStock: 10 })).product;
    const o = (await b.owner.s.req("POST", `${b.base}/orders`, { placeOfSupply: "27", items: [{ productId: p.id, quantity: 2 }] })).order;
    await b.owner.s.req("PATCH", `${b.base}/orders/${o.id}/status`, { status: "accepted" });
    const inv = (await b.owner.s.req("GET", `${b.base}/invoices/by-order/${o.id}`)).invoice;
    const first = renderApp(`/app/invoices/${inv.id}`, b.owner.s);
    const doc = await screen.findByRole("article", { name: /^Tax Invoice/ });
    expect(within(doc).getAllByRole("columnheader", { name: "IGST" }).length).toBeGreaterThan(0); expect(within(doc).queryByRole("columnheader", { name: "CGST" })).toBeNull();
    expect(within(doc).getByText(/Maharashtra \(27\)/)).toBeInTheDocument(); first.unmount();

    const plain = await seedBusiness("Plain Seller");
    const p2 = (await plain.owner.s.req("POST", `${plain.base}/products`, { name: "Rope", sellingPrice: 50, taxRate: 12, openingStock: 4 })).product;
    const o2 = (await plain.owner.s.req("POST", `${plain.base}/orders`, { items: [{ productId: p2.id, quantity: 1 }] })).order;
    await plain.owner.s.req("PATCH", `${plain.base}/orders/${o2.id}/status`, { status: "accepted" });
    const inv2 = (await plain.owner.s.req("GET", `${plain.base}/invoices/by-order/${o2.id}`)).invoice;
    renderApp(`/app/invoices/${inv2.id}`, plain.owner.s);
    const d2 = await screen.findByRole("article", { name: /^Invoice INV\// });
    expect(within(d2).queryByText(/GSTIN/)).toBeNull(); expect(within(d2).queryByRole("columnheader", { name: /CGST|SGST|IGST/ })).toBeNull();
  });

  it("lets a shopper pick their state at checkout and shows the buyer a GST invoice", async () => {
    const b = await seedBusiness("Shop GST Co"); await b.owner.s.req("PATCH", b.base, { gstin: RJ });
    const p = (await b.owner.s.req("POST", `${b.base}/products`, { name: "Lamp", sellingPrice: 200, taxRate: 18, hsnCode: "9405", openingStock: 5 })).product;
    await pool.query("UPDATE products SET is_listed=true WHERE id=$1", [p.id]);
    const buyer = await seedUser("individual", "Out Of State");
    const order = (await buyer.s.req("POST", "/api/me/orders", { businessId: b.biz.id, items: [{ productId: p.id, quantity: 1 }], deliveryAddress: "12 Brigade Road, Bengaluru", phone: "+91 98450 22222", stateCode: "29" })).order;
    const so = (await b.owner.s.req("GET", `${b.base}/orders?source=marketplace`)).orders[0];
    await b.owner.s.req("PATCH", `${b.base}/orders/${so.id}/status`, { status: "accepted" });
    renderApp(`/app/my-orders/${order.id}/invoice`, buyer.s);
    const doc = await screen.findByRole("article", { name: /^Tax Invoice/ });
    expect(within(doc).getAllByRole("columnheader", { name: "IGST" }).length).toBeGreaterThan(0);
    expect(within(doc).getByText(/Karnataka \(29\)/)).toBeInTheDocument();
  });
});
